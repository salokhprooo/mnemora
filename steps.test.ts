import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, stepsToText } from '../src/lib/steps';

test('steps: minutes, h and d suffixes, separators', () => {
  assert.deepEqual(parseSteps('1 10'), [1, 10]);
  assert.deepEqual(parseSteps('1, 10, 1h, 1d'), [1, 10, 60, 1440]);
  assert.deepEqual(parseSteps(''), []);
  assert.deepEqual(parseSteps('0.5'), [0.5]);
});
test('steps: rejects garbage with a helpful message', () => {
  assert.throws(() => parseSteps('abc'), /not a valid step/);
  assert.throws(() => parseSteps('10s'), /not a valid step/);
  assert.throws(() => parseSteps('-5'), /not a valid step/);
});
test('steps round-trip through text', () => {
  for (const s of [[1, 10], [1, 10, 60, 1440], [], [5]]) assert.deepEqual(parseSteps(stepsToText(s)), s);
  assert.equal(stepsToText([1, 10, 60, 1440]), '1 10 1h 1d');
});
