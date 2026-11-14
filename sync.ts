/**
 * Cloud synchronisation engine (transport-agnostic).
 *
 *   pull  – fetch rows changed since the per-table cursor (server-assigned `synced_at`, keyset-paged) and merge.
 *   push  – send every remaining outbox row to the server (parents before children).
 * Pull runs FIRST so that conflicts are detected and resolved locally (and recorded) before anything is uploaded;
 * the server additionally refuses to regress a card's review history (see 0001_schema.sql).
 *
 * Merge rules (see mergeRow):
 *   • review_logs are append-only; the only mutable bit is `undone`, which can only turn true.
 *   • cards never lose review history: whichever side has the newer `last_review` keeps its scheduling data.
 *   • everything else is last-writer-wins on `updated_at`.
 * When both sides changed the same record while one was offline, a SyncConflict is recorded (with both versions)
 * and the user can later override the automatic choice.
 */
import type { OutboxEntry, SyncConflict, SyncTable } from '../types';
import { SYNC_TABLES } from '../types';
import type { Collection } from './collection';
import type { Persistence, Row } from './persistence';
import { DEFAULT_SETTINGS } from '../lib/defaults';
import { uuid } from '../lib/ids';

// ------------------------------------------------------------------------------------------ transport
export class SyncError extends Error {
  constructor(
    message: string,
    /** true → network / server hiccup, try again later. false → the server rejected the data. */
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface RemoteRow extends Row {
  synced_at: string;
}

export interface SyncTransport {
  /** Rows with (synced_at, id) strictly after `cursor`, ordered by (synced_at, id), at most `limit`. */
  pull(table: SyncTable, cursor: PullCursor | null, limit: number): Promise<RemoteRow[]>;
  /** Upsert rows (RLS pins them to the signed-in user). Throws SyncError. */
  push(table: SyncTable, rows: Row[]): Promise<void>;
  /** Best-effort bookkeeping row in sync_metadata. */
  touchDevice?(deviceId: string, info: { pulled?: boolean; pushed?: boolean }): Promise<void>;
}

export interface PullCursor {
  at: string;
  id: string;
}

// ------------------------------------------------------------------------------------------ row mapping
const TIME_FIELDS = ['created_at', 'updated_at', 'deleted_at', 'due', 'last_review', 'reviewed_at'];

const normTime = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString();
};

/** Server row → local row. */
export function fromRemote(table: SyncTable, r: Record<string, unknown>, userId: string): Row {
  const out: Record<string, unknown> = { ...r };
  delete out.synced_at;
  for (const f of TIME_FIELDS) if (f in out) out[f] = normTime(out[f]);
  if (table === 'user_settings') {
    const s = (out.settings ?? {}) as Record<string, unknown>;
    out.id = userId;
    out.user_id = userId;
    out.settings = {
      ...DEFAULT_SETTINGS,
      ...s,
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...((s.shortcuts as object) ?? {}) },
    };
  }
  return out as Row;
}

/** Local row → server row. */
export function toRemote(table: SyncTable, row: Row): Row {
  const out: Record<string, unknown> = { ...row };
  delete out.synced_at;
  if (table === 'user_settings') delete out.id;
  return out as Row;
}

// ------------------------------------------------------------------------------------------ merge rules
const ts = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) || 0 : 0);

export type MergeAction =
  | { action: 'apply'; row: Row; conflict: boolean }
  | { action: 'keep'; conflict: boolean; requeue: boolean };

/**
 * Decide what to do with `remote` given the `local` copy and whether local has unsent edits (`dirty`).
 * Pure function – unit tested.
 */
export function mergeRow(table: SyncTable, local: Row | undefined, remote: Row, dirty: boolean): MergeAction {
  if (!local) return { action: 'apply', row: remote, conflict: false };

  if (table === 'review_logs') {
    const localUndone = local.undone === true;
    const remoteUndone = remote.undone === true;
    if (localUndone && !remoteUndone) return { action: 'keep', conflict: false, requeue: true };
    return { action: 'apply', row: remote, conflict: false };
  }

  if (table === 'cards') {
    const lrL = ts(local.last_review);
    const lrR = ts(remote.last_review);
    const repsL = Number(local.reps ?? 0);
    const repsR = Number(remote.reps ?? 0);
    // Review history wins over any other kind of edit.
    if (lrL > lrR || (lrL === lrR && repsL > repsR)) {
      return { action: 'keep', conflict: dirty, requeue: true };
    }
    if (dirty && (lrR > lrL || repsR > repsL)) return { action: 'apply', row: remote, conflict: true };
  }

  const uL = ts(local.updated_at);
  const uR = ts(remote.updated_at);
  if (dirty) {
    if (uR > uL) return { action: 'apply', row: remote, conflict: true };
    return { action: 'keep', conflict: uR !== uL, requeue: true };
  }
  if (uR >= uL) return { action: 'apply', row: remote, conflict: false };
  return { action: 'keep', conflict: false, requeue: true };
}

// ------------------------------------------------------------------------------------------ engine
export type SyncState = 'disabled' | 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  online: boolean;
  pending: number;
  conflicts: number;
  lastSyncAt: string | null;
  error: string | null;
  retryInMs: number | null;
}

export interface IntegrityReport {
  ok: boolean;
  orphanCards: number;
  orphanNotes: number;
  orphanLogs: number;
  missingDecks: number;
  issues: string[];
}

const PAGE = 500;
const PUSH_BATCH = 200;
const BACKOFF_BASE = 2000;
const BACKOFF_MAX = 5 * 60_000;

export class SyncEngine {
  private status: SyncStatus = {
    state: 'disabled',
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    pending: 0,
    conflicts: 0,
    lastSyncAt: null,
    error: null,
    retryInMs: null,
  };
  private listeners = new Set<() => void>();
  private running: Promise<SyncStatus> | null = null;
  private again = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private unsubCollection: (() => void) | null = null;
  private started = false;
  readonly deviceId: string;

  constructor(
    private col: Collection,
    private store: Persistence,
    private transport: SyncTransport | null,
    deviceId: string,
    private opts: { autoSync?: () => boolean; debounceMs?: number; intervalMs?: number } = {},
  ) {
    this.deviceId = deviceId;
    if (transport) this.status.state = 'idle';
  }

  // ---- external-store API for React
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): SyncStatus => this.status;

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of [...this.listeners]) l();
  }

  get enabled(): boolean {
    return this.transport !== null;
  }

  // ---- lifecycle
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const last = await this.store.getMeta<string>('sync:lastSyncAt');
    this.set({ lastSyncAt: last ?? null });
    await this.refreshCounts();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
    if (!this.transport) return;
    this.unsubCollection = this.col.subscribe(() => this.scheduleDebounced());
    this.interval = setInterval(() => {
      if (this.autoOn() && this.status.online) void this.syncNow();
    }, this.opts.intervalMs ?? 60_000);
    if (this.autoOn() && this.status.online) void this.syncNow();
  }

  stop(): void {
    this.started = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
    this.unsubCollection?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.interval) clearInterval(this.interval);
    this.timer = this.debounce = this.interval = null;
  }

  private autoOn = () => (this.opts.autoSync ? this.opts.autoSync() : true);

  private onOnline = () => {
    this.set({ online: true, state: this.transport ? 'idle' : 'disabled' });
    this.failures = 0;
    if (this.transport && this.autoOn()) void this.syncNow();
  };
  private onOffline = () => this.set({ online: false, state: this.transport ? 'offline' : 'disabled' });

  private scheduleDebounced() {
    void this.refreshCounts();
    if (!this.autoOn() || !this.status.online || this.running) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow(), this.opts.debounceMs ?? 4000);
  }

  private async refreshCounts() {
    const [outbox, conflicts] = await Promise.all([this.store.outboxAll(), this.store.conflictsAll()]);
    this.set({ pending: outbox.length, conflicts: conflicts.filter((c) => !c.resolved).length });
  }

  // ---- public API
  /** Run a full push + pull cycle. Concurrent calls share one run; a call during a run schedules one follow-up. */
  syncNow(): Promise<SyncStatus> {
    if (!this.transport) return Promise.resolve(this.status);
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.cycle().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  private async cycle(): Promise<SyncStatus> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.set({ online: false, state: 'offline', retryInMs: null });
      return this.status;
    }
    this.set({ state: 'syncing', error: null, retryInMs: null, online: true });
    try {
      await this.pull();
      await this.push();
      const at = new Date().toISOString();
      await this.store.setMeta('sync:lastSyncAt', at);
      await this.transport!.touchDevice?.(this.deviceId, { pulled: true, pushed: true }).catch(() => undefined);
      this.failures = 0;
      await this.refreshCounts();
      this.set({ state: 'idle', lastSyncAt: at, error: null });
    } catch (e) {
      await this.refreshCounts();
      const err = e instanceof SyncError ? e : new SyncError(e instanceof Error ? e.message : String(e), true);
      this.failures++;
      const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** Math.min(this.failures - 1, 8));
      if (err.retryable) {
        this.set({ state: this.status.online ? 'error' : 'offline', error: err.message, retryInMs: delay });
        if (this.started && this.autoOn()) {
          this.timer = setTimeout(() => void this.syncNow(), delay);
        }
      } else {
        this.set({ state: 'error', error: err.message, retryInMs: null });
      }
    }
    return this.status;
  }

  // ---- push
  private async push(): Promise<void> {
    const all = await this.store.outboxAll();
    if (all.length === 0) return;
    const byTable = new Map<SyncTable, OutboxEntry[]>();
    for (const e of all) {
      const l = byTable.get(e.table) ?? [];
      l.push(e);
      byTable.set(e.table, l);
    }
    for (const table of SYNC_TABLES) {
      const entries = byTable.get(table);
      if (!entries) continue;
      for (let i = 0; i < entries.length; i += PUSH_BATCH) {
        await this.pushBatch(table, entries.slice(i, i + PUSH_BATCH));
      }
    }
  }

  private async pushBatch(table: SyncTable, entries: OutboxEntry[]) {
    const snapshots: { entry: OutboxEntry; row: Row }[] = [];
    const orphanKeys: string[] = [];
    for (const e of entries) {
      const row = this.col.getRow(table, e.record_id);
      if (!row) orphanKeys.push(e.key);
      else snapshots.push({ entry: e, row: structuredClone(row) });
    }
    if (orphanKeys.length) await this.store.outboxDelete(orphanKeys);
    if (snapshots.length === 0) return;

    try {
      await this.transport!.push(table, snapshots.map((s) => toRemote(table, s.row)));
      await this.clearIfUnchanged(table, snapshots);
    } catch (e) {
      if (e instanceof SyncError && !e.retryable && snapshots.length > 1) {
        // One bad row must not block the rest: retry one by one and quarantine the offenders.
        for (const s of snapshots) await this.pushOne(table, s);
        return;
      }
      if (e instanceof SyncError && !e.retryable) {
        await this.pushOne(table, snapshots[0], e);
        return;
      }
      throw e;
    }
  }

  private async pushOne(table: SyncTable, s: { entry: OutboxEntry; row: Row }, known?: SyncError) {
    try {
      if (!known) await this.transport!.push(table, [toRemote(table, s.row)]);
      else throw known;
      await this.clearIfUnchanged(table, [s]);
    } catch (e) {
      if (!(e instanceof SyncError) || e.retryable) throw e;
      await this.quarantine(table, s, e);
    }
  }

  /** Drop outbox entries whose row has not been edited again while the request was in flight. */
  private async clearIfUnchanged(table: SyncTable, sent: { entry: OutboxEntry; row: Row }[]) {
    const del: string[] = [];
    for (const s of sent) {
      const cur = this.col.getRow(table, s.row.id);
      if (!cur || cur.updated_at === s.row.updated_at) del.push(s.entry.key);
    }
    if (del.length) await this.store.outboxDelete(del);
  }

  /** The server permanently rejected this row (constraint violation, RLS). Record it so it never blocks sync. */
  private async quarantine(table: SyncTable, s: { entry: OutboxEntry; row: Row }, err: SyncError) {
    const c: SyncConflict = {
      id: uuid(),
      table,
      record_id: s.row.id,
      local: s.row,
      remote: { error: err.message, code: err.code ?? null },
      auto_kept: 'remote',
      detected_at: new Date().toISOString(),
      resolved: false,
    };
    await this.store.conflictPut(c);
    await this.store.outboxDelete([s.entry.key]);
    if (table === 'cards' && err.code === '23505') {
      // Same (note, ord) card created on two devices: keep the server's card, hide the local duplicate.
      const dup = { ...(s.row as Record<string, unknown>), deleted_at: new Date().toISOString() } as unknown as Row;
      await this.col.applyRemote('cards', [dup]);
    }
  }

  // ---- pull
  private async pull(): Promise<void> {
    for (const table of SYNC_TABLES) {
      let cursor = (await this.store.getMeta<PullCursor>(`cursor:${table}`)) ?? null;
      for (;;) {
        const rows = await this.transport!.pull(table, cursor, PAGE);
        if (rows.length === 0) break;
        await this.mergePage(table, rows);
        const last = rows[rows.length - 1];
        cursor = { at: last.synced_at, id: last.id };
        await this.store.setMeta(`cursor:${table}`, cursor);
        if (rows.length < PAGE) break;
      }
    }
  }

  private async mergePage(table: SyncTable, rows: RemoteRow[]) {
    const outbox = new Map((await this.store.outboxAll()).map((e) => [e.key, e]));
    const apply: Row[] = [];
    const clearKeys: string[] = [];
    const requeue: OutboxEntry[] = [];
    const conflicts: SyncConflict[] = [];

    for (const raw of rows) {
      const remote = fromRemote(table, raw, this.col.userId);
      const local = this.col.getRow(table, remote.id);
      const key = `${table}:${remote.id}`;
      const dirty = outbox.has(key);
      const m = mergeRow(table, local, remote, dirty);
      if (m.action === 'apply') {
        if (m.conflict && local) {
          conflicts.push({
            id: uuid(), table, record_id: remote.id, local: structuredClone(local), remote,
            auto_kept: 'remote', detected_at: new Date().toISOString(), resolved: false,
          });
        }
        apply.push(m.row);
        if (dirty) clearKeys.push(key);
      } else {
        if (m.conflict && local) {
          conflicts.push({
            id: uuid(), table, record_id: remote.id, local: structuredClone(local), remote,
            auto_kept: 'local', detected_at: new Date().toISOString(), resolved: false,
          });
        }
        if (m.requeue && !dirty) {
          requeue.push({ key, table, record_id: remote.id, queued_at: new Date().toISOString() });
        }
      }
    }
    if (clearKeys.length) await this.store.outboxDelete(clearKeys);
    if (requeue.length) await this.store.outboxPut(requeue);
    for (const c of conflicts) await this.store.conflictPut(c);
    if (apply.length) await this.col.applyRemote(table, apply);
  }

  // ---- conflicts
  async conflicts(): Promise<SyncConflict[]> {
    return (await this.store.conflictsAll()).filter((c) => !c.resolved).sort((a, b) => b.detected_at.localeCompare(a.detected_at));
  }

  /** Override the automatic decision. `keep` is the version the user wants to end up with. */
  async resolveConflict(id: string, keep: 'local' | 'remote'): Promise<void> {
    const c = (await this.store.conflictsAll()).find((x) => x.id === id);
    if (!c) return;
    if (keep !== c.auto_kept) {
      const row = (keep === 'local' ? c.local : c.remote) as Row;
      if (keep === 'remote' && (c.remote as Record<string, unknown>).error === undefined) {
        await this.col.applyRemote(c.table, [row]);
        await this.store.outboxDelete([`${c.table}:${c.record_id}`]);
      } else if (keep === 'local') {
        // Re-save with a fresh updated_at so it beats the server copy, and queue it.
        const fresh = { ...(row as Record<string, unknown>) } as Row;
        this.col.save(c.table, fresh as never, true, true);
        await this.col.commit();
      }
    }
    await this.store.conflictPut({ ...c, resolved: true });
    await this.refreshCounts();
  }

  // ---- integrity
  /** Local referential-integrity check: run after a sync to detect partial / corrupted data. */
  integrity(): IntegrityReport {
    const col = this.col;
    let orphanCards = 0, orphanNotes = 0, orphanLogs = 0, missingDecks = 0;
    for (const n of col.notes.values()) if (!n.deleted_at && !col.types.has(n.template_id)) orphanNotes++;
    for (const c of col.cards.values()) {
      if (c.deleted_at) continue;
      const note = col.notes.get(c.note_id);
      if (!note || note.deleted_at) orphanCards++;
      const d = col.decks.get(c.deck_id);
      if (!d || d.deleted_at) missingDecks++;
    }
    for (const l of col.logs.values()) if (!col.cards.has(l.card_id)) orphanLogs++;
    const issues: string[] = [];
    if (orphanNotes) issues.push(`${orphanNotes} note(s) reference a missing note type`);
    if (orphanCards) issues.push(`${orphanCards} card(s) belong to a missing or deleted note`);
    if (missingDecks) issues.push(`${missingDecks} card(s) are in a missing or deleted deck`);
    if (orphanLogs) issues.push(`${orphanLogs} review log(s) reference a missing card`);
    return { ok: issues.length === 0, orphanCards, orphanNotes, orphanLogs, missingDecks, issues };
  }

  /** Forget cursors so the next sync re-downloads everything (merge rules still protect local history). */
  async resetCursors(): Promise<void> {
    for (const t of SYNC_TABLES) await this.store.setMeta(`cursor:${t}`, null);
  }
}
