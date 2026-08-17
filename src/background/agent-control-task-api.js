import { TaskApi } from './task-api.js';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} is required`);
  return value;
}

function leaseFromAssignment(assignment, { agentId, executionId, nowMs }) {
  requireObject(assignment, 'assignment');
  if (!nonEmptyString(assignment.lease_token)) throw new TypeError('assignment.lease_token is required');
  if (!nonEmptyString(assignment.lease_until) || Number.isNaN(Date.parse(assignment.lease_until))) {
    throw new TypeError('assignment.lease_until must be an ISO date-time');
  }
  if (!nonEmptyString(assignment.assignment_id)) throw new TypeError('assignment.assignment_id is required');
  if (!nonEmptyString(executionId)) throw new TypeError('execution_id is required');
  const ttlMs = Math.max(1000, Date.parse(assignment.lease_until) - nowMs);
  return {
    token: assignment.lease_token,
    ttl_ms: ttlMs,
    expires_at: assignment.lease_until,
    agent_id: agentId,
    assignment_id: assignment.assignment_id,
    execution_id: executionId
  };
}

function validateRestoredLease(raw, agentId) {
  requireObject(raw, 'persisted lease');
  if (!nonEmptyString(raw.token)) throw new TypeError('persisted lease.token is required');
  if (!Number.isInteger(raw.ttl_ms) || raw.ttl_ms <= 0) throw new TypeError('persisted lease.ttl_ms must be a positive integer');
  if (!nonEmptyString(raw.assignment_id)) throw new TypeError('persisted lease.assignment_id is required');
  if (!nonEmptyString(raw.execution_id)) throw new TypeError('persisted lease.execution_id is required');
  if (!nonEmptyString(raw.agent_id)) throw new TypeError('persisted lease.agent_id is required');
  if (raw.agent_id !== agentId) throw new TypeError(`persisted lease belongs to Agent ${raw.agent_id}, not ${agentId}`);
  if (raw.expires_at != null && (!nonEmptyString(raw.expires_at) || Number.isNaN(Date.parse(raw.expires_at)))) {
    throw new TypeError('persisted lease.expires_at must be an ISO date-time when provided');
  }
  return structuredClone(raw);
}

function legacyCompatibleTask(task, { agentId, assignmentId, executionId, bootstrap }) {
  requireObject(task, 'task');
  if (!nonEmptyString(task.task_id)) throw new TypeError('task.task_id is required');
  if (!nonEmptyString(task.project_id)) throw new TypeError('task.project_id is required');
  const taskPrompt = nonEmptyString(task.goal) ? task.goal : task.title;
  if (!nonEmptyString(taskPrompt)) throw new TypeError('task.goal or task.title is required');
  return {
    ...structuredClone(task),
    task_prompt: taskPrompt,
    agent_control: {
      agent_id: agentId,
      assignment_id: assignmentId,
      execution_id: executionId
    },
    browser_execution_bootstrap: structuredClone(bootstrap)
  };
}

export class AgentControlTaskApi extends TaskApi {
  constructor({ baseUrl, token = '', agentId, executorRef = 'browser-extension', fetchImpl = fetch, now = Date.now }) {
    super();
    if (!nonEmptyString(baseUrl)) throw new TypeError('baseUrl is required');
    if (!nonEmptyString(agentId)) throw new TypeError('agentId is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.agentId = agentId;
    this.executorRef = executorRef;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.leases = new Map();
  }

  async testConnection() {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetchImpl(`${this.baseUrl}/v1/agent-control/protocol`, {
      method: 'GET',
      headers
    });
    if (!response.ok) {
      const raw = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* keep raw response text */ }
      const message = parsed?.error?.message ?? raw;
      const error = new Error(`Agent Control ${response.status}: ${message}`);
      error.status = response.status;
      if (typeof parsed?.error?.code === 'string' && parsed.error.code) error.code = parsed.error.code;
      throw error;
    }
    const envelope = await response.json();
    const protocol = requireObject(envelope?.protocol, 'Agent Control protocol');
    if (protocol.version !== '1') {
      const error = new Error(`Agent Control protocol version ${protocol.version ?? 'unknown'} is incompatible; expected 1`);
      error.code = 'task_protocol_incompatible';
      throw error;
    }
    const identified = await this.#command('identify');
    const agent = requireObject(identified?.agent, 'identify result agent');
    if (agent.agent_id !== this.agentId) {
      const error = new Error(`Agent Control identify returned Agent ${agent.agent_id ?? 'unknown'}, expected ${this.agentId}`);
      error.code = 'agent_identity_mismatch';
      throw error;
    }
    return {
      protocol_version: protocol.version,
      agent_id: agent.agent_id,
      presence: nonEmptyString(identified?.health?.presence) ? identified.health.presence : null
    };
  }

  async #command(operation, { taskId = null, assignmentId = null, executionId = null, input = {} } = {}) {
    const body = {
      agent_id: this.agentId,
      operation,
      ...(taskId ? { task_id: taskId } : {}),
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      ...(executionId ? { execution_id: executionId } : {}),
      input
    };
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetchImpl(`${this.baseUrl}/v1/agent-control/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const raw = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* keep raw response text */ }
      const message = parsed?.error?.message ?? raw;
      const error = new Error(`Agent Control ${response.status}: ${message}`);
      error.status = response.status;
      if (typeof parsed?.error?.code === 'string' && parsed.error.code) error.code = parsed.error.code;
      throw error;
    }
    const envelope = await response.json();
    return envelope?.result ?? null;
  }

  getLease(taskId) {
    const lease = this.leases.get(taskId);
    return lease ? structuredClone(lease) : null;
  }

  restoreLease(taskId, persistedLease) {
    if (!nonEmptyString(taskId)) throw new TypeError('taskId is required to restore a lease');
    const lease = validateRestoredLease(persistedLease, this.agentId);
    this.leases.set(taskId, lease);
    return structuredClone(lease);
  }

  #requireLease(taskId) {
    const lease = this.leases.get(taskId);
    if (!lease) throw new Error(`Agent Control lease missing for ${taskId}`);
    return lease;
  }

  async claimTask() {
    const next = await this.#command('next');
    if (!next?.assignment) return null;
    const assignmentId = next.assignment.assignment_id;
    if (!nonEmptyString(assignmentId)) throw new TypeError('next assignment.assignment_id is required');

    const claimed = await this.#command('claim', { assignmentId });
    const task = claimed?.task ?? next.task;
    const claimedAssignment = requireObject(claimed?.assignment, 'claim result assignment');
    if (!nonEmptyString(task?.task_id)) throw new TypeError('claim result task.task_id is required');

    const started = await this.#command('start', {
      taskId: task.task_id,
      assignmentId,
      input: {
        executor_type: 'browser_extension',
        executor_ref: this.executorRef,
        summary: 'Starting browser execution',
        metadata: { surface: 'chatgpt.com' }
      }
    });
    const execution = requireObject(started?.execution, 'start result execution');
    if (!nonEmptyString(execution.execution_id)) throw new TypeError('start result execution.execution_id is required');
    const bootstrap = requireObject(started?.browser_execution_bootstrap, 'start result browser_execution_bootstrap');

    const lease = leaseFromAssignment(claimedAssignment, {
      agentId: this.agentId,
      executionId: execution.execution_id,
      nowMs: this.now()
    });
    this.leases.set(task.task_id, lease);
    return legacyCompatibleTask(started?.task ?? task, {
      agentId: this.agentId,
      assignmentId,
      executionId: execution.execution_id,
      bootstrap
    });
  }

  async heartbeatTask(taskId) {
    const current = this.#requireLease(taskId);
    const result = await this.#command('renew_lease', {
      assignmentId: current.assignment_id,
      input: { lease_token: current.token }
    });
    const renewed = leaseFromAssignment(result?.assignment, {
      agentId: this.agentId,
      executionId: current.execution_id,
      nowMs: this.now()
    });
    this.leases.set(taskId, renewed);
    return result;
  }

  reportProgress(taskId, event) {
    const lease = this.#requireLease(taskId);
    return this.#command('progress', {
      taskId,
      assignmentId: lease.assignment_id,
      executionId: lease.execution_id,
      input: {
        summary: nonEmptyString(event?.type) ? event.type : 'Browser execution progress',
        payload: structuredClone(event ?? {})
      }
    });
  }

  async reportArtifact(taskId, artifact) {
    const lease = this.#requireLease(taskId);
    const receipt = artifact?.transfer_receipt ?? {};
    const deliverableKey = nonEmptyString(artifact?.patch_key) ? artifact.patch_key : artifact?.filename;
    if (!nonEmptyString(deliverableKey)) throw new TypeError('Patch artifact patch_key or filename is required');
    const metadata = {
      filename: artifact.filename,
      patch_session_id: receipt.session_id ?? artifact.session_id ?? null,
      sequence: Number.isInteger(receipt.sequence) ? receipt.sequence : null,
      sha256: nonEmptyString(receipt.sha256) ? receipt.sha256 : null
    };
    const created = await this.#command('create_deliverable', {
      taskId,
      executionId: lease.execution_id,
      input: {
        deliverable_key: deliverableKey,
        deliverable_type: 'patch',
        metadata
      }
    });
    const deliverable = requireObject(created?.deliverable, 'create_deliverable result deliverable');
    const evidenceResult = await this.#command('submit_evidence', {
      taskId,
      executionId: lease.execution_id,
      input: {
        deliverable_id: deliverable.deliverable_id,
        evidence_type: 'artifact.report',
        payload: {
          transport: artifact?.transfer_mode ?? null,
          accepted: receipt.accepted === true,
          duplicate: receipt.duplicate === true,
          state: receipt.state ?? null,
          patch_session_id: receipt.session_id ?? artifact.session_id ?? null,
          sequence: Number.isInteger(receipt.sequence) ? receipt.sequence : null,
          parent_sequence: Number.isInteger(receipt.parent_sequence) ? receipt.parent_sequence : null,
          filename: receipt.filename ?? artifact.filename ?? null,
          sha256: receipt.sha256 ?? null
        }
      }
    });
    return { deliverable, evidence: evidenceResult?.evidence ?? null };
  }

  completionCheckTask(taskId, result = {}) {
    const lease = this.#requireLease(taskId);
    return this.#command('completion_check', {
      taskId,
      assignmentId: lease.assignment_id,
      executionId: lease.execution_id,
      input: {
        summary: 'Model reported DONE',
        payload: structuredClone(result ?? {})
      }
    });
  }


  waitingExternalTask(taskId, result = {}) {
    const lease = this.#requireLease(taskId);
    return this.#command('waiting_external', {
      taskId,
      assignmentId: lease.assignment_id,
      executionId: lease.execution_id,
      input: {
        summary: nonEmptyString(result?.reason) ? result.reason : 'Browser waiting for external state',
        payload: structuredClone(result ?? {})
      }
    });
  }

  waitingHumanTask(taskId, result = {}) {
    const lease = this.#requireLease(taskId);
    return this.#command('waiting_human', {
      taskId,
      assignmentId: lease.assignment_id,
      executionId: lease.execution_id,
      input: {
        summary: nonEmptyString(result?.reason) ? result.reason : 'Browser waiting for human action',
        payload: structuredClone(result ?? {})
      }
    });
  }

  async uploadArtifactContent() {
    throw new Error('Remote artifact upload is not available through Agent Control; PatchSync transport must be used');
  }

  async #terminalEvent(taskId, operation, payload) {
    const lease = this.#requireLease(taskId);
    const result = await this.#command(operation, {
      taskId,
      assignmentId: lease.assignment_id,
      executionId: lease.execution_id,
      input: {
        summary: nonEmptyString(payload?.code) ? payload.code : operation,
        payload: structuredClone(payload ?? {})
      }
    });
    this.leases.delete(taskId);
    return result;
  }

  async completeTask(taskId, result) {
    const lease = this.#requireLease(taskId);
    await this.#command('execution_completed', {
      taskId,
      assignmentId: lease.assignment_id,
      executionId: lease.execution_id,
      input: { summary: 'Browser execution completed', payload: structuredClone(result ?? {}) }
    });
    const completion = await this.#command('completion_requested', {
      taskId,
      assignmentId: lease.assignment_id,
      executionId: lease.execution_id,
      input: { summary: 'Browser requested Task completion', payload: structuredClone(result ?? {}) }
    });
    this.leases.delete(taskId);
    return completion;
  }

  contextLimitTask(taskId, result) { return this.#terminalEvent(taskId, 'execution_failed', result); }
  failTask(taskId, error) { return this.#terminalEvent(taskId, 'execution_failed', error); }
  releaseTask(taskId, reason) { return this.#terminalEvent(taskId, 'execution_failed', reason); }
}
