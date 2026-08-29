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

test('confirmed lease loss stops heartbeat scheduling and publishes the loss once', async () => {
  const scheduled = [];
  const losses = [];
  const leaseError = Object.assign(new Error('lease expired'), { code: 'assignment_lease_expired', status: 409 });
  const taskApi = {
    getLease() { return { token: 'lease-a', ttl_ms: 90000 }; },
    async heartbeatTask() { throw leaseError; }
  };
  const manager = new HeartbeatManager({
    taskApi,
    intervalMs: 30000,
    onLeaseLost(taskId, error) { losses.push({ taskId, code: error.code }); },
    setTimer(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimer() {}
  });

  manager.start('t1');
  await scheduled[0].fn();
  assert.deepEqual(losses, [{ taskId: 't1', code: 'assignment_lease_expired' }]);
  assert.equal(scheduled.length, 1);
  assert.equal(manager.getLeaseLoss().code, 'assignment_lease_expired');
  assert.throws(() => manager.assertLeaseActive(), /lease expired/i);
});


test('Assignment lease renewal cadence follows one third of server lease ttl instead of Agent heartbeat interval', () => {
  let scheduled = null;
  const taskApi = {
    getLease() { return { token: 'lease-a', ttl_ms: 90000 }; },
    async heartbeatTask() {}
  };
  const manager = new HeartbeatManager({
    taskApi,
    intervalMs: 5000,
    setTimer(fn, delay) { scheduled = { fn, delay }; return 1; },
    clearTimer() {}
  });

  manager.start('task-1');

  assert.equal(scheduled.delay, 30000);
});

test('default Worker timers keep the native global receiver when scheduled through HeartbeatManager', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  const cleared = [];

  globalThis.setTimeout = function (fn, ms) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    scheduled.push({ fn, ms });
    return 17;
  };
  globalThis.clearTimeout = function (timer) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    cleared.push(timer);
  };

  try {
    const taskApi = {
      getLease() { return { token: 'lease-a', ttl_ms: 90000 }; },
      async heartbeatTask() {}
    };
    const manager = new HeartbeatManager({ taskApi });

    manager.start('task-1');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 30000);
    manager.stop();
    assert.deepEqual(cleared, [17]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('successful execution heartbeat publishes a liveness callback independently of lease rotation', async () => {
  const scheduled = [];
  const beats = [];
  const taskApi = {
    getLease() { return { token: 'lease-a', ttl_ms: 90000 }; },
    async heartbeatTask(taskId) { assert.equal(taskId, 'task-1'); }
  };
  const manager = new HeartbeatManager({
    taskApi,
    onHeartbeatSuccess(taskId) { beats.push(taskId); },
    setTimer(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimer() {}
  });

  manager.start('task-1');
  await scheduled[0].fn();

  assert.deepEqual(beats, ['task-1']);
});

test('heartbeat forwards refreshed PatchSync capability metadata with the renewed lease checkpoint', async () => {
  const scheduled = [];
  let lease = { token: 'lease-a', ttl_ms: 90000 };
  const updates = [];
  const patchsync = { access_token: 'fresh-cap', capability_profile: 'lease_bound_v2', access_token_expires_at: '2026-08-17T11:05:00.000Z' };
  const taskApi = {
    getLease() { return lease; },
    async heartbeatTask() {
      lease = { token: 'lease-b', ttl_ms: 30000 };
      return { assignment: { assignment_id: 'a1' }, patchsync };
    }
  };
  const manager = new HeartbeatManager({
    taskApi,
    onLeaseUpdated(taskId, refreshed, result) { updates.push({ taskId, refreshed, result }); },
    setTimer(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimer() {}
  });

  manager.start('task-1');
  await scheduled[0].fn();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].taskId, 'task-1');
  assert.equal(updates[0].refreshed.token, 'lease-b');
  assert.deepEqual(updates[0].result.patchsync, patchsync);
});

test('deterministic execution ownership loss stops heartbeat like a lease loss', async () => {
  const scheduled = [];
  const losses = [];
  const ownershipError = Object.assign(new Error('project is executing another Task'), { code: 'project_execution_locked', status: 409 });
  const taskApi = {
    getLease() { return { token: 'lease-a', ttl_ms: 90000 }; },
    async heartbeatTask() { throw ownershipError; }
  };
  const manager = new HeartbeatManager({
    taskApi,
    intervalMs: 30000,
    onLeaseLost(taskId, error) { losses.push({ taskId, code: error.code }); },
    setTimer(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimer() {}
  });

  manager.start('t1');
  await scheduled[0].fn();
  assert.deepEqual(losses, [{ taskId: 't1', code: 'project_execution_locked' }]);
  assert.equal(scheduled.length, 1);
  assert.equal(manager.getLeaseLoss().code, 'project_execution_locked');
});
