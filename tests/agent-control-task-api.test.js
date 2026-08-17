import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentControlTaskApi } from '../src/background/agent-control-task-api.js';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return structuredClone(body); },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

function fetchRecorder(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init: structuredClone(init) });
      const next = queue.shift();
      if (!next) throw new Error(`unexpected fetch ${url}`);
      return next;
    }
  };
}

const serverTask = {
  task_id: 'task-1',
  project_id: 'vetatool',
  title: 'Improve browser flow',
  goal: 'Integrate browser execution',
  instructions: ['Keep the current architecture'],
  acceptance: { min_successful_patches: 1 }
};
const readyAssignment = { assignment_id: 'assignment-1', task_id: 'task-1', agent_id: 'agent-mac', status: 'ready' };
const claimedAssignment = {
  ...readyAssignment,
  status: 'claimed',
  lease_token: 'lease-a',
  lease_until: '2026-08-17T11:01:00.000Z'
};
const execution = { execution_id: 'execution-1', task_id: 'task-1', assignment_id: 'assignment-1', status: 'running' };
const bootstrap = {
  project: { project_id: 'vetatool', name: 'VetaTool', description: 'Tools', goal: 'Grow' },
  task: { task_id: 'task-1', title: serverTask.title, goal: serverTask.goal, instructions: serverTask.instructions, acceptance: serverTask.acceptance },
  assignment: { assignment_id: 'assignment-1', lease_token: 'lease-a' },
  execution: { execution_id: 'execution-1' },
  patchsync: { base_url: 'https://patchsync.example.test', access_token: 'v1.payload.signature', permissions: ['export:create'] },
  recovery_policy: { version: 1, rules: [] }
};

test('claimTask performs next -> claim -> start and returns one legacy-compatible task with durable lineage/bootstrap', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { result: { assignment: readyAssignment, task: serverTask } }),
    jsonResponse(200, { result: { assignment: claimedAssignment, task: serverTask } }),
    jsonResponse(201, { result: { execution, task: serverTask, created: true, browser_execution_bootstrap: bootstrap } })
  ]);
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test/',
    token: 'agent-token',
    agentId: 'agent-mac',
    executorRef: 'chrome-profile-a',
    fetchImpl: http.fetchImpl,
    now: () => Date.parse('2026-08-17T11:00:00.000Z')
  });

  const task = await api.claimTask();

  assert.equal(task.task_id, 'task-1');
  assert.equal(task.project_id, 'vetatool');
  assert.equal(task.task_prompt, 'Integrate browser execution');
  assert.deepEqual(task.agent_control, {
    agent_id: 'agent-mac',
    assignment_id: 'assignment-1',
    execution_id: 'execution-1'
  });
  assert.deepEqual(task.browser_execution_bootstrap, bootstrap);
  assert.deepEqual(api.getLease('task-1'), {
    token: 'lease-a',
    ttl_ms: 60000,
    expires_at: '2026-08-17T11:01:00.000Z',
    agent_id: 'agent-mac',
    assignment_id: 'assignment-1',
    execution_id: 'execution-1'
  });

  assert.equal(http.calls.length, 3);
  for (const call of http.calls) {
    assert.equal(call.url, 'https://control.example.test/v1/agent-control/commands');
    assert.equal(call.init.headers.Authorization, 'Bearer agent-token');
  }
  assert.deepEqual(JSON.parse(http.calls[0].init.body), { agent_id: 'agent-mac', operation: 'next', input: {} });
  assert.deepEqual(JSON.parse(http.calls[1].init.body), {
    agent_id: 'agent-mac', operation: 'claim', assignment_id: 'assignment-1', input: {}
  });
  assert.deepEqual(JSON.parse(http.calls[2].init.body), {
    agent_id: 'agent-mac',
    operation: 'start',
    task_id: 'task-1',
    assignment_id: 'assignment-1',
    input: {
      executor_type: 'browser_extension',
      executor_ref: 'chrome-profile-a',
      summary: 'Starting browser execution',
      metadata: { surface: 'chatgpt.com' }
    }
  });
});

test('claimTask returns null when next has no assignment', async () => {
  const http = fetchRecorder([jsonResponse(200, { result: { assignment: null, task: null } })]);
  const api = new AgentControlTaskApi({ baseUrl: 'https://control.example.test', agentId: 'agent-mac', fetchImpl: http.fetchImpl });
  assert.equal(await api.claimTask(), null);
  assert.equal(http.calls.length, 1);
});

test('heartbeat renews the current assignment lease using persisted lineage', async () => {
  const renewed = { ...claimedAssignment, lease_token: 'lease-b', lease_until: '2026-08-17T11:03:00.000Z' };
  const http = fetchRecorder([jsonResponse(200, { result: { assignment: renewed, task: serverTask } })]);
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test', agentId: 'agent-mac', fetchImpl: http.fetchImpl,
    now: () => Date.parse('2026-08-17T11:02:00.000Z')
  });
  api.restoreLease('task-1', {
    token: 'lease-a', ttl_ms: 60000, expires_at: '2026-08-17T11:01:00.000Z',
    agent_id: 'agent-mac', assignment_id: 'assignment-1', execution_id: 'execution-1'
  });

  await api.heartbeatTask('task-1');

  assert.deepEqual(JSON.parse(http.calls[0].init.body), {
    agent_id: 'agent-mac', operation: 'renew_lease', assignment_id: 'assignment-1', input: { lease_token: 'lease-a' }
  });
  assert.equal(api.getLease('task-1').token, 'lease-b');
  assert.equal(api.getLease('task-1').execution_id, 'execution-1');
});

test('reportProgress uses restored task/assignment/execution lineage', async () => {
  const http = fetchRecorder([jsonResponse(202, { result: { execution, acceptance_evaluation: { status: 'pending' } } })]);
  const api = new AgentControlTaskApi({ baseUrl: 'https://control.example.test', agentId: 'agent-mac', fetchImpl: http.fetchImpl });
  api.restoreLease('task-1', {
    token: 'lease-a', ttl_ms: 60000, expires_at: '2026-08-17T11:01:00.000Z',
    agent_id: 'agent-mac', assignment_id: 'assignment-1', execution_id: 'execution-1'
  });

  await api.reportProgress('task-1', { type: 'TASK_PROJECT_STARTED', project_name: 'temp-project' });

  assert.deepEqual(JSON.parse(http.calls[0].init.body), {
    agent_id: 'agent-mac',
    operation: 'progress',
    task_id: 'task-1',
    assignment_id: 'assignment-1',
    execution_id: 'execution-1',
    input: {
      summary: 'TASK_PROJECT_STARTED',
      payload: { type: 'TASK_PROJECT_STARTED', project_name: 'temp-project' }
    }
  });
});
