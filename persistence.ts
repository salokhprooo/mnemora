/**
 * Persistence adapters. The collection keeps its working set in memory and writes through to one of these.
 * - IndexedDbPersistence: real browser storage (offline, survives reloads).
 * - MemoryPersistence:    used by tests and as a last-resort fallback when IndexedDB is unavailable
 *                         (e.g. some private-browsing modes) — data then lives only for the session.
 */
import type { OutboxEntry, SyncConflict, SyncTable } from '../types';

export type Row = { id: string } & Record<string, unknown>;

export const TABLES: SyncTable[] = ['deck_options', 'card_templates', 'decks', 'notes', 'cards', 'review_logs', 'user_settings'];

export interface Persistence {
  readonly kind: 'indexeddb' | 'memory';
  loadAll(table: SyncTable): Promise<Row[]>;
  putMany(table: SyncTable, rows: Row[]): Promise<void>;
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  outboxAll(): Promise<OutboxEntry[]>;
  outboxPut(entries: OutboxEntry[]): Promise<void>;
  outboxDelete(keys: string[]): Promise<void>;
  conflictsAll(): Promise<SyncConflict[]>;
  conflictPut(c: SyncConflict): Promise<void>;
  conflictDelete(id: string): Promise<void>;
  putMedia(id: string, blob: Blob): Promise<void>;
  getMedia(id: string): Promise<Blob | undefined>;
  clear(): Promise<void>;
  close(): void;
}

// ------------------------------------------------------------------------------------------ memory
export class MemoryPersistence implements Persistence {
  readonly kind = 'memory' as const;
  private tables = new Map<SyncTable, Map<string, Row>>();
  private meta = new Map<string, unknown>();
  private outbox = new Map<string, OutboxEntry>();
  private conflicts = new Map<string, SyncConflict>();
  private media = new Map<string, Blob>();

  private t(table: SyncTable) {
    let m = this.tables.get(table);
    if (!m) this.tables.set(table, (m = new Map()));
    return m;
  }
  async loadAll(table: SyncTable) {
    return [...this.t(table).values()].map((r) => structuredClone(r));
  }
  async putMany(table: SyncTable, rows: Row[]) {
    const m = this.t(table);
    for (const r of rows) m.set(r.id, structuredClone(r));
  }
  async getMeta<T>(key: string) {
    return this.meta.get(key) as T | undefined;
  }
  async setMeta(key: string, value: unknown) {
    this.meta.set(key, structuredClone(value));
  }
  async outboxAll() {
    return [...this.outbox.values()].map((e) => ({ ...e }));
  }
  async outboxPut(entries: OutboxEntry[]) {
    for (const e of entries) this.outbox.set(e.key, { ...e });
  }
  async outboxDelete(keys: string[]) {
    for (const k of keys) this.outbox.delete(k);
  }
  async conflictsAll() {
    return [...this.conflicts.values()].map((c) => structuredClone(c));
  }
  async conflictPut(c: SyncConflict) {
    this.conflicts.set(c.id, structuredClone(c));
  }
  async conflictDelete(id: string) {
    this.conflicts.delete(id);
  }
  async putMedia(id: string, blob: Blob) {
    this.media.set(id, blob);
  }
  async getMedia(id: string) {
    return this.media.get(id);
  }
  async clear() {
    this.tables.clear();
    this.meta.clear();
    this.outbox.clear();
    this.conflicts.clear();
    this.media.clear();
  }
  close() {}
}

// ------------------------------------------------------------------------------------------ IndexedDB
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_OUTBOX = 'outbox';
const STORE_CONFLICTS = 'conflicts';
const STORE_MEDIA = 'media';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IndexedDbPersistence implements Persistence {
  readonly kind = 'indexeddb' as const;
  private constructor(private db: IDBDatabase) {}

  static open(name: string): Promise<IndexedDbPersistence> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(name, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const t of TABLES) if (!db.objectStoreNames.contains(t)) db.createObjectStore(t, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) db.createObjectStore(STORE_OUTBOX, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORE_CONFLICTS)) db.createObjectStore(STORE_CONFLICTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_MEDIA)) db.createObjectStore(STORE_MEDIA);
      };
      open.onsuccess = () => {
        const db = open.result;
        // If another tab upgrades the schema, release the connection so it can proceed.
        db.onversionchange = () => db.close();
        resolve(new IndexedDbPersistence(db));
      };
      open.onerror = () => reject(open.error ?? new Error('Cannot open IndexedDB'));
      open.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
    });
  }

  async loadAll(table: SyncTable) {
    const tx = this.db.transaction(table, 'readonly');
    return (await req(tx.objectStore(table).getAll())) as Row[];
  }
  async putMany(table: SyncTable, rows: Row[]) {
    if (!rows.length) return;
    const tx = this.db.transaction(table, 'readwrite');
    const s = tx.objectStore(table);
    for (const r of rows) s.put(r);
    await txDone(tx);
  }
  async getMeta<T>(key: string) {
    const tx = this.db.transaction(STORE_META, 'readonly');
    return (await req(tx.objectStore(STORE_META).get(key))) as T | undefined;
  }
  async setMeta(key: string, value: unknown) {
    const tx = this.db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put(value, key);
    await txDone(tx);
  }
  async outboxAll() {
    const tx = this.db.transaction(STORE_OUTBOX, 'readonly');
    return (await req(tx.objectStore(STORE_OUTBOX).getAll())) as OutboxEntry[];
  }
  async outboxPut(entries: OutboxEntry[]) {
    if (!entries.length) return;
    const tx = this.db.transaction(STORE_OUTBOX, 'readwrite');
    const s = tx.objectStore(STORE_OUTBOX);
    for (const e of entries) s.put(e);
    await txDone(tx);
  }
  async outboxDelete(keys: string[]) {
    if (!keys.length) return;
    const tx = this.db.transaction(STORE_OUTBOX, 'readwrite');
    const s = tx.objectStore(STORE_OUTBOX);
    for (const k of keys) s.delete(k);
    await txDone(tx);
  }
  async conflictsAll() {
    const tx = this.db.transaction(STORE_CONFLICTS, 'readonly');
    return (await req(tx.objectStore(STORE_CONFLICTS).getAll())) as SyncConflict[];
  }
  async conflictPut(c: SyncConflict) {
    const tx = this.db.transaction(STORE_CONFLICTS, 'readwrite');
    tx.objectStore(STORE_CONFLICTS).put(c);
    await txDone(tx);
  }
  async conflictDelete(id: string) {
    const tx = this.db.transaction(STORE_CONFLICTS, 'readwrite');
    tx.objectStore(STORE_CONFLICTS).delete(id);
    await txDone(tx);
  }
  async putMedia(id: string, blob: Blob) {
    const tx = this.db.transaction(STORE_MEDIA, 'readwrite');
    tx.objectStore(STORE_MEDIA).put(blob, id);
    await txDone(tx);
  }
  async getMedia(id: string) {
    const tx = this.db.transaction(STORE_MEDIA, 'readonly');
    return (await req(tx.objectStore(STORE_MEDIA).get(id))) as Blob | undefined;
  }
  async clear() {
    const names = [...TABLES, STORE_META, STORE_OUTBOX, STORE_CONFLICTS, STORE_MEDIA];
    const tx = this.db.transaction(names, 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    await txDone(tx);
  }
  close() {
    this.db.close();
  }
}

/** Open IndexedDB persistence for a user, falling back to memory if the browser refuses. */
export async function openPersistence(userKey: string): Promise<Persistence> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
    return await IndexedDbPersistence.open(`mnemora-${userKey}`);
  } catch (e) {
    console.warn('IndexedDB unavailable, falling back to in-memory storage (data will not persist).', e);
    return new MemoryPersistence();
  }
}
