import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalRuntime, formatSourceExport } from '../src/ui/task-runtime.js';

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


test('Source package status explains PatchSync idle blocking with live elapsed time and blocker details', () => {
  assert.equal(formatSourceExport({
    export_id: 'exp-1', status: 'running', stage: 'waiting_for_idle',
    wait_started_at: '2026-09-05T12:00:00Z', wait_duration: 9,
    blocking_project: 'vetatool', blocking_pid: 4242,
    blocking_phase: 'repairing session state 37/200 ps-test', blocking_reason: 'worker_busy'
  }, Date.parse('2026-09-05T12:09:58Z')),
  'Waiting for PatchSync idle — 00:09:58 · Blocked by: vetatool / PID 4242 / repairing session state 37/200 ps-test / worker_busy');
});

test('Source package status remains useful when blocking diagnostics are unavailable', () => {
  assert.equal(formatSourceExport({ export_id: 'exp-2', status: 'running', stage: 'exporting' }), 'exporting · exp-2');
  assert.equal(formatSourceExport(null), '-');
});
