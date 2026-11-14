import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAchievements } from '../src/lib/achievements';

const zero = { totalReviews: 0, longestStreak: 0, currentStreak: 0, cards: 0, decks: 1, matureCards: 0, daysStudied: 0, bestDayReviews: 0 };

test('nothing is earned on an empty collection and progress is 0', () => {
  const a = computeAchievements(zero);
  assert.ok(a.length >= 10);
  assert.equal(a.filter((x) => x.earned).length, 0);
  assert.ok(a.filter((x) => x.id !== 'decks-5').every((x) => x.progress === 0));
  assert.equal(a.find((x) => x.id === 'decks-5')!.progress, 0.2, 'the one default deck counts towards "Organised"');
});

test('achievements unlock exactly at their targets and progress is capped at 1', () => {
  const a = computeAchievements({ ...zero, totalReviews: 100, longestStreak: 7, cards: 9, matureCards: 1 });
  const by = Object.fromEntries(a.map((x) => [x.id, x]));
  assert.equal(by['first-review'].earned, true);
  assert.equal(by['reviews-100'].earned, true);
  assert.equal(by['reviews-1000'].earned, false);
  assert.equal(by['reviews-1000'].progress, 0.1);
  assert.equal(by['streak-7'].earned, true);
  assert.equal(by['streak-30'].earned, false);
  assert.equal(by['cards-10'].earned, false);
  assert.equal(by['mature-1'].earned, true);
  assert.ok(a.every((x) => x.progress <= 1 && x.progress >= 0));
  assert.equal(computeAchievements({ ...zero, totalReviews: 99999 }).find((x) => x.id === 'reviews-100')!.progress, 1);
});
