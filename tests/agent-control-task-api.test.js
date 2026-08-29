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


test('default Agent Control fetch keeps the WorkerGlobalScope receiver', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function (url, init = {}) {
    assert.equal(this, globalThis);
    calls.push({ url, init });
    if (calls.length === 1) return jsonResponse(200, { protocol: { version: '1' } });
    return jsonResponse(200, { result: { agent: { agent_id: 'agent-mac' }, health: { presence: 'online' } } });
  };
  try {
    const api = new AgentControlTaskApi({ baseUrl: 'https://control.example.test', agentId: 'agent-mac' });
    const result = await api.testConnection();
    assert.deepEqual(result, { protocol_version: '1', agent_id: 'agent-mac', presence: 'online' });
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('claimTask checks current before next -> claim -> start and returns one legacy-compatible task with durable lineage/bootstrap', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { result: { assignment: null, task: null, execution: null } }),
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

  assert.equal(http.calls.length, 4);
  for (const call of http.calls) {
    assert.equal(call.url, 'https://control.example.test/v1/agent-control/commands');
    assert.equal(call.init.headers.Authorization, 'Bearer agent-token');
  }
  assert.deepEqual(JSON.parse(http.calls[0].init.body), { agent_id: 'agent-mac', operation: 'current', input: {} });
  assert.deepEqual(JSON.parse(http.calls[1].init.body), { agent_id: 'agent-mac', operation: 'next', input: {} });
  assert.deepEqual(JSON.parse(http.calls[2].init.body), {
    agent_id: 'agent-mac', operation: 'claim', assignment_id: 'assignment-1', input: {}
  });
  assert.deepEqual(JSON.parse(http.calls[3].init.body), {
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

test('claimTask returns null when neither current nor next has an assignment', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { result: { assignment: null, task: null, execution: null } }),
    jsonResponse(200, { result: { assignment: null, task: null } })
  ]);
  const api = new AgentControlTaskApi({ baseUrl: 'https://control.example.test', agentId: 'agent-mac', fetchImpl: http.fetchImpl });
  assert.equal(await api.claimTask(), null);
  assert.equal(http.calls.length, 2);
  assert.equal(JSON.parse(http.calls[0].init.body).operation, 'current');
  assert.equal(JSON.parse(http.calls[1].init.body).operation, 'next');
});

test('claimTask resumes an already claimed Assignment without Execution before asking for next work', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { result: { assignment: claimedAssignment, task: serverTask, execution: null } }),
    jsonResponse(201, { result: { execution, task: serverTask, created: true, browser_execution_bootstrap: bootstrap } })
  ]);
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test', agentId: 'agent-mac', executorRef: 'chrome-profile-a', fetchImpl: http.fetchImpl,
    now: () => Date.parse('2026-08-17T11:00:00.000Z')
  });

  const task = await api.claimTask();

  assert.equal(task.task_id, 'task-1');
  assert.equal(task.agent_control.assignment_id, 'assignment-1');
  assert.equal(task.agent_control.execution_id, 'execution-1');
  assert.deepEqual(http.calls.map(call => JSON.parse(call.init.body).operation), ['current', 'start']);
});

test('resumeCurrentTask reuses an existing server Execution idempotently after local state was lost', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { result: { assignment: claimedAssignment, task: serverTask, execution } }),
    jsonResponse(200, { result: { execution, task: serverTask, created: false, browser_execution_bootstrap: bootstrap } })
  ]);
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test', agentId: 'agent-mac', executorRef: 'chrome-profile-a', fetchImpl: http.fetchImpl,
    now: () => Date.parse('2026-08-17T11:00:00.000Z')
  });

  const task = await api.resumeCurrentTask();

  assert.equal(task.agent_control.execution_id, 'execution-1');
  assert.deepEqual(http.calls.map(call => JSON.parse(call.init.body).operation), ['current', 'start']);
});

test('agent heartbeat reports presence without requiring or mutating Assignment lease lineage', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { result: { heartbeat: { condition: 'healthy' }, health: { presence: 'online' } } })
  ]);
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test', agentId: 'agent-mac', fetchImpl: http.fetchImpl
  });

  const result = await api.heartbeatAgent({ diagnostics: { surface: 'service_worker' } });

  assert.equal(result.health.presence, 'online');
  assert.equal(api.getLease('task-1'), null);
  assert.deepEqual(JSON.parse(http.calls[0].init.body), {
    agent_id: 'agent-mac',
    operation: 'heartbeat',
    input: { condition: 'healthy', diagnostics: { surface: 'service_worker' } }
  });
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

test('Patch artifact APIs keep stable deliverable identity metadata while retry filenames and patch_key change', async () => {
  const stableKey = 'vetatool--ps-20260817-abc123--001-first.patch';
  const retryFilename = 'vetatool--ps-20260817-abc123--001-first-r2.patch';
  const deliverable = { deliverable_id: 'deliverable-retry', deliverable_key: stableKey, deliverable_type: 'patch' };
  const { api, http } = restoredApiWithHttp([
    jsonResponse(201, { result: { deliverable, created: false } }),
    jsonResponse(201, { result: { deliverable, created: false } }),
    jsonResponse(201, { result: { evidence: { evidence_id: 'evidence-retry', evidence_type: 'artifact.report', source: 'agent' } } })
  ]);

  await api.preparePatchArtifact('task-1', {
    filename: retryFilename,
    patch_key: retryFilename,
    deliverable_key: stableKey,
    deliverable_filename: stableKey,
    patch_session_id: 'ps-20260817-abc123',
    sequence: 1
  });
  await api.reportArtifact('task-1', {
    filename: retryFilename,
    patch_key: retryFilename,
    deliverable_key: stableKey,
    deliverable_filename: stableKey,
    session_id: 'ps-20260817-abc123',
    transfer_mode: 'patchsync',
    transfer_receipt: {
      accepted: true, duplicate: false, session_id: 'ps-20260817-abc123', sequence: 1, parent_sequence: 0,
      filename: retryFilename, sha256: 'b'.repeat(64), state: 'queued'
    }
  });

  const prepare = JSON.parse(http.calls[0].init.body);
  const report = JSON.parse(http.calls[1].init.body);
  assert.equal(prepare.input.deliverable_key, stableKey);
  assert.equal(prepare.input.metadata.filename, stableKey);
  assert.equal(report.input.deliverable_key, stableKey);
  assert.equal(report.input.metadata.filename, stableKey);
  const evidence = JSON.parse(http.calls[2].init.body);
  assert.equal(evidence.input.payload.filename, retryFilename);
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

test('preparePatchArtifact creates only the expected Patch deliverable link without submission evidence', async () => {
  const deliverable = { deliverable_id: 'deliverable-expected', deliverable_key: 'vetatool--ps-20260817-abc123--004-submit.patch', deliverable_type: 'patch' };
  const { api, http } = restoredApiWithHttp([
    jsonResponse(201, { result: { deliverable, created: true } })
  ]);

  const result = await api.preparePatchArtifact('task-1', {
    filename: 'vetatool--ps-20260817-abc123--004-submit.patch',
    patch_key: 'vetatool--ps-20260817-abc123--004-submit.patch',
    patch_session_id: 'ps-20260817-abc123',
    sequence: 4
  });

  assert.equal(result.deliverable.deliverable_id, 'deliverable-expected');
  assert.equal(http.calls.length, 1);
  assert.deepEqual(JSON.parse(http.calls[0].init.body), {
    agent_id: 'agent-mac', operation: 'create_deliverable', task_id: 'task-1', execution_id: 'execution-1',
    input: {
      deliverable_key: 'vetatool--ps-20260817-abc123--004-submit.patch',
      deliverable_type: 'patch',
      metadata: {
        filename: 'vetatool--ps-20260817-abc123--004-submit.patch',
        patch_session_id: 'ps-20260817-abc123',
        sequence: 4
      }
    }
  });
});

test('cancelTask uses the control-plane Task cancellation endpoint and releases the local lease', async () => {
  const { api, http } = restoredApiWithHttp([
    jsonResponse(200, { task: { task_id: 'task-1', status: 'cancelled' }, cancelled: true })
  ]);

  const result = await api.cancelTask('task-1', { reason: 'Terminated by BrowserPlugin operator' });

  assert.equal(result.cancelled, true);
  assert.equal(api.getLease('task-1'), null);
  assert.equal(http.calls[0].url, 'https://control.example.test/v1/tasks/task-1/cancel');
  assert.equal(http.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(http.calls[0].init.body), { reason: 'Terminated by BrowserPlugin operator' });
});

test('reconcilePatchSession sends exact browser lineage and session identity without creating a Patch guess', async () => {
  const { api, http } = restoredApiWithHttp([
    jsonResponse(200, { result: { reconciliation: { patch_session_id: 'ps-20260821-recover', discovered_patches: [] }, acceptance: { directive: 'WAIT_EXTERNAL' } } })
  ]);

  const result = await api.reconcilePatchSession('task-1', 'ps-20260821-recover');

  assert.equal(result.reconciliation.patch_session_id, 'ps-20260821-recover');
  assert.deepEqual(JSON.parse(http.calls[0].init.body), {
    agent_id: 'agent-mac', operation: 'reconcile_patch_session', task_id: 'task-1', assignment_id: 'assignment-1', execution_id: 'execution-1',
    input: { patch_session_id: 'ps-20260821-recover' }
  });
});

test('next-only claim mode never resumes another already-active assignment before claiming new work', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { result: { assignment: readyAssignment, task: serverTask } }),
    jsonResponse(200, { result: { assignment: claimedAssignment, task: serverTask } }),
    jsonResponse(201, { result: { execution, task: serverTask, created: true, browser_execution_bootstrap: bootstrap } })
  ]);
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test', agentId: 'agent-mac', executorRef: 'chrome-profile-a', fetchImpl: http.fetchImpl,
    claimMode: 'next_only', now: () => Date.parse('2026-08-17T11:00:00.000Z')
  });

  const task = await api.claimTask();

  assert.equal(task.task_id, 'task-1');
  assert.deepEqual(http.calls.map(call => JSON.parse(call.init.body).operation), ['next', 'claim', 'start']);
});

test('next-only claims are serialized across API instances so one Assignment cannot start twice', async () => {
  let claimed = false;
  let startCount = 0;
  const fetchImpl = async (_url, init = {}) => {
    const command = JSON.parse(init.body);
    if (command.operation === 'next') {
      const available = !claimed;
      await new Promise(resolve => setTimeout(resolve, 10));
      return jsonResponse(200, { result: available ? { assignment: readyAssignment, task: serverTask } : { assignment: null, task: null } });
    }
    if (command.operation === 'claim') {
      claimed = true;
      return jsonResponse(200, { result: { assignment: claimedAssignment, task: serverTask } });
    }
    if (command.operation === 'start') {
      startCount += 1;
      return jsonResponse(201, { result: { execution, task: serverTask, created: startCount === 1, browser_execution_bootstrap: bootstrap } });
    }
    throw new Error(`unexpected operation ${command.operation}`);
  };
  const options = {
    baseUrl: 'https://control.example.test',
    agentId: 'agent-mac',
    executorRef: 'chrome-profile-a',
    claimMode: 'next_only',
    fetchImpl,
    now: () => Date.parse('2026-08-17T11:00:00.000Z')
  };
  const left = new AgentControlTaskApi(options);
  const right = new AgentControlTaskApi(options);

  const results = await Promise.all([left.claimTask(), right.claimTask()]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean)?.task_id, 'task-1');
  assert.equal(startCount, 1);
});

test('Agent Control command observer reports next and claim lifecycle without exposing request input', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { result: { assignment: null, task: null, execution: null } }),
    jsonResponse(200, { result: { assignment: readyAssignment, task: serverTask } }),
    jsonResponse(200, { result: { assignment: claimedAssignment, task: serverTask } }),
    jsonResponse(201, { result: { execution, task: serverTask, created: true, browser_execution_bootstrap: bootstrap } })
  ]);
  const events = [];
  let now = Date.parse('2026-08-28T14:24:00.000Z');
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test',
    agentId: 'agent-mac',
    fetchImpl: http.fetchImpl,
    now: () => now++,
    onCommand: event => events.push(structuredClone(event))
  });

  await api.claimTask();

  const next = events.filter(event => event.operation === 'next');
  const claim = events.filter(event => event.operation === 'claim');
  assert.deepEqual(next.map(event => event.phase), ['started', 'succeeded']);
  assert.equal(next.at(-1).assignment_found, true);
  assert.equal(next.at(-1).task_id, 'task-1');
  assert.deepEqual(claim.map(event => event.phase), ['started', 'succeeded']);
  assert.equal(claim.at(-1).assignment_id, 'assignment-1');
  assert.equal(Object.hasOwn(claim.at(-1), 'input'), false);
});

test('Agent Control command observer records safe claim failure diagnostics', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { result: { assignment: null, task: null, execution: null } }),
    jsonResponse(200, { result: { assignment: readyAssignment, task: serverTask } }),
    jsonResponse(409, { error: { code: 'assignment_lease_inactive', message: 'Assignment lease is not active' } })
  ]);
  const events = [];
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test',
    agentId: 'agent-mac',
    fetchImpl: http.fetchImpl,
    onCommand: event => events.push(structuredClone(event))
  });

  await assert.rejects(() => api.claimTask(), /Assignment lease is not active/);

  const failed = events.find(event => event.operation === 'claim' && event.phase === 'failed');
  assert.equal(failed.error_code, 'assignment_lease_inactive');
  assert.equal(failed.http_status, 409);
  assert.equal(failed.assignment_id, 'assignment-1');
  assert.equal(Object.hasOwn(failed, 'input'), false);
});

test('mutating Agent commands persist one command_id across a network retry and clear it after a received success', async () => {
  const state = new Map();
  const commandStorage = {
    async get(key) { return state.has(key) ? structuredClone(state.get(key)) : undefined; },
    async set(key, value) { state.set(key, structuredClone(value)); },
    async remove(key) { state.delete(key); }
  };
  const sentBodies = [];
  let firstAttempt = true;
  const firstApi = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test',
    agentId: 'agent-mac',
    commandStorage,
    commandIdFactory: () => 'cmd_retry-command-0001',
    fetchImpl: async (_url, init) => {
      sentBodies.push(JSON.parse(init.body));
      if (firstAttempt) {
        firstAttempt = false;
        throw new TypeError('network disconnected after send');
      }
      throw new Error('unexpected second fetch on first API');
    }
  });
  firstApi.restoreLease('task-1', {
    token: 'lease-a', ttl_ms: 90000, assignment_id: 'assignment-1', execution_id: 'execution-1', agent_id: 'agent-mac'
  });

  await assert.rejects(firstApi.waitingExternalTask('task-1', { reason: 'ci' }), /network disconnected/);
  assert.equal(sentBodies[0].command_id, 'cmd_retry-command-0001');
  assert.ok(await commandStorage.get('pendingAgentCommands'), 'unresolved command must survive API/Service Worker reconstruction');

  let factoryCalls = 0;
  const secondApi = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test',
    agentId: 'agent-mac',
    commandStorage,
    commandIdFactory: () => { factoryCalls += 1; return 'cmd_should-not-be-used'; },
    fetchImpl: async (_url, init) => {
      sentBodies.push(JSON.parse(init.body));
      return jsonResponse(200, { result: { task: { task_id: 'task-1' } } });
    }
  });
  secondApi.restoreLease('task-1', {
    token: 'lease-a', ttl_ms: 90000, assignment_id: 'assignment-1', execution_id: 'execution-1', agent_id: 'agent-mac'
  });

  await secondApi.waitingExternalTask('task-1', { reason: 'ci' });
  assert.equal(factoryCalls, 0, 'retry must reuse the durable command_id instead of minting a new logical command');
  assert.equal(sentBodies[1].command_id, sentBodies[0].command_id);
  assert.equal(await commandStorage.get('pendingAgentCommands'), undefined, 'received success completes the local logical command');
});

test('read-only Agent commands never carry command_id even when durable command storage is configured', async () => {
  const state = new Map();
  const commandStorage = {
    async get(key) { return state.has(key) ? structuredClone(state.get(key)) : undefined; },
    async set(key, value) { state.set(key, structuredClone(value)); },
    async remove(key) { state.delete(key); }
  };
  const calls = [];
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test',
    agentId: 'agent-mac',
    commandStorage,
    commandIdFactory: () => 'cmd_read-only-must-not-use',
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) return jsonResponse(200, { result: { assignment: null, task: null, execution: null } });
      return jsonResponse(200, { result: { directive: 'WAIT_EXTERNAL' } });
    }
  });

  await api.getCurrentTask();
  api.restoreLease('task-1', {
    token: 'lease-a', ttl_ms: 90000, assignment_id: 'assignment-1', execution_id: 'execution-1', agent_id: 'agent-mac'
  });
  await api.completionCheckTask('task-1', {});

  assert.equal(Object.hasOwn(calls[0], 'command_id'), false);
  assert.equal(Object.hasOwn(calls[1], 'command_id'), false);
  assert.equal(await commandStorage.get('pendingAgentCommands'), undefined);
});

test('Execution epoch is persisted in the local lease and fenced Agent mutations carry it', async () => {
  const epochExecution = { ...execution, execution_epoch: 9 };
  const epochBootstrap = {
    ...bootstrap,
    execution: { execution_id: 'execution-1', execution_epoch: 9 }
  };
  const http = fetchRecorder([
    jsonResponse(200, { result: { assignment: null, task: null, execution: null } }),
    jsonResponse(200, { result: { assignment: readyAssignment, task: serverTask } }),
    jsonResponse(200, { result: { assignment: claimedAssignment, task: serverTask } }),
    jsonResponse(201, { result: { execution: epochExecution, task: serverTask, created: true, browser_execution_bootstrap: epochBootstrap } }),
    jsonResponse(202, { result: { execution: epochExecution, task: { ...serverTask, status: 'in_progress' } } })
  ]);
  const api = new AgentControlTaskApi({
    baseUrl: 'https://control.example.test',
    agentId: 'agent-mac',
    fetchImpl: http.fetchImpl,
    now: () => Date.parse('2026-08-17T11:00:00.000Z')
  });

  const task = await api.claimTask();
  assert.equal(task.agent_control.execution_epoch, 9);
  assert.equal(api.getLease('task-1').execution_epoch, 9);

  await api.reportProgress('task-1', { type: 'ROUND_STARTED' });
  const progress = JSON.parse(http.calls[4].init.body);
  assert.equal(progress.execution_id, 'execution-1');
  assert.equal(progress.execution_epoch, 9);
});
