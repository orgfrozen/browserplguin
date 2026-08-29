import { TaskApi } from './task-api.js';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalExecutionEpoch(value, label = 'execution_epoch') {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer when provided`);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} is required`);
  return value;
}

const LEASE_BOUND_PATCHSYNC_CAPABILITY_PROFILE = 'lease_bound_v2';

function leaseFromAssignment(assignment, { agentId, executionId, executionEpoch = null, patchSync = null, nowMs }) {
  requireObject(assignment, 'assignment');
  if (!nonEmptyString(assignment.lease_token)) throw new TypeError('assignment.lease_token is required');
  if (!nonEmptyString(assignment.lease_until) || Number.isNaN(Date.parse(assignment.lease_until))) {
    throw new TypeError('assignment.lease_until must be an ISO date-time');
  }
  if (!nonEmptyString(assignment.assignment_id)) throw new TypeError('assignment.assignment_id is required');
  if (!nonEmptyString(executionId)) throw new TypeError('execution_id is required');
  const ttlMs = Math.max(1000, Date.parse(assignment.lease_until) - nowMs);
  const epoch = optionalExecutionEpoch(executionEpoch);
  return {
    token: assignment.lease_token,
    ttl_ms: ttlMs,
    expires_at: assignment.lease_until,
    agent_id: agentId,
    assignment_id: assignment.assignment_id,
    execution_id: executionId,
    ...(epoch !== null ? { execution_epoch: epoch } : {}),
    ...(patchSync?.capability_profile === LEASE_BOUND_PATCHSYNC_CAPABILITY_PROFILE ? {
      patchsync_capability_profile: LEASE_BOUND_PATCHSYNC_CAPABILITY_PROFILE,
      ...(nonEmptyString(patchSync.access_token_expires_at) ? { patchsync_access_token_expires_at: patchSync.access_token_expires_at } : {})
    } : {})
  };
}

function validateRestoredLease(raw, agentId) {
  requireObject(raw, 'persisted lease');
  if (!nonEmptyString(raw.token)) throw new TypeError('persisted lease.token is required');
  if (!Number.isInteger(raw.ttl_ms) || raw.ttl_ms <= 0) throw new TypeError('persisted lease.ttl_ms must be a positive integer');
  if (!nonEmptyString(raw.assignment_id)) throw new TypeError('persisted lease.assignment_id is required');
  if (!nonEmptyString(raw.execution_id)) throw new TypeError('persisted lease.execution_id is required');
  optionalExecutionEpoch(raw.execution_epoch, 'persisted lease.execution_epoch');
  if (!nonEmptyString(raw.agent_id)) throw new TypeError('persisted lease.agent_id is required');
  if (raw.agent_id !== agentId) throw new TypeError(`persisted lease belongs to Agent ${raw.agent_id}, not ${agentId}`);
  if (raw.expires_at != null && (!nonEmptyString(raw.expires_at) || Number.isNaN(Date.parse(raw.expires_at)))) {
    throw new TypeError('persisted lease.expires_at must be an ISO date-time when provided');
  }
  return structuredClone(raw);
}

function legacyCompatibleTask(task, { agentId, assignmentId, executionId, executionEpoch = null, bootstrap }) {
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
      execution_id: executionId,
      ...(executionEpoch !== null ? { execution_epoch: optionalExecutionEpoch(executionEpoch) } : {})
    },
    browser_execution_bootstrap: structuredClone(bootstrap)
  };
}

const COMMAND_ID_OPERATIONS = new Set([
  'heartbeat', 'claim', 'renew_lease', 'start', 'progress', 'analysis_completed',
  'waiting_external', 'waiting_human', 'create_deliverable', 'submit_evidence',
  'execution_completed', 'execution_failed', 'reconcile_patch_session', 'completion_requested'
]);
const PENDING_COMMAND_STORAGE_KEY = 'pendingAgentCommands';
const PENDING_COMMAND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(item => normalizeJson(item));
  if (!value || typeof value !== 'object') return value;
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) normalized[key] = normalizeJson(value[key]);
  }
  return normalized;
}

async function commandFingerprint(body) {
  const serialized = JSON.stringify(normalizeJson(body));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateCommandId(value) {
  if (!nonEmptyString(value) || !/^cmd_[A-Za-z0-9._:-]{8,180}$/.test(value)) {
    throw new TypeError('commandIdFactory must return a valid cmd_ identifier');
  }
  return value;
}

class PendingAgentCommandStore {
  constructor(storage, { now = Date.now, key = PENDING_COMMAND_STORAGE_KEY } = {}) {
    this.storage = storage;
    this.now = now;
    this.key = key;
    this.mutationTail = Promise.resolve();
  }

  #mutate(operation) {
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  #prune(entries) {
    const nowMs = Number(this.now());
    if (!Number.isFinite(nowMs)) return entries;
    const next = {};
    for (const [fingerprint, entry] of Object.entries(entries)) {
      const createdAtMs = Number(entry?.created_at_ms);
      if (!nonEmptyString(entry?.command_id)) continue;
      if (Number.isFinite(createdAtMs) && nowMs - createdAtMs > PENDING_COMMAND_RETENTION_MS) continue;
      next[fingerprint] = entry;
    }
    return next;
  }

  async getOrCreate(fingerprint, factory) {
    return this.#mutate(async () => {
      const raw = await this.storage.get(this.key);
      const entries = this.#prune(raw && typeof raw === 'object' ? raw : {});
      const existing = entries[fingerprint];
      if (nonEmptyString(existing?.command_id)) {
        if (JSON.stringify(raw ?? {}) !== JSON.stringify(entries)) await this.storage.set(this.key, entries);
        return existing.command_id;
      }
      const commandId = validateCommandId(factory());
      entries[fingerprint] = { command_id: commandId, created_at_ms: Number(this.now()) };
      await this.storage.set(this.key, entries);
      return commandId;
    });
  }

  async clear(fingerprint, commandId) {
    return this.#mutate(async () => {
      const raw = await this.storage.get(this.key);
      const entries = this.#prune(raw && typeof raw === 'object' ? raw : {});
      if (entries[fingerprint]?.command_id === commandId) delete entries[fingerprint];
      if (Object.keys(entries).length === 0) {
        if (typeof this.storage.remove === 'function') await this.storage.remove(this.key);
        else await this.storage.set(this.key, {});
      } else {
        await this.storage.set(this.key, entries);
      }
    });
  }
}

const CLAIM_GATES = new Map();

async function withClaimGate(key, operation) {
  const previous = CLAIM_GATES.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  CLAIM_GATES.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (CLAIM_GATES.get(key) === tail) CLAIM_GATES.delete(key);
  }
}

export class AgentControlTaskApi extends TaskApi {
  constructor({ baseUrl, token = '', agentId, executorRef = 'browser-extension', fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, claimMode = 'resume_or_next', onCommand = null, commandStorage = null, commandIdFactory = () => `cmd_${crypto.randomUUID()}` }) {
    super();
    if (!nonEmptyString(baseUrl)) throw new TypeError('baseUrl is required');
    if (!nonEmptyString(agentId)) throw new TypeError('agentId is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.agentId = agentId;
    this.executorRef = executorRef;
    this.fetchImpl = fetchImpl;
    this.now = now;
    if (!['resume_or_next', 'next_only'].includes(claimMode)) throw new TypeError('claimMode must be resume_or_next or next_only');
    this.claimMode = claimMode;
    this.onCommand = typeof onCommand === 'function' ? onCommand : null;
    if (commandStorage != null && (typeof commandStorage.get !== 'function' || typeof commandStorage.set !== 'function')) {
      throw new TypeError('commandStorage must implement get/set when provided');
    }
    if (typeof commandIdFactory !== 'function') throw new TypeError('commandIdFactory must be a function');
    this.commandIds = commandStorage ? new PendingAgentCommandStore(commandStorage, { now }) : null;
    this.commandIdFactory = commandIdFactory;
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

  async #controlRequest(path, init = {}) {
    const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const raw = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* keep raw response text */ }
      const message = parsed?.error?.message ?? raw;
      const error = new Error(`Control Plane ${response.status}: ${message}`);
      error.status = response.status;
      if (typeof parsed?.error?.code === 'string' && parsed.error.code) error.code = parsed.error.code;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  #commandObservedAt() {
    const value = Number(this.now());
    return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
  }

  async #observeCommand(event) {
    if (!this.onCommand) return;
    try { await this.onCommand(structuredClone(event)); } catch { /* diagnostics must never block control flow */ }
  }

  async #command(operation, { taskId = null, assignmentId = null, executionId = null, executionEpoch = null, input = {} } = {}) {
    if (executionId && executionEpoch == null && taskId) {
      const lease = this.leases.get(taskId);
      if (lease?.execution_id === executionId) executionEpoch = optionalExecutionEpoch(lease.execution_epoch);
    }
    executionEpoch = optionalExecutionEpoch(executionEpoch);
    let body = {
      agent_id: this.agentId,
      operation,
      ...(taskId ? { task_id: taskId } : {}),
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      ...(executionId ? { execution_id: executionId } : {}),
      ...(executionEpoch !== null ? { execution_epoch: executionEpoch } : {}),
      input
    };
    let pendingCommand = null;
    if (this.commandIds && COMMAND_ID_OPERATIONS.has(operation)) {
      const fingerprint = await commandFingerprint(body);
      const commandId = await this.commandIds.getOrCreate(fingerprint, this.commandIdFactory);
      pendingCommand = { fingerprint, commandId };
      body = { command_id: commandId, ...body };
    }
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const baseEvent = {
      operation,
      ...(pendingCommand ? { command_id: pendingCommand.commandId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      ...(executionId ? { execution_id: executionId } : {}),
      ...(executionEpoch !== null ? { execution_epoch: executionEpoch } : {})
    };
    if (this.onCommand) await this.#observeCommand({ ...baseEvent, phase: 'started', at: this.#commandObservedAt() });
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/agent-control/commands`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (this.onCommand) await this.#observeCommand({
        ...baseEvent,
        phase: 'failed',
        at: this.#commandObservedAt(),
        error_code: typeof error?.code === 'string' ? error.code : 'NETWORK_ERROR'
      });
      throw error;
    }
    if (!response.ok) {
      const raw = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* keep raw response text */ }
      const message = parsed?.error?.message ?? raw;
      const error = new Error(`Agent Control ${response.status}: ${message}`);
      error.status = response.status;
      if (typeof parsed?.error?.code === 'string' && parsed.error.code) error.code = parsed.error.code;
      if (pendingCommand && !['agent_command_in_progress', 'agent_command_id_conflict'].includes(error.code)) {
        await this.commandIds.clear(pendingCommand.fingerprint, pendingCommand.commandId);
      }
      if (this.onCommand) await this.#observeCommand({
        ...baseEvent,
        phase: 'failed',
        at: this.#commandObservedAt(),
        http_status: response.status,
        error_code: typeof error.code === 'string' ? error.code : 'UNEXPECTED'
      });
      throw error;
    }
    const envelope = await response.json();
    if (pendingCommand) await this.commandIds.clear(pendingCommand.fingerprint, pendingCommand.commandId);
    const result = envelope?.result ?? null;
    if (this.onCommand) await this.#observeCommand({
      ...baseEvent,
      phase: 'succeeded',
      at: this.#commandObservedAt(),
      http_status: response.status,
      assignment_found: Boolean(result?.assignment),
      ...(result?.task?.task_id ? { task_id: result.task.task_id } : {}),
      ...(result?.assignment?.assignment_id ? { assignment_id: result.assignment.assignment_id } : {}),
      ...(result?.execution?.execution_id ? { execution_id: result.execution.execution_id } : {})
    });
    return result;
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

  async #startClaimedAssignment({ assignment, task }, label = 'current') {
    const claimedAssignment = requireObject(assignment, `${label} assignment`);
    const assignmentId = claimedAssignment.assignment_id;
    if (!nonEmptyString(assignmentId)) throw new TypeError(`${label} assignment.assignment_id is required`);
    if (!nonEmptyString(task?.task_id)) throw new TypeError(`${label} task.task_id is required`);

    const started = await this.#command('start', {
      taskId: task.task_id,
      assignmentId,
      input: {
        executor_type: 'browser_extension',
        executor_ref: this.executorRef,
        summary: 'Starting browser execution',
        metadata: { surface: 'chatgpt.com' },
        patchsync_capability_profile: LEASE_BOUND_PATCHSYNC_CAPABILITY_PROFILE
      }
    });
    const execution = requireObject(started?.execution, 'start result execution');
    if (!nonEmptyString(execution.execution_id)) throw new TypeError('start result execution.execution_id is required');
    const bootstrap = requireObject(started?.browser_execution_bootstrap, 'start result browser_execution_bootstrap');
    const executionEpoch = optionalExecutionEpoch(execution.execution_epoch, 'start result execution.execution_epoch');
    const bootstrapEpoch = optionalExecutionEpoch(bootstrap?.execution?.execution_epoch, 'browser_execution_bootstrap.execution.execution_epoch');
    if (executionEpoch !== null && bootstrapEpoch !== null && executionEpoch !== bootstrapEpoch) {
      throw new TypeError('start result execution epoch does not match browser execution bootstrap');
    }
    const effectiveExecutionEpoch = executionEpoch ?? bootstrapEpoch;

    const lease = leaseFromAssignment(claimedAssignment, {
      agentId: this.agentId,
      executionId: execution.execution_id,
      executionEpoch: effectiveExecutionEpoch,
      patchSync: bootstrap?.patchsync ?? null,
      nowMs: this.now()
    });
    this.leases.set(task.task_id, lease);
    return legacyCompatibleTask(started?.task ?? task, {
      agentId: this.agentId,
      assignmentId,
      executionId: execution.execution_id,
      executionEpoch: effectiveExecutionEpoch,
      bootstrap
    });
  }

  async getCurrentTask() {
    return this.#command('current');
  }

  async resumeCurrentTask() {
    const current = await this.getCurrentTask();
    if (!current?.assignment) return null;
    return this.#startClaimedAssignment(current, 'current');
  }

  async claimTask() {
    const gateKey = `${this.baseUrl}\n${this.agentId}`;
    return withClaimGate(gateKey, async () => {
      if (this.claimMode !== 'next_only') {
        const current = await this.resumeCurrentTask();
        if (current) return current;
      }

      const next = await this.#command('next');
      if (!next?.assignment) return null;
      const assignmentId = next.assignment.assignment_id;
      if (!nonEmptyString(assignmentId)) throw new TypeError('next assignment.assignment_id is required');

      const claimed = await this.#command('claim', { assignmentId });
      const task = claimed?.task ?? next.task;
      const claimedAssignment = requireObject(claimed?.assignment, 'claim result assignment');
      return this.#startClaimedAssignment({ assignment: claimedAssignment, task }, 'claim result');
    });
  }

  heartbeatAgent({ condition = 'healthy', diagnostics = {} } = {}) {
    return this.#command('heartbeat', {
      input: {
        condition,
        diagnostics: structuredClone(diagnostics ?? {})
      }
    });
  }

  async refreshPatchSyncCapability(taskId) {
    const current = this.#requireLease(taskId);
    return this.#command('refresh_patchsync_capability', {
      taskId,
      assignmentId: current.assignment_id,
      executionId: current.execution_id,
      executionEpoch: current.execution_epoch ?? null
    });
  }

  async heartbeatTask(taskId) {
    const current = this.#requireLease(taskId);
    const result = await this.#command('renew_lease', {
      assignmentId: current.assignment_id,
      input: { lease_token: current.token }
    });
    let renewed = leaseFromAssignment(result?.assignment, {
      agentId: this.agentId,
      executionId: current.execution_id,
      executionEpoch: current.execution_epoch ?? null,
      patchSync: current.patchsync_capability_profile === LEASE_BOUND_PATCHSYNC_CAPABILITY_PROFILE ? {
        capability_profile: current.patchsync_capability_profile,
        access_token_expires_at: current.patchsync_access_token_expires_at ?? null
      } : null,
      nowMs: this.now()
    });
    this.leases.set(taskId, renewed);
    if (current.patchsync_capability_profile !== LEASE_BOUND_PATCHSYNC_CAPABILITY_PROFILE) return result;

    try {
      const refreshed = await this.refreshPatchSyncCapability(taskId);
      const patchsync = refreshed?.patchsync ?? null;
      if (patchsync?.capability_profile === LEASE_BOUND_PATCHSYNC_CAPABILITY_PROFILE) {
        renewed = {
          ...renewed,
          patchsync_capability_profile: LEASE_BOUND_PATCHSYNC_CAPABILITY_PROFILE,
          ...(nonEmptyString(patchsync.access_token_expires_at) ? { patchsync_access_token_expires_at: patchsync.access_token_expires_at } : {})
        };
        this.leases.set(taskId, renewed);
      }
      return { ...result, ...(patchsync ? { patchsync: structuredClone(patchsync) } : {}) };
    } catch (error) {
      return {
        ...result,
        patchsync_refresh_error: {
          code: typeof error?.code === 'string' ? error.code : 'PATCHSYNC_CAPABILITY_REFRESH_FAILED',
          message: String(error?.message ?? error)
        }
      };
    }
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

  async preparePatchArtifact(taskId, artifact) {
    const lease = this.#requireLease(taskId);
    const filename = artifact?.filename;
    const deliverableKey = nonEmptyString(artifact?.deliverable_key) ? artifact.deliverable_key : nonEmptyString(artifact?.patch_key) ? artifact.patch_key : filename;
    const deliverableFilename = nonEmptyString(artifact?.deliverable_filename) ? artifact.deliverable_filename : filename;
    const patchSessionId = artifact?.patch_session_id;
    const sequence = artifact?.sequence;
    if (!nonEmptyString(filename)) throw new TypeError('Expected Patch filename is required');
    if (!nonEmptyString(deliverableKey)) throw new TypeError('Expected Patch patch_key or filename is required');
    if (!nonEmptyString(patchSessionId)) throw new TypeError('Expected Patch patch_session_id is required');
    if (!Number.isInteger(sequence) || sequence < 0) throw new TypeError('Expected Patch sequence must be a non-negative integer');
    const created = await this.#command('create_deliverable', {
      taskId,
      executionId: lease.execution_id,
      input: {
        deliverable_key: deliverableKey,
        deliverable_type: 'patch',
        metadata: { filename: deliverableFilename, patch_session_id: patchSessionId, sequence }
      }
    });
    return {
      deliverable: requireObject(created?.deliverable, 'create_deliverable result deliverable'),
      created: created?.created === true
    };
  }

  async reportArtifact(taskId, artifact) {
    const lease = this.#requireLease(taskId);
    const receipt = artifact?.transfer_receipt ?? {};
    const deliverableKey = nonEmptyString(artifact?.deliverable_key) ? artifact.deliverable_key : nonEmptyString(artifact?.patch_key) ? artifact.patch_key : artifact?.filename;
    if (!nonEmptyString(deliverableKey)) throw new TypeError('Patch artifact patch_key or filename is required');
    const deliverableFilename = nonEmptyString(artifact?.deliverable_filename) ? artifact.deliverable_filename : artifact.filename;
    const metadata = {
      filename: deliverableFilename,
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

  reconcilePatchSession(taskId, patchSessionId) {
    const lease = this.#requireLease(taskId);
    if (!nonEmptyString(patchSessionId)) throw new TypeError('patchSessionId is required');
    return this.#command('reconcile_patch_session', {
      taskId,
      assignmentId: lease.assignment_id,
      executionId: lease.execution_id,
      input: { patch_session_id: patchSessionId }
    });
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

  reconcileExecutionTask(taskId, result = {}) {
    const lease = this.#requireLease(taskId);
    return this.#command('reconcile_execution', {
      taskId,
      assignmentId: lease.assignment_id,
      executionId: lease.execution_id,
      input: {
        patch_session_id: nonEmptyString(result?.patch_session_id) ? result.patch_session_id : null,
        local_phase: nonEmptyString(result?.local_phase) ? result.local_phase : ''
      }
    });
  }

  async startContinuationTask(taskId, nextAssignment, task) {
    if (!nonEmptyString(taskId)) throw new TypeError('taskId is required');
    const taskRecord = requireObject(task, 'continuation task');
    if (taskRecord.task_id !== taskId) throw new TypeError('continuation task.task_id does not match taskId');
    let assignment = requireObject(nextAssignment, 'continuation assignment');
    if (assignment.task_id && assignment.task_id !== taskId) throw new TypeError('continuation assignment.task_id does not match taskId');
    if (assignment.status === 'ready') {
      const claimed = await this.#command('claim', { assignmentId: assignment.assignment_id });
      assignment = requireObject(claimed?.assignment, 'continuation claim result assignment');
    } else if (assignment.status !== 'claimed') {
      throw new TypeError(`continuation assignment must be ready or claimed, got ${assignment.status ?? 'unknown'}`);
    }
    return this.#startClaimedAssignment({ assignment, task: taskRecord }, 'continuation');
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

  async cancelTask(taskId, { reason = 'Terminated by BrowserPlugin operator' } = {}) {
    const result = await this.#controlRequest(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
    this.leases.delete(taskId);
    return result;
  }

  contextLimitTask(taskId, result) { return this.#terminalEvent(taskId, 'execution_failed', result); }
  failTask(taskId, error) { return this.#terminalEvent(taskId, 'execution_failed', error); }
  releaseTask(taskId, reason) { return this.#terminalEvent(taskId, 'execution_failed', reason); }
}
