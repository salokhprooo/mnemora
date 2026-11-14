import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from '../src/db/collection';
import { MemoryPersistence } from '../src/db/persistence';
import * as S from '../src/lib/stats';
import { Rating } from '../src/types';

async function world() {
  let now = new Date('2026-03-01T10:00:00');
  const col = await Collection.open(new MemoryPersistence(), 'u', () => now);
  const input = (): S.StatsInput => ({ cards: col.liveCards(), logs: col.liveLogs(), now, rolloverHour: col.settings.rollover_hour });
  return { col, input, set: (d: Date) => (now = d), get now() { return now; } };
}
const ALL: S.StatsFilter = { deckIds: null };

test('daily stats, summary, retention and rating percentages come from real logs', async () => {
  const w = await world();
  const { cards } = await w.col.addNote({ typeId: w.col.builtinTypeId('basic'), deckId: w.col.defaultDeckId, fields: { Front: 'a', Back: 'b' } });
  const id = cards[0].id;
  await w.col.answerCard(id, Rating.Easy, 4000); // new → review
  w.set(new Date(new Date(w.col.cards.get(id)!.due).getTime() + 3600_000));
  await w.col.answerCard(id, Rating.Good, 2000); // review, pass
  w.set(new Date(w.now.getTime() + 20 * 86_400_000));
  await w.col.answerCard(id, Rating.Again, 6000); // review, fail
  const logs = w.input().logs;
  const s = S.summary(logs, 4);
  assert.equal(s.total, 3);
  assert.equal(s.totalMinutes, 12 / 60);
  assert.equal(s.avgSeconds, 4);
  assert.equal(s.retention, 0.5, '1 of 2 review-state answers passed');
  assert.equal(Math.round((s.againPct + s.hardPct + s.goodPct + s.easyPct) * 1000), 1000);
  assert.equal(s.easyPct, 1 / 3);
  const days = S.dailyStats(w.input(), ALL, '2026-03-01', '2026-05-31');
  assert.equal(days.length, 92);
  assert.equal(days.reduce((a, d) => a + d.reviews, 0), 3);
  assert.equal(days[0].learned, 1);
  assert.equal(days[0].easy, 1);
});

test('retention is null without review-state answers; summary of nothing is zeros', () => {
  const s = S.summary([], 4);
  assert.deepEqual([s.total, s.avgSeconds, s.retention, s.againPct], [0, 0, null, 0]);
});

test('undone reviews are excluded from statistics', async () => {
  const w = await world();
  const { cards } = await w.col.addNote({ typeId: w.col.builtinTypeId('basic'), deckId: w.col.defaultDeckId, fields: { Front: 'a', Back: 'b' } });
  await w.col.answerCard(cards[0].id, Rating.Good, 1000);
  await w.col.undoLastAnswer();
  assert.equal(S.summary(w.input().logs, 4).total, 0);
});

test('deck filter restricts logs and cards', async () => {
  const w = await world();
  const d2 = await w.col.createDeck('Other');
  const a = await w.col.addNote({ typeId: w.col.builtinTypeId('basic'), deckId: w.col.defaultDeckId, fields: { Front: 'a', Back: 'b' } });
  const b = await w.col.addNote({ typeId: w.col.builtinTypeId('basic'), deckId: d2.id, fields: { Front: 'c', Back: 'd' } });
  await w.col.answerCard(a.cards[0].id, Rating.Good, 1000);
  await w.col.answerCard(b.cards[0].id, Rating.Good, 1000);
  const f: S.StatsFilter = { deckIds: new Set([d2.id]) };
  assert.equal(S.filterLogs(w.input(), f).length, 1);
  assert.equal(S.filterCards(w.input(), f).length, 1);
  assert.equal(S.periodTotals(w.input(), f).allTime, 1);
  assert.equal(S.filterLogs(w.input(), { deckIds: null, from: '2026-03-02' }).length, 0, 'date range filter');
});

test('streak counts consecutive days, survives an unstudied today, resets after a gap', () => {
  const mk = (iso: string) => ({ reviewed_at: new Date(iso).toISOString(), duration_ms: 1, rating: 3, state: 2, deck_id: 'd' }) as never;
  const logs = ['2026-03-01T12:00', '2026-03-02T12:00', '2026-03-03T12:00', '2026-03-05T12:00', '2026-03-06T12:00'].map(mk);
  assert.deepEqual(S.streak(logs, new Date('2026-03-06T20:00'), 4), { current: 2, longest: 3, studiedToday: true });
  assert.equal(S.streak(logs, new Date('2026-03-07T09:00'), 4).current, 2, 'alive until the day ends');
  assert.equal(S.streak(logs, new Date('2026-03-08T09:00'), 4).current, 0, 'broken after a missed day');
  assert.equal(S.streak([], new Date(), 4).current, 0);
  // 02:00 still belongs to the previous scheduling day (rollover 4)
  // 02:00 still belongs to the previous scheduling day (rollover hour 4)
  const late = [mk('2026-03-06T23:00'), mk('2026-03-07T02:00')];
  assert.equal(S.streak(late, new Date('2026-03-07T03:00'), 4).current, 1, 'both belong to the same scheduling day');
});

test('forecast buckets overdue into today and splits young / mature / learning', async () => {
  const w = await world();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await w.col.addNote({ typeId: w.col.builtinTypeId('basic'), deckId: w.col.defaultDeckId, fields: { Front: `q${i}`, Back: 'a' } })).cards[0].id);
  for (const id of ids) await w.col.answerCard(id, Rating.Easy, 100);
  const cards = w.col.liveCards();
  cards[0].due = new Date(w.now.getTime() - 5 * 86_400_000).toISOString();
  cards[0].scheduled_days = 30;
  cards[1].due = new Date(w.now.getTime() + 2 * 86_400_000).toISOString();
  cards[2].due = new Date(w.now.getTime() + 400 * 86_400_000).toISOString();
  cards[3].suspended = true;
  const f = S.forecast(cards, w.now, 4, 7);
  assert.equal(f.length, 7);
  assert.equal(f[0].mature, 1, 'overdue mature card counted today');
  assert.equal(f[2].total, 1);
  assert.equal(f.reduce((a, d) => a + d.total, 0), 2, 'beyond-horizon and suspended excluded');
  assert.equal(f[6].cumulative, 2);
});

test('heatmap has one cell per day with sensible levels', async () => {
  const w = await world();
  const { cards } = await w.col.addNote({ typeId: w.col.builtinTypeId('basic'), deckId: w.col.defaultDeckId, fields: { Front: 'a', Back: 'b' } });
  await w.col.answerCard(cards[0].id, Rating.Good, 100);
  const h = S.heatmap(w.input(), ALL, 365);
  assert.equal(h.length, 365);
  assert.equal(h[364].count, 1);
  assert.ok(h[364].level >= 1);
  assert.equal(h[0].level, 0);
});

test('card counts: new / learning / young / mature / suspended', async () => {
  const w = await world();
  for (let i = 0; i < 3; i++) await w.col.addNote({ typeId: w.col.builtinTypeId('basic'), deckId: w.col.defaultDeckId, fields: { Front: `q${i}`, Back: 'a' } });
  const [a, b] = w.col.liveCards();
  await w.col.answerCard(a.id, Rating.Easy, 1);
  await w.col.answerCard(b.id, Rating.Good, 1);
  w.col.cards.get(a.id)!.scheduled_days = 40;
  await w.col.setSuspended([w.col.liveCards()[2].id], true);
  const c = S.cardCounts(w.col.liveCards());
  assert.deepEqual(c, { total: 3, new: 1, learning: 1, young: 0, mature: 1, suspended: 1 });
});

test('card growth is cumulative and zero-filled; interval histogram buckets review cards', () => {
  const mk = (d: string) => ({ created_at: new Date(d).toISOString() }) as never;
  const g = S.cardGrowth([mk('2026-02-20T12:00'), mk('2026-03-02T12:00'), mk('2026-03-02T13:00')], 4, '2026-03-01', '2026-03-03');
  assert.deepEqual(g.map((x) => [x.added, x.total]), [[0, 1], [2, 3], [0, 3]]);
  const h = S.intervalHistogram([{ state: 2, scheduled_days: 1 }, { state: 2, scheduled_days: 5 }, { state: 2, scheduled_days: 500 }, { state: 0, scheduled_days: 0 }] as never);
  assert.equal(h.find((b) => b.label === '1d')!.count, 1);
  assert.equal(h.find((b) => b.label === '4–7d')!.count, 1);
  assert.equal(h.find((b) => b.label === '1y+')!.count, 1);
});

test('period totals and grouping into weeks / months / years', () => {
  const now = new Date('2026-03-15T12:00');
  const mk = (iso: string) => ({ reviewed_at: new Date(iso).toISOString(), duration_ms: 60_000, rating: 3, state: 2, deck_id: 'd' }) as never;
  const logs = [mk('2026-03-15T09:00'), mk('2026-03-12T09:00'), mk('2026-03-01T09:00'), mk('2025-12-01T09:00'), mk('2024-01-01T09:00')];
  const t = S.periodTotals({ cards: [], logs, now, rolloverHour: 4 }, ALL);
  assert.deepEqual(t, { today: 1, week: 2, month: 3, year: 4, allTime: 5 });
  const days = S.dailyStats({ cards: [], logs, now, rolloverHour: 4 }, ALL, '2025-12-01', '2026-03-15');
  assert.equal(S.groupStats(days, 'year').map((x) => x.reviews).join(), '1,3');
  assert.equal(S.groupStats(days, 'month').length, 4, 'Dec, Jan, Feb, Mar — empty months are kept so charts have no gaps');
  assert.equal(S.groupStats(days, 'week').reduce((a, x) => a + x.reviews, 0), 4);
  assert.equal(S.reviewsToday(logs.map((l) => l as never), now, 4), 1);
});
