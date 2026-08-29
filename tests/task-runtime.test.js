import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalRuntime } from '../src/ui/task-runtime.js';

test('local Task runtime formats elapsed wall-clock time as HH:MM:SS', () => {
  assert.equal(formatLocalRuntime('2026-08-29T04:00:00.000Z', Date.parse('2026-08-29T05:01:01.900Z')), '01:01:01');
  assert.equal(formatLocalRuntime('2026-08-24T00:00:00.000Z', Date.parse('2026-08-29T03:04:05.000Z')), '123:04:05');
});

test('local Task runtime is stable for missing, invalid, or future timestamps', () => {
  const now = Date.parse('2026-08-29T05:00:00.000Z');
  assert.equal(formatLocalRuntime(null, now), '00:00:00');
  assert.equal(formatLocalRuntime('invalid', now), '00:00:00');
  assert.equal(formatLocalRuntime('2026-08-29T05:00:01.000Z', now), '00:00:00');
});
