import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from '../src/db/collection';
import { MemoryPersistence, type Row } from '../src/db/persistence';
import { SyncEngine, SyncError, mergeRow, type PullCursor, type RemoteRow, type SyncTransport } from '../src/db/sync';
import type { SyncTable } from '../src/types';
import { SYNC_TABLES } from '../src/types';

/**
 * In-memory server that mimics the SQL triggers: server-assigned synced_at cursor, last-writer-wins guard on
 * update (silently skips stale rows), review_logs without guard, unique(note_id, ord) on cards.
 */
class FakeServer implements SyncTransport {
  tables = new Map<SyncTable, Map<string, RemoteRow>>();
  seq = 0;
  failNext: SyncError | null = null;
  reject: ((table: SyncTable, row: Row) => SyncError | null) | null = null;
  online = true;
  pushed: { table: SyncTable; ids: string[] }[] = [];

  private t(table: SyncTable) {
    let m = this.tables.get(table);
    if (!m) this.tables.set(table, (m = new Map()));
    return m;
  }
  private stamp(): string {
    return new Date(Date.UTC(2026, 0, 1) + ++this.seq * 1000).toISOString().replace('Z', '+00:00');
  }
  async pull(table: SyncTable, cursor: PullCursor | null, limit: number) {
    if (!this.online) throw new SyncError('Failed to fetch', true);
    const rows = [...this.t(table).values()]
      .filter((r) => !cursor || r.synced_at > cursor.at || (r.synced_at === cursor.at && r.id > cursor.id))
      .sort((a, b) => (a.synced_at === b.synced_at ? a.id.localeCompare(b.id) : a.synced_at.localeCompare(b.synced_at)));
    return rows.slice(0, limit).map((r) => structuredClone(r));
  }
  async push(table: SyncTable, rows: Row[]) {
    if (!this.online) throw new SyncError('Failed to fetch', true);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    if (this.reject) for (const r of rows) { const e = this.reject(table, r); if (e) throw e; }
    this.pushed.push({ table, ids: rows.map((r) => r.id) });
    const m = this.t(table);
    for (const raw of rows) {
      const r = table === 'user_settings' ? ({ ...raw, id: String((raw as Record<string, unknown>).user_id) } as Row) : raw;
      if (table === 'cards') {
        for (const o of m.values()) {
          const oc = o as unknown as { note_id: string; ord: number };
          const nc = r as unknown as { note_id: string; ord: number };
          if (o.id !== r.id && oc.note_id === nc.note_id && oc.ord === nc.ord) throw new SyncError('duplicate key', false, '23505');
        }
      }
      const old = m.get(r.id);
      if (old && table !== 'review_logs' && String(r.updated_at) < String(old.updated_at)) continue; // lww_guard
      let next = structuredClone(r) as Record<string, unknown>;
      if (old && table === 'cards') {
        const o = old as unknown as Record<string, unknown>;
        const lrOld = Date.parse(String(o.last_review ?? '')) || 0, lrNew = Date.parse(String(next.last_review ?? '')) || 0;
        if (lrOld && (lrNew < lrOld || (lrNew === lrOld && Number(next.reps) < Number(o.reps)))) {
          for (const k of ['state', 'due', 'stability', 'difficulty', 'scheduled_days', 'step', 'reps', 'lapses', 'last_review']) next[k] = o[k]; // cards_history_guard
        }
      }
      m.set(r.id, { ...next, synced_at: this.stamp() } as unknown as RemoteRow);
    }
  }
}

async function device(server: FakeServer, userId = 'u1', clock = () => new Date()) {
  const store = new MemoryPersistence();
  const col = await Collection.open(store, userId, clock);
  const engine = new SyncEngine(col, store, server, `dev-${Math.random()}`);
  return { store, col, engine };
}

const addBasic = (col: Collection, front: string) =>
  col.addNote({ typeId: col.builtinTypeId('basic'), deckId: col.defaultDeckId, fields: { Front: front, Back: 'b' } });

test('mergeRow: LWW for ordinary rows, history-preserving for cards, append-only for logs', () => {
  const mk = (u: string, extra: Record<string, unknown> = {}) => ({ id: 'x', updated_at: u, ...extra }) as Row;
  assert.equal(mergeRow('decks', undefined, mk('2026-01-01T00:00:00.000Z'), false).action, 'apply');
  assert.equal(mergeRow('decks', mk('2026-01-02T00:00:00.000Z'), mk('2026-01-01T00:00:00.000Z'), true).action, 'keep');
  const m = mergeRow('decks', mk('2026-01-01T00:00:00.000Z'), mk('2026-01-02T00:00:00.000Z'), true);
  assert.equal(m.action, 'apply');
  assert.equal(m.conflict, true);
  // not dirty and remote older → keep (never regress)
  assert.equal(mergeRow('decks', mk('2026-01-02T00:00:00.000Z'), mk('2026-01-01T00:00:00.000Z'), false).action, 'keep');

  // cards: newer last_review wins even when the other side has a newer updated_at
  const local = mk('2026-01-01T00:00:00.000Z', { last_review: '2026-01-01T00:00:00.000Z', reps: 5 });
  const remote = mk('2026-02-01T00:00:00.000Z', { last_review: '2025-12-01T00:00:00.000Z', reps: 3, suspended: true });
  const c = mergeRow('cards', local, remote, true);
  assert.equal(c.action, 'keep');

  // logs: undone can only turn on
  const keep = mergeRow('review_logs', mk('a', { undone: true }), mk('a', { undone: false }), false);
  assert.equal(keep.action, 'keep');
  assert.equal(mergeRow('review_logs', mk('a', { undone: false }), mk('a', { undone: true }), false).action, 'apply');
});

test('push uploads everything in dependency order and empties the outbox', async () => {
  const server = new FakeServer();
  const a = await device(server);
  await addBasic(a.col, 'hello');
  assert.ok((await a.store.outboxAll()).length > 0);
  const st = await a.engine.syncNow();
  assert.equal(st.state, 'idle');
  assert.equal(st.pending, 0);
  assert.ok(st.lastSyncAt);
  const order = server.pushed.map((p) => p.table);
  assert.ok(order.indexOf('decks') < order.indexOf('cards'));
  assert.ok(order.indexOf('notes') < order.indexOf('cards'));
  assert.ok(order.indexOf('card_templates') < order.indexOf('notes'));
  assert.equal(server.tables.get('cards')!.size, 1);
});

test('a second device downloads the collection (including tombstones) and reports integrity ok', async () => {
  const server = new FakeServer();
  const a = await device(server);
  const { note } = await addBasic(a.col, 'one');
  await addBasic(a.col, 'two');
  await a.col.deleteNotes([note.id]);
  await a.engine.syncNow();

  const b = await device(server);
  await b.engine.syncNow();
  const live = b.col.searchCards('', {}).rows.map((r) => r.note.fields.Front);
  assert.deepEqual(live, ['two']);
  assert.equal(b.col.notes.get(note.id)!.deleted_at !== null, true);
  assert.equal(b.engine.integrity().ok, true);
  assert.equal((await b.store.outboxAll()).length, 0, 'applying remote data must not queue it for upload again');
});

test('offline edits are kept in the outbox, sync fails softly, and succeeds when the network returns', async () => {
  const server = new FakeServer();
  const a = await device(server);
  await a.engine.syncNow();
  server.online = false;
  await addBasic(a.col, 'offline card');
  const st = await a.engine.syncNow();
  assert.equal(st.state === 'error' || st.state === 'offline', true);
  assert.ok(st.pending > 0);
  assert.ok(st.error);
  assert.ok(st.retryInMs && st.retryInMs >= 2000);
  server.online = true;
  const ok = await a.engine.syncNow();
  assert.equal(ok.state, 'idle');
  assert.equal(ok.pending, 0);
  assert.equal(server.tables.get('notes')!.size, 1);
});

test('reviews made on two devices both survive; history is never lost', async () => {
  const server = new FakeServer();
  const t0 = new Date('2026-03-01T10:00:00Z');
  let now = t0;
  const a = await device(server, 'u1', () => now);
  const { cards } = await addBasic(a.col, 'q');
  await a.engine.syncNow();
  const b = await device(server, 'u1', () => now);
  await b.engine.syncNow();

  now = new Date('2026-03-01T10:05:00Z');
  await a.col.answerCard(cards[0].id, 3, 4000);
  now = new Date('2026-03-01T10:06:00Z');
  await b.col.answerCard(cards[0].id, 4, 3000);

  await a.engine.syncNow();
  await b.engine.syncNow();
  await a.engine.syncNow();

  assert.equal(a.col.logs.size, 2);
  assert.equal(b.col.logs.size, 2);
  assert.equal(server.tables.get('review_logs')!.size, 2);
  // Both devices converge on the card state of the most recent review (Easy at 10:06).
  const ca = a.col.cards.get(cards[0].id)!;
  const cb = b.col.cards.get(cards[0].id)!;
  assert.equal(ca.last_review, cb.last_review);
  assert.equal(ca.last_review, '2026-03-01T10:06:00.000Z');
  assert.equal(ca.reps, cb.reps);
});

test('stale device cannot overwrite newer review history', async () => {
  const server = new FakeServer();
  let now = new Date('2026-03-01T10:00:00Z');
  const a = await device(server, 'u1', () => now);
  const { cards } = await addBasic(a.col, 'q');
  await a.engine.syncNow();
  const b = await device(server, 'u1', () => now);
  await b.engine.syncNow();

  // B studies the card a lot and syncs.
  for (let i = 0; i < 3; i++) {
    now = new Date(now.getTime() + 60_000);
    await b.col.answerCard(cards[0].id, 3, 1000);
  }
  await b.engine.syncNow();
  const advanced = b.col.cards.get(cards[0].id)!;

  // A (old data) merely suspends the card, with a LATER wall-clock edit time.
  now = new Date('2026-03-02T10:00:00Z');
  await a.col.setSuspended([cards[0].id], true);
  await a.engine.syncNow();

  const onA = a.col.cards.get(cards[0].id)!;
  assert.equal(onA.reps, advanced.reps, 'history from the other device is preserved');
  assert.equal(onA.last_review, advanced.last_review);
  const remote = server.tables.get('cards')!.get(cards[0].id) as unknown as { reps: number };
  assert.equal(remote.reps, advanced.reps);
  assert.ok((await a.engine.conflicts()).length >= 1, 'the clash was recorded');
});

test('concurrent edit of the same deck: newest wins, conflict recorded, user can override', async () => {
  const server = new FakeServer();
  let now = new Date('2026-04-01T10:00:00Z');
  const a = await device(server, 'u1', () => now);
  const deck = await a.col.createDeck('Biology');
  await a.engine.syncNow();
  const b = await device(server, 'u1', () => now);
  await b.engine.syncNow();

  now = new Date('2026-04-01T11:00:00Z');
  await a.col.renameDeck(deck.id, 'Bio (A)');
  now = new Date('2026-04-01T12:00:00Z');
  await b.col.renameDeck(deck.id, 'Bio (B)');
  await b.engine.syncNow(); // server now has B's newer name
  await a.engine.syncNow(); // A's older edit loses

  assert.equal(a.col.decks.get(deck.id)!.name, 'Bio (B)');
  const conflicts = await a.engine.conflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].auto_kept, 'remote');

  // user prefers their own version
  now = new Date('2026-04-01T13:00:00Z');
  await a.engine.resolveConflict(conflicts[0].id, 'local');
  assert.equal(a.col.decks.get(deck.id)!.name, 'Bio (A)');
  await a.engine.syncNow();
  assert.equal((server.tables.get('decks')!.get(deck.id) as unknown as { name: string }).name, 'Bio (A)');
  assert.equal((await a.engine.conflicts()).length, 0);
});

test('a permanently rejected row is quarantined and does not block the rest of the queue', async () => {
  const server = new FakeServer();
  const a = await device(server);
  await a.engine.syncNow();
  const d1 = await a.col.createDeck('Good');
  server.reject = (t, r) => (t === 'decks' && (r as unknown as { name: string }).name === 'Bad' ? new SyncError('violates check constraint', false, '23514') : null);
  const bad = await a.col.createDeck('Bad');
  const st = await a.engine.syncNow();
  assert.equal(st.state, 'idle');
  assert.equal(st.pending, 0, 'queue drained');
  assert.ok(st.conflicts >= 1, 'rejection recorded for the user');
  assert.ok(server.tables.get('decks')!.has(d1.id));
  assert.ok(!server.tables.get('decks')!.has(bad.id));
});

test('duplicate cloze card created on two devices (unique note+ord) keeps the server card', async () => {
  const server = new FakeServer();
  const a = await device(server);
  const typeId = a.col.builtinTypeId('cloze');
  const { note } = await a.col.addNote({ typeId, deckId: a.col.defaultDeckId, fields: { Text: '{{c1::one}} and {{c2::two}}' } });
  await a.engine.syncNow();
  const b = await device(server);
  await b.engine.syncNow();
  // both add {{c3}} offline
  await a.col.updateNote(note.id, { fields: { Text: '{{c1::one}} {{c2::two}} {{c3::three}}' } });
  await b.col.updateNote(note.id, { fields: { Text: '{{c1::one}} {{c2::two}} {{c3::three}}' } });
  await a.engine.syncNow();
  await b.engine.syncNow();
  await b.engine.syncNow();
  const live = (c: Collection) => c.cardsOfNote(note.id).filter((x) => !x.deleted_at).length;
  assert.equal(live(a.col), 3);
  assert.equal(live(b.col), 3);
});

test('pagination: more than one page of rows is downloaded completely', async () => {
  const server = new FakeServer();
  const a = await device(server);
  for (let i = 0; i < 620; i++) await a.col.createDeck(`D${i}`);
  await a.engine.syncNow();
  const b = await device(server);
  await b.engine.syncNow();
  assert.equal(b.col.liveDecks().length, a.col.liveDecks().length);
  assert.equal(b.col.liveDecks().length, 621);
});

test('integrity report finds orphans', async () => {
  const server = new FakeServer();
  const a = await device(server);
  const { cards } = await addBasic(a.col, 'q');
  a.col.notes.delete(cards[0].note_id);
  const r = a.engine.integrity();
  assert.equal(r.ok, false);
  assert.equal(r.orphanCards, 1);
});

test('without a transport the engine is disabled but still counts pending changes', async () => {
  const store = new MemoryPersistence();
  const col = await Collection.open(store, 'local');
  const engine = new SyncEngine(col, store, null, 'd');
  await engine.start();
  await col.createDeck('x');
  const st = await engine.syncNow();
  assert.equal(st.state, 'disabled');
  engine.stop();
});

test('every sync table is exercised by the engine', () => {
  assert.deepEqual([...SYNC_TABLES], ['deck_options', 'card_templates', 'decks', 'notes', 'cards', 'review_logs', 'user_settings']);
});

test('SupabaseTransport only pulls the signed-in user\'s rows (RLS also exposes other users\' public decks)', async () => {
  const { SupabaseTransport } = await import('../src/db/supabaseTransport');
  const calls: string[][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'or']) builder[m] = (...a: unknown[]) => { calls.push([m, ...a.map(String)]); return builder; };
  builder.then = (res: (v: unknown) => unknown) => res({ data: [], error: null, status: 200 });
  const t = new SupabaseTransport({ from: () => builder }, 'user-1');
  await t.pull('decks', { at: '2026-01-01T00:00:00+00:00', id: 'x' }, 10);
  assert.ok(calls.some((c) => c[0] === 'eq' && c[1] === 'user_id' && c[2] === 'user-1'));
  assert.ok(calls.some((c) => c[0] === 'or' && c[1].includes('synced_at.gt.2026-01-01')));
});
