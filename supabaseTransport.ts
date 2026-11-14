/**
 * SyncTransport backed by Supabase (PostgREST). Only the structural surface of supabase-js that we use is
 * described here, so this file has no import of the package and can be unit-tested with a fake client.
 * Authorization is enforced by Row Level Security on the server – nothing here is trusted for access control.
 */
import type { SyncTable } from '../types';
import type { Row } from './persistence';
import { SyncError, type PullCursor, type RemoteRow, type SyncTransport } from './sync';

interface PgError {
  message: string;
  code?: string;
  status?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SupabaseLike {
  from(table: string): any;
}

export function classifyError(err: PgError | null | undefined, status?: number): SyncError {
  const message = err?.message || 'Unknown sync error';
  const code = err?.code;
  const http = status ?? err?.status;
  // Constraint violations, RLS denials, malformed rows → the server will never accept this row.
  if (code && /^(23|22|42501|42P01|42703|PGRST1|PGRST2)/.test(code)) return new SyncError(message, false, code);
  if (http && http >= 400 && http < 500 && http !== 408 && http !== 429 && http !== 401 && http !== 403) {
    return new SyncError(message, false, code);
  }
  return new SyncError(message, true, code);
}

const idColumn = (t: SyncTable) => (t === 'user_settings' ? 'user_id' : 'id');

export class SupabaseTransport implements SyncTransport {
  constructor(
    private client: SupabaseLike,
    private userId: string,
  ) {}

  async pull(table: SyncTable, cursor: PullCursor | null, limit: number): Promise<RemoteRow[]> {
    const idCol = idColumn(table);
    // RLS also lets us READ other users' public decks; sync must only ever mirror our own rows.
    let q = this.client.from(table).select('*').eq('user_id', this.userId).order('synced_at', { ascending: true }).order(idCol, { ascending: true }).limit(limit);
    if (cursor) q = q.or(`synced_at.gt.${cursor.at},and(synced_at.eq.${cursor.at},${idCol}.gt.${cursor.id})`);
    const { data, error, status } = await q.then((r: any) => r, (e: unknown) => ({ data: null, error: { message: String((e as Error)?.message ?? e) }, status: 0 }));
    if (error) throw classifyError(error, status);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ ...r, id: String(r[idCol]) }) as RemoteRow);
  }

  async push(table: SyncTable, rows: Row[]): Promise<void> {
    const onConflict = idColumn(table);
    const { error, status } = await this.client
      .from(table)
      .upsert(rows, { onConflict })
      .then((r: any) => r, (e: unknown) => ({ error: { message: String((e as Error)?.message ?? e) }, status: 0 }));
    if (error) throw classifyError(error, status);
  }

  async touchDevice(deviceId: string, info: { pulled?: boolean; pushed?: boolean }): Promise<void> {
    const now = new Date().toISOString();
    const row: Record<string, unknown> = { user_id: this.userId, device_id: deviceId };
    if (info.pulled) row.last_pull_at = now;
    if (info.pushed) row.last_push_at = now;
    await this.client.from('sync_metadata').upsert(row, { onConflict: 'user_id,device_id' });
  }
}
