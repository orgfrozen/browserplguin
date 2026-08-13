import test from 'node:test';
import assert from 'node:assert/strict';
import { HeartbeatManager } from '../src/background/heartbeat-manager.js';

test('heartbeat interval is capped at one third of the server lease ttl', () => {
  const scheduled = [];
  const taskApi = {
    getLease(taskId) {
      assert.equal(taskId, 't1');
      return { token: 'lease', ttl_ms: 45000 };
    },
    async heartbeatTask() {}
  };
  const manager = new HeartbeatManager({
    taskApi,
    intervalMs: 30000,
    setTimer(fn, ms) { scheduled.push({ fn, ms }); return 1; },
    clearTimer() {}
  });

  manager.start('t1');
  assert.equal(scheduled[0].ms, 15000);
});

test('heartbeat keeps configured interval when no lease metadata is available', () => {
  const scheduled = [];
  const taskApi = { getLease() { return null; }, async heartbeatTask() {} };
  const manager = new HeartbeatManager({
    taskApi,
    intervalMs: 30000,
    setTimer(fn, ms) { scheduled.push({ fn, ms }); return 1; },
    clearTimer() {}
  });

  manager.start('t1');
  assert.equal(scheduled[0].ms, 30000);
});

test('heartbeat reschedules from refreshed lease ttl without overlapping timers', async () => {
  const scheduled = [];
  let lease = { token: 'lease-a', ttl_ms: 90000 };
  const taskApi = {
    getLease() { return lease; },
    async heartbeatTask() { lease = { token: 'lease-b', ttl_ms: 30000 }; }
  };
  const manager = new HeartbeatManager({
    taskApi,
    intervalMs: 60000,
    setTimer(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimer() {}
  });

  manager.start('t1');
  assert.equal(scheduled[0].ms, 30000);
  await scheduled[0].fn();
  assert.equal(scheduled[1].ms, 10000);
});

test('heartbeat publishes refreshed lease so TaskStore can checkpoint token rotation', async () => {
  const scheduled = [];
  let lease = { token: 'lease-a', ttl_ms: 90000 };
  const updates = [];
  const taskApi = {
    getLease() { return lease; },
    async heartbeatTask() { lease = { token: 'lease-b', ttl_ms: 30000 }; }
  };
  const manager = new HeartbeatManager({
    taskApi,
    intervalMs: 60000,
    onLeaseUpdated(taskId, refreshed) { updates.push({ taskId, refreshed }); },
    setTimer(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimer() {}
  });

  manager.start('t1');
  await scheduled[0].fn();
  assert.deepEqual(updates, [{ taskId: 't1', refreshed: { token: 'lease-b', ttl_ms: 30000 } }]);
});
