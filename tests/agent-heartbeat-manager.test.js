import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const moduleUrl = new URL('../src/background/agent-heartbeat-manager.js', import.meta.url);

function realSettings(overrides = {}) {
  return {
    mode: 'real',
    taskApiBaseUrl: 'https://control.example.test',
    taskApiToken: 'token',
    agentId: 'agent-mac',
    heartbeatIntervalMs: 30000,
    ...overrides
  };
}

test('Agent heartbeat manager sends immediately, schedules a durable alarm, and avoids a duplicate cold-start alarm beat', async () => {
  await assert.doesNotReject(() => fs.access(moduleUrl));
  const { AgentHeartbeatManager, AGENT_HEARTBEAT_ALARM_NAME } = await import(moduleUrl.href);
  const clearCalls = [];
  const createCalls = [];
  const beats = [];
  let nowMs = 1000;
  let current = realSettings({ heartbeatIntervalMs: 5000 });
  const manager = new AgentHeartbeatManager({
    alarms: {
      async clear(name) { clearCalls.push(name); return true; },
      create(name, options) { createCalls.push({ name, options }); }
    },
    loadSettings: async () => current,
    createTaskApi(settings) {
      assert.equal(settings.agentId, 'agent-mac');
      return {
        async heartbeatAgent(payload) {
          beats.push(payload);
          return { health: { presence: 'online' } };
        }
      };
    },
    now: () => nowMs,
    logger: { warn() {} }
  });

  const started = await manager.configure();
  assert.equal(started.status, 'sent');
  assert.deepEqual(clearCalls, [AGENT_HEARTBEAT_ALARM_NAME]);
  assert.deepEqual(createCalls, [{
    name: AGENT_HEARTBEAT_ALARM_NAME,
    options: { periodInMinutes: 0.5 }
  }]);
  assert.deepEqual(beats, [{ condition: 'healthy', diagnostics: { surface: 'service_worker' } }]);

  const duplicate = await manager.handleAlarm({ name: AGENT_HEARTBEAT_ALARM_NAME });
  assert.equal(duplicate.handled, true);
  assert.equal(duplicate.result.status, 'skipped');
  assert.equal(beats.length, 1);

  nowMs += 30000;
  const periodic = await manager.handleAlarm({ name: AGENT_HEARTBEAT_ALARM_NAME });
  assert.equal(periodic.result.status, 'sent');
  assert.equal(beats.length, 2);

  current = realSettings({ mode: 'mock' });
  const disabled = await manager.configure();
  assert.equal(disabled.status, 'disabled');
  assert.equal(createCalls.length, 1);
  assert.equal(beats.length, 2);
});

test('Agent heartbeat manager treats network failures as best-effort and keeps the alarm schedule active', async () => {
  await assert.doesNotReject(() => fs.access(moduleUrl));
  const { AgentHeartbeatManager, AGENT_HEARTBEAT_ALARM_NAME } = await import(moduleUrl.href);
  const createCalls = [];
  const warnings = [];
  const manager = new AgentHeartbeatManager({
    alarms: {
      async clear() { return true; },
      create(name, options) { createCalls.push({ name, options }); }
    },
    loadSettings: async () => realSettings(),
    createTaskApi() {
      return { async heartbeatAgent() { throw Object.assign(new Error('offline'), { code: 'network_down' }); } };
    },
    logger: { warn(...args) { warnings.push(args); } }
  });

  const result = await manager.configure();

  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'network_down');
  assert.equal(createCalls[0].name, AGENT_HEARTBEAT_ALARM_NAME);
  assert.equal(warnings.length, 1);
});


test('Agent heartbeat manager includes live Browser slot telemetry in diagnostics', async () => {
  const { AgentHeartbeatManager } = await import(moduleUrl.href);
  const beats = [];
  const manager = new AgentHeartbeatManager({
    alarms: { async clear() { return true; }, create() {} },
    loadSettings: async () => realSettings(),
    loadDiagnostics: async () => ({
      slots: [{
        slot_id: 'chatgpt-2', project_id: 'vetatool', task_id: 'task-2', phase: 'RUNNING',
        started_at: '2026-08-26T10:00:00.000Z', last_progress_at: '2026-08-26T10:05:00.000Z',
        recovery_count: 2, tab_id: 42
      }]
    }),
    createTaskApi() { return { async heartbeatAgent(payload) { beats.push(payload); return { health: { presence: 'online' } }; } }; },
    logger: { warn() {} }
  });

  await manager.configure();
  assert.deepEqual(beats[0], {
    condition: 'healthy',
    diagnostics: {
      surface: 'service_worker',
      slots: [{
        slot_id: 'chatgpt-2', project_id: 'vetatool', task_id: 'task-2', phase: 'RUNNING',
        started_at: '2026-08-26T10:00:00.000Z', last_progress_at: '2026-08-26T10:05:00.000Z',
        recovery_count: 2, tab_id: 42
      }]
    }
  });
});

test('Agent heartbeat telemetry collection failure does not block presence heartbeat', async () => {
  const { AgentHeartbeatManager } = await import(moduleUrl.href);
  const beats = [];
  const warnings = [];
  const manager = new AgentHeartbeatManager({
    alarms: { async clear() { return true; }, create() {} },
    loadSettings: async () => realSettings(),
    loadDiagnostics: async () => { throw new Error('slot storage unavailable'); },
    createTaskApi() { return { async heartbeatAgent(payload) { beats.push(payload); return { health: { presence: 'online' } }; } }; },
    logger: { warn(...args) { warnings.push(args); } }
  });

  const result = await manager.configure();
  assert.equal(result.status, 'sent');
  assert.deepEqual(beats[0], { condition: 'healthy', diagnostics: { surface: 'service_worker' } });
  assert.equal(warnings.length, 1);
});

test('Browser capacity telemetry reports configured and adaptive effective parallelism', async () => {
  const { buildAgentCapacityDiagnostics } = await import(moduleUrl.href);
  assert.deepEqual(buildAgentCapacityDiagnostics({
    max_parallel_tasks: 3,
    effective_parallel_tasks: 2,
    adaptive_backpressure: {
      state: 'throttled',
      reasons: ['multi_slot_page_failure', 'ui_queue_backlog']
    }
  }), {
    configured_parallel_tasks: 3,
    effective_parallel_tasks: 2,
    capacity_state: 'throttled',
    capacity_reasons: ['multi_slot_page_failure', 'ui_queue_backlog']
  });
});


test('Agent heartbeat manager can schedule a cold-start heartbeat without blocking startup on the network', async () => {
  const { AgentHeartbeatManager, AGENT_HEARTBEAT_ALARM_NAME } = await import(moduleUrl.href);
  let resolveBeat;
  const beatStarted = new Promise(resolve => { resolveBeat = resolve; });
  let releaseBeat;
  const beatBlocked = new Promise(resolve => { releaseBeat = resolve; });
  const manager = new AgentHeartbeatManager({
    alarms: { async clear() { return true; }, create() {} },
    loadSettings: async () => realSettings(),
    createTaskApi() {
      return {
        async heartbeatAgent() {
          resolveBeat();
          await beatBlocked;
          return { health: { presence: 'online' } };
        }
      };
    },
    logger: { warn() {} }
  });

  const configured = await Promise.race([
    manager.configure(null, { sendImmediately: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('configure blocked on heartbeat network')), 25))
  ]);

  assert.equal(configured.status, 'scheduled');
  await beatStarted;
  releaseBeat();
});
