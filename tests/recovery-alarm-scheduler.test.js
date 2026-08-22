import test from 'node:test';
import assert from 'node:assert/strict';

async function loadScheduler() {
  try {
    return await import('../src/background/recovery-alarm-scheduler.js');
  } catch {
    return {};
  }
}

test('recovery alarm retry moves a stale durable recovery into the near future', async () => {
  const { nextRecoveryAlarmWhen } = await loadScheduler();
  assert.equal(typeof nextRecoveryAlarmWhen, 'function');
  assert.equal(nextRecoveryAlarmWhen({
    activeExecution: { task_id: 'task-1', next_recovery_at: '2026-08-23T00:39:52.000Z' },
    nowMs: Date.parse('2026-08-23T06:50:00.000Z'),
    retryDelayMs: 2000
  }), Date.parse('2026-08-23T06:50:02.000Z'));
});

test('recovery alarm retry preserves a future durable recovery deadline', async () => {
  const { nextRecoveryAlarmWhen } = await loadScheduler();
  assert.equal(typeof nextRecoveryAlarmWhen, 'function');
  assert.equal(nextRecoveryAlarmWhen({
    activeExecution: { task_id: 'task-1', next_recovery_at: '2026-08-23T06:50:10.000Z' },
    nowMs: Date.parse('2026-08-23T06:50:00.000Z'),
    retryDelayMs: 2000
  }), Date.parse('2026-08-23T06:50:10.000Z'));
});

test('recovery alarm retry ignores executions that do not expect another recovery', async () => {
  const { nextRecoveryAlarmWhen } = await loadScheduler();
  assert.equal(typeof nextRecoveryAlarmWhen, 'function');
  assert.equal(nextRecoveryAlarmWhen({
    activeExecution: { task_id: 'task-1', next_recovery_at: null },
    nowMs: Date.parse('2026-08-23T06:50:00.000Z'),
    retryDelayMs: 2000
  }), null);
});
