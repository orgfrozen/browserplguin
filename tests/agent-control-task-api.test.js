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


function restoredApiWithHttp(responses) {
  const http = fetchRecorder(responses);
  const api = new AgentControlTaskApi({ baseUrl: 'https://control.example.test', agentId: 'agent-mac', fetchImpl: http.fetchImpl });
  api.restoreLease('task-1', {
    token: 'lease-a', ttl_ms: 60000, expires_at: '2026-08-17T11:01:00.000Z',
    agent_id: 'agent-mac', assignment_id: 'assignment-1', execution_id: 'execution-1'
  });
  return { api, http };
}

test('completionCheckTask sends side-effect-free completion_check and keeps the lease active', async () => {
  const { api, http } = restoredApiWithHttp([
    jsonResponse(200, { result: { directive: 'CONTINUE', status: 'unmet', summary: 'Need two more patches', unmet_criteria: ['min_successful_patches'] } })
  ]);

  const result = await api.completionCheckTask('task-1', { task_patch_count: 3, task_round_count: 5 });

  assert.equal(result.directive, 'CONTINUE');
  assert.equal(api.getLease('task-1').token, 'lease-a');
  assert.deepEqual(JSON.parse(http.calls[0].init.body), {
    agent_id: 'agent-mac', operation: 'completion_check', task_id: 'task-1', assignment_id: 'assignment-1', execution_id: 'execution-1',
    input: { summary: 'Model reported DONE', payload: { task_patch_count: 3, task_round_count: 5 } }
  });
});

test('reportArtifact creates a Patch deliverable and submission evidence instead of reporting generic progress only', async () => {
  const deliverable = { deliverable_id: 'deliverable-1', deliverable_key: 'vetatool--ps-20260817-abc123--004', deliverable_type: 'patch' };
  const { api, http } = restoredApiWithHttp([
    jsonResponse(201, { result: { deliverable, created: true } }),
    jsonResponse(201, { result: { evidence: { evidence_id: 'evidence-1', evidence_type: 'artifact.report', source: 'agent' } } })
  ]);
  const artifact = {
    filename: 'vetatool--ps-20260817-abc123--004-submit.patch',
    patch_key: 'vetatool--ps-20260817-abc123--004',
    session_id: 'ps-20260817-abc123',
    transfer_mode: 'patchsync',
    transfer_receipt: {
      accepted: true, duplicate: false, project_id: 'vetatool', session_id: 'ps-20260817-abc123',
      sequence: 4, parent_sequence: 3, filename: 'vetatool--ps-20260817-abc123--004-submit.patch', sha256: 'a'.repeat(64), state: 'queued'
    }
  };

  const result = await api.reportArtifact('task-1', artifact);

  assert.equal(result.deliverable.deliverable_id, 'deliverable-1');
  assert.equal(result.evidence.evidence_id, 'evidence-1');
  const create = JSON.parse(http.calls[0].init.body);
  assert.equal(create.operation, 'create_deliverable');
  assert.equal(create.input.deliverable_key, artifact.patch_key);
  assert.equal(create.input.deliverable_type, 'patch');
  assert.deepEqual(create.input.metadata, {
    filename: artifact.filename,
    patch_session_id: 'ps-20260817-abc123',
    sequence: 4,
    sha256: 'a'.repeat(64)
  });
  const evidence = JSON.parse(http.calls[1].init.body);
  assert.equal(evidence.operation, 'submit_evidence');
  assert.equal(evidence.input.deliverable_id, 'deliverable-1');
  assert.equal(evidence.input.evidence_type, 'artifact.report');
  assert.deepEqual(evidence.input.payload, {
    transport: 'patchsync',
    accepted: true,
    duplicate: false,
    state: 'queued',
    patch_session_id: 'ps-20260817-abc123',
    sequence: 4,
    parent_sequence: 3,
    filename: artifact.filename,
    sha256: 'a'.repeat(64)
  });
});

test('agent-control exposes waiting_external/waiting_human events and preserves structured server error codes', async () => {
  const calls = [];
  const responses = [
    new Response(JSON.stringify({ result: { task: { task_id: 't1' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ result: { task: { task_id: 't1' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ error: { code: 'assignment_lease_expired', message: 'lease expired' } }), { status: 409, headers: { 'Content-Type': 'application/json' } })
  ];
  const api = new AgentControlTaskApi({
    baseUrl: 'https://status.example', agentId: 'agent-1',
    fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return responses.shift(); }
  });
  api.restoreLease('t1', { token: 'lease-a', ttl_ms: 90000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' });
  await api.waitingExternalTask('t1', { reason: 'ci' });
  await api.waitingHumanTask('t1', { reason: 'stalled' });
  assert.equal(calls[0].operation, 'waiting_external');
  assert.equal(calls[1].operation, 'waiting_human');
  await assert.rejects(api.heartbeatTask('t1'), error => {
    assert.equal(error.code, 'assignment_lease_expired');
    assert.equal(error.status, 409);
    return true;
  });
});

test('testConnection validates protocol then identifies the configured Agent without claiming work', async () => {
  const http = fetchRecorder([
    jsonResponse(200, {
      protocol: {
        name: 'agent-control',
        version: '1',
        command_endpoint: { method: 'POST', path: '/v1/agent-control/commands' }
      }
    }),
    jsonResponse(200, {
      protocol_version: '1',
      operation: 'identify',
      agent_id: 'agent-mac',
      result: {
        agent: { agent_id: 'agent-mac', name: 'Mac Browser Agent' },
        health: { presence: 'offline' }
      }
    })
  ]);
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test/',
    token: 'agent-token',
    agentId: 'agent-mac',
    fetchImpl: http.fetchImpl
  });

  const result = await api.testConnection();

  assert.deepEqual(result, {
    protocol_version: '1',
    agent_id: 'agent-mac',
    presence: 'offline'
  });
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[0].url, 'https://control.example.test/v1/agent-control/protocol');
  assert.equal(http.calls[0].init.method, 'GET');
  assert.equal(http.calls[0].init.headers.Authorization, 'Bearer agent-token');
  assert.equal(http.calls[1].url, 'https://control.example.test/v1/agent-control/commands');
  assert.deepEqual(JSON.parse(http.calls[1].init.body), {
    agent_id: 'agent-mac', operation: 'identify', input: {}
  });
});

test('testConnection rejects an incompatible Agent Control protocol before identify', async () => {
  const http = fetchRecorder([
    jsonResponse(200, {
      protocol: {
        name: 'agent-control',
        version: '2',
        command_endpoint: { method: 'POST', path: '/v1/agent-control/commands' }
      }
    })
  ]);
  const api = new AgentControlTaskApi({ baseUrl: 'https://control.example.test', agentId: 'agent-mac', fetchImpl: http.fetchImpl });

  await assert.rejects(api.testConnection(), error => {
    assert.equal(error.code, 'task_protocol_incompatible');
    assert.match(error.message, /protocol version 2/i);
    return true;
  });
  assert.equal(http.calls.length, 1);
});
