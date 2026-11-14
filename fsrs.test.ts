import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, Fsrs, FACTOR } from '../src/lib/fsrs';
import { newCardFields, previewAll, schedule, DEFAULT_SCHEDULER_OPTIONS, type SchedulingFields } from '../src/lib/scheduler';
import { CardState, Rating } from '../src/types';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test('retrievability is exactly the desired retention at t = interval, and R(S,S)=0.9', () => {
  const f = new Fsrs();
  near(f.retrievability(10, 10), 0.9, 1e-9);
  near(f.retrievability(0, 5), 1, 1e-12);
  assert.ok(f.retrievability(30, 5) < f.retrievability(10, 5), 'decays over time');
  assert.equal(FACTOR, 19 / 81);
});

test('interval at 90% retention equals stability (rounded)', () => {
  const f = new Fsrs({ requestRetention: 0.9 });
  assert.equal(f.nextInterval(10), 10);
  assert.equal(f.nextInterval(3.173), 3);
});

test('higher desired retention → shorter intervals; lower → longer', () => {
  const hi = new Fsrs({ requestRetention: 0.95 }).nextInterval(20);
  const mid = new Fsrs({ requestRetention: 0.9 }).nextInterval(20);
  const lo = new Fsrs({ requestRetention: 0.8 }).nextInterval(20);
  assert.ok(hi < mid && mid < lo, `${hi} < ${mid} < ${lo}`);
});

test('maximum interval is honoured', () => {
  const f = new Fsrs({ maximumInterval: 30 });
  assert.equal(f.nextInterval(10_000), 30);
});

test('initial stability / difficulty follow parameters', () => {
  const f = new Fsrs();
  near(f.initStability(1), DEFAULT_PARAMS[0]);
  near(f.initStability(3), DEFAULT_PARAMS[2]);
  near(f.initDifficulty(3), DEFAULT_PARAMS[4] - Math.exp(DEFAULT_PARAMS[5] * 2) + 1);
  assert.ok(f.initDifficulty(1) > f.initDifficulty(2) && f.initDifficulty(2) > f.initDifficulty(3) && f.initDifficulty(3) > f.initDifficulty(4));
});

test('difficulty stays in [1,10] and moves the right way', () => {
  const f = new Fsrs();
  let d = 5;
  for (let i = 0; i < 100; i++) d = f.nextDifficulty(d, 1);
  assert.ok(d <= 10 && d > 5);
  d = 5;
  for (let i = 0; i < 100; i++) d = f.nextDifficulty(d, 4);
  assert.ok(d >= 1 && d < 5);
});

test('successful recall increases stability; Easy > Good > Hard; lapse decreases it', () => {
  const f = new Fsrs();
  const s = 10, d = 5, r = f.retrievability(10, s);
  const hard = f.nextRecallStability(d, s, r, 2);
  const good = f.nextRecallStability(d, s, r, 3);
  const easy = f.nextRecallStability(d, s, r, 4);
  assert.ok(hard > s && good > hard && easy > good, `${s} < ${hard} < ${good} < ${easy}`);
  const lapse = f.nextForgetStability(d, s, r);
  assert.ok(lapse < s && lapse > 0);
});

test('reviewing later than scheduled (lower R) yields a bigger stability gain', () => {
  const f = new Fsrs();
  const early = f.nextRecallStability(5, 10, f.retrievability(5, 10), 3);
  const late = f.nextRecallStability(5, 10, f.retrievability(40, 10), 3);
  assert.ok(late > early);
});

const NOW = new Date('2026-03-10T12:00:00');

test('new card: Again/Hard/Good go to Learning with step delays; Easy graduates', () => {
  const card = newCardFields(NOW);
  const p = previewAll(card, NOW);
  assert.equal(p[1].card.state, CardState.Learning);
  assert.equal(p[1].interval_minutes, 1);
  assert.equal(p[2].card.state, CardState.Learning);
  assert.equal(p[2].interval_minutes, 5.5);
  assert.equal(p[3].card.state, CardState.Learning);
  assert.equal(p[3].interval_minutes, 10);
  assert.equal(p[3].card.step, 1);
  assert.equal(p[4].card.state, CardState.Review);
  assert.ok(p[4].card.scheduled_days >= 1);
  assert.equal(p[1].label, '1m');
});

test('learning: Good on the last step graduates with an FSRS interval', () => {
  let c: SchedulingFields = newCardFields(NOW);
  c = schedule(c, Rating.Good, NOW).card; // step 0 → 1
  const later = new Date(NOW.getTime() + 10 * 60_000);
  const g = schedule(c, Rating.Good, later);
  assert.equal(g.card.state, CardState.Review);
  assert.ok(g.card.scheduled_days >= 1);
  assert.equal(g.card.reps, 2);
  assert.ok(g.card.stability > 0 && g.card.difficulty >= 1 && g.card.difficulty <= 10);
});

test('review card: buttons are strictly ordered Hard < Good < Easy and Again relearns', () => {
  let c: SchedulingFields = newCardFields(NOW);
  c = schedule(c, Rating.Easy, NOW).card;
  const day = new Date(NOW.getTime() + c.scheduled_days * 86_400_000);
  const p = previewAll(c, day);
  assert.ok(p[2].card.scheduled_days < p[3].card.scheduled_days);
  assert.ok(p[3].card.scheduled_days < p[4].card.scheduled_days);
  assert.equal(p[1].card.state, CardState.Relearning);
  assert.equal(p[1].card.lapses, 1);
  assert.equal(p[1].interval_minutes, 10);
});

test('lapse then relearning Good returns to Review with a shorter stability', () => {
  let c: SchedulingFields = newCardFields(NOW);
  c = schedule(c, Rating.Easy, NOW).card;
  const t1 = new Date(NOW.getTime() + c.scheduled_days * 86_400_000);
  const before = c.stability;
  c = schedule(c, Rating.Again, t1).card;
  assert.equal(c.state, CardState.Relearning);
  const t2 = new Date(t1.getTime() + 10 * 60_000);
  c = schedule(c, Rating.Good, t2).card;
  assert.equal(c.state, CardState.Review);
  assert.ok(c.stability < before);
});

test('empty learning steps send new cards straight to Review', () => {
  const opts = { ...DEFAULT_SCHEDULER_OPTIONS, learningSteps: [] };
  const r = schedule(newCardFields(NOW), Rating.Good, NOW, opts);
  assert.equal(r.card.state, CardState.Review);
});

test('scheduling is pure: input card is not mutated', () => {
  const c = newCardFields(NOW);
  const copy = JSON.stringify(c);
  previewAll(c, NOW);
  assert.equal(JSON.stringify(c), copy);
});

test('a long simulated history keeps all values finite and intervals within max', () => {
  const opts = { ...DEFAULT_SCHEDULER_OPTIONS, maximumInterval: 365 };
  let c: SchedulingFields = newCardFields(NOW);
  let t = NOW;
  const pattern = [3, 3, 4, 2, 3, 1, 3, 3, 3, 4, 3, 3, 1, 3, 3, 3, 3, 3, 4, 4];
  for (const g of pattern) {
    const r = schedule(c, g as 1 | 2 | 3 | 4, t, opts);
    c = r.card;
    assert.ok(Number.isFinite(c.stability) && Number.isFinite(c.difficulty));
    assert.ok(c.scheduled_days <= 365);
    t = new Date(new Date(c.due).getTime() + 1000);
  }
  assert.ok(c.reps === pattern.length);
});
