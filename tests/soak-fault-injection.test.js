import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFaultInjectionHarness,
  durableExecution
} from './support/fault-injection-harness.js';

test('soak harness staggers five overdue recoveries across service-worker restarts without duplicate recovery', async () => {
  const harness = createFaultInjectionHarness({ maxParallelTasks: 5, startAt: '2026-08-29T09:00:00.000Z' });
  for (let index = 1; index <= 5; index += 1) {
    await harness.seedExecution(`chatgpt-${index}`, durableExecution(index, {
      phase: 'RUNNING',
      next_recovery_at: '2026-08-29T08:59:00.000Z'
    }));
  }

  await harness.restartServiceWorker();
  await harness.recoverDue();
  assert.deepEqual(harness.recoveryTaskIds(), ['task-1']);

  for (let index = 2; index <= 5; index += 1) {
    await harness.advanceToNextRecovery();
    await harness.restartServiceWorker();
    await harness.recoverNextDue();
    assert.deepEqual(harness.recoveryTaskIds(), Array.from({ length: index }, (_, offset) => `task-${offset + 1}`));
  }

  assert.equal(harness.hasDuplicateRecoveries(), false);
  assert.equal(harness.minimumRecoverySpacingMs(), 5_000);
});

test('soak harness keeps pressure cooldown durable across service-worker restart and does not burst claims on expiry', async () => {
  const harness = createFaultInjectionHarness({ maxParallelTasks: 5, startAt: '2026-08-29T10:00:00.000Z' });
  await harness.seedPressureCooldown({ until: '2026-08-29T10:05:00.000Z' });

  await harness.restartServiceWorker();
  await harness.runAutoTick();
  assert.equal(harness.claimAttempts().length, 0);

  await harness.advance(5 * 60 * 1000);
  await harness.restartServiceWorker();
  await harness.queueTasks(['task-a', 'task-b', 'task-c']);
  await harness.runAutoTick();
  assert.deepEqual(harness.claimedTaskIds(), ['task-a']);

  await harness.advance(5 * 60 * 1000 - 1);
  await harness.runAutoTick();
  assert.deepEqual(harness.claimedTaskIds(), ['task-a']);

  await harness.advance(1);
  await harness.runAutoTick();
  assert.deepEqual(harness.claimedTaskIds(), ['task-a', 'task-b']);
  assert.equal(harness.hasDuplicateClaims(), false);
});

test('soak harness reconciles duplicate execution lineage after restart without creating another prompt side effect', async () => {
  const harness = createFaultInjectionHarness({ maxParallelTasks: 3, startAt: '2026-08-29T11:00:00.000Z' });
  const duplicate = durableExecution(1, {
    task_id: 'task-dup',
    assignment_id: 'assignment-dup',
    execution_id: 'execution-dup',
    phase: 'RUNNING'
  });
  await harness.seedExecution('chatgpt-1', duplicate);
  await harness.seedExecution('chatgpt-2', duplicate);
  harness.recordPrompt('task-dup', 'round-1');

  await harness.restartServiceWorker();
  await harness.runAutoTick();

  assert.deepEqual(await harness.activeTaskIds(), ['task-dup']);
  assert.deepEqual(harness.promptKeys(), ['task-dup:round-1']);
  assert.equal(harness.hasDuplicatePrompts(), false);
  assert.equal(harness.detachedDuplicateCount(), 1);
});

test('soak harness preserves PatchSync infrastructure circuit across restart and allows only the post-backoff probe', async () => {
  const harness = createFaultInjectionHarness({ maxParallelTasks: 5, startAt: '2026-08-29T12:00:00.000Z' });
  await harness.queueTasks(['task-infra-a', 'task-infra-b']);
  await harness.seedInfrastructureCircuit({
    service: 'patchsync',
    retryAt: '2026-08-29T12:00:30.000Z',
    operation: 'ensure_ready'
  });

  await harness.restartServiceWorker();
  await harness.runAutoTick();
  assert.equal(harness.claimAttempts().length, 0);

  await harness.advance(29_999);
  await harness.restartServiceWorker();
  await harness.runAutoTick();
  assert.equal(harness.claimAttempts().length, 0);

  await harness.advance(1);
  await harness.restartServiceWorker();
  await harness.runAutoTick();
  assert.deepEqual(harness.claimedTaskIds(), ['task-infra-a']);
  assert.equal(harness.hasDuplicateClaims(), false);
});
