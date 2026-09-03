export class TaskApi {
  async claimTask() { throw new Error('Not implemented'); }
  async resumeCurrentTask() { return null; }
  async getCurrentTask() { return null; }
  async heartbeatTask(_taskId) { throw new Error('Not implemented'); }
  async reportProgress(_taskId, _event) { throw new Error('Not implemented'); }
  async analysisCompletedTask(taskId, result = {}) { return this.reportProgress(taskId, { type: 'ANALYSIS_COMPLETED', ...structuredClone(result) }); }
  async reportArtifact(_taskId, _artifact) { throw new Error('Not implemented'); }
  async completionCheckTask(_taskId, _result) { throw new Error('Not implemented'); }
  async reconcileExecutionTask(_taskId, _result) { return null; }
  async startContinuationTask(_taskId, _assignment, _task) { throw new Error('Not implemented'); }
  async waitingExternalTask(_taskId, _result) { throw new Error('Not implemented'); }
  async waitingHumanTask(_taskId, _result) { throw new Error('Not implemented'); }
  async uploadArtifactContent(_taskId, _artifact) { throw new Error('Not implemented'); }
  async completeTask(_taskId, _result) { throw new Error('Not implemented'); }
  async cancelTask(_taskId, _result) { throw new Error('Not implemented'); }
  async contextLimitTask(_taskId, _result) { throw new Error('Not implemented'); }
  async failTask(_taskId, _error) { throw new Error('Not implemented'); }
  async releaseTask(_taskId, _reason) { throw new Error('Not implemented'); }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateLease(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('claim response lease is required');
  if (!nonEmptyString(raw.token)) throw new TypeError('claim response lease.token is required');
  if (!Number.isInteger(raw.ttl_ms) || raw.ttl_ms <= 0) throw new TypeError('claim response lease.ttl_ms must be a positive integer');
  if (raw.expires_at != null && (!nonEmptyString(raw.expires_at) || Number.isNaN(Date.parse(raw.expires_at)))) {
    throw new TypeError('claim response lease.expires_at must be an ISO date-time when provided');
  }
  return {
    token: raw.token,
    ttl_ms: raw.ttl_ms,
    ...(raw.expires_at != null ? { expires_at: raw.expires_at } : {})
  };
}

function validateClaimEnvelope(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('claim response must be an object');
  if (!raw.task || typeof raw.task !== 'object' || !nonEmptyString(raw.task.task_id)) {
    throw new TypeError('claim response task.task_id is required');
  }
  return { task: raw.task, lease: validateLease(raw.lease) };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function idempotencyKey(taskId, path, body) {
  return `browserplguin:${taskId}:${stableHash(`${path}\n${body ?? ''}`)}`;
}

export class HttpTaskApi extends TaskApi {
  constructor({ baseUrl, token = '', fetchImpl = fetch }) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.leases = new Map();
  }

  getLease(taskId) {
    const lease = this.leases.get(taskId);
    return lease ? structuredClone(lease) : null;
  }

  restoreLease(taskId, persistedLease) {
    if (!nonEmptyString(taskId)) throw new TypeError('taskId is required to restore a lease');
    const lease = validateLease(persistedLease);
    this.leases.set(taskId, lease);
    return structuredClone(lease);
  }

  async #request(path, init = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Task-Protocol-Version': '1', ...(init.headers ?? {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (response.status === 204) return null;
    if (!response.ok) {
      const error = new Error(`Task API ${response.status}: ${await response.text()}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  #leaseHeaders(taskId, { idempotent = false, path = '', body = '' } = {}) {
    const lease = this.leases.get(taskId);
    if (!lease) throw new Error(`Task API lease missing for ${taskId}`);
    const headers = { 'X-Task-Lease-Token': lease.token };
    if (idempotent) headers['Idempotency-Key'] = idempotencyKey(taskId, path, body);
    return headers;
  }

  async #taskWrite(taskId, path, payload, { terminal = false } = {}) {
    const body = JSON.stringify(payload);
    const idempotencyBody = canonicalJson(payload);
    const result = await this.#request(path, {
      method: 'POST',
      headers: this.#leaseHeaders(taskId, { idempotent: true, path, body: idempotencyBody }),
      body
    });
    if (terminal) this.leases.delete(taskId);
    return result;
  }

  async claimTask() {
    const raw = await this.#request('/tasks/claim', { method: 'POST' });
    if (raw == null) return null;
    const { task, lease } = validateClaimEnvelope(raw);
    this.leases.set(task.task_id, lease);
    return task;
  }

  async heartbeatTask(taskId) {
    const path = `/tasks/${encodeURIComponent(taskId)}/heartbeat`;
    const result = await this.#request(path, {
      method: 'POST',
      headers: this.#leaseHeaders(taskId)
    });
    if (result?.lease) this.leases.set(taskId, validateLease(result.lease));
    return result;
  }

  reportProgress(taskId, event) {
    const path = `/tasks/${encodeURIComponent(taskId)}/progress`;
    return this.#taskWrite(taskId, path, event);
  }

  reportArtifact(taskId, artifact) {
    const path = `/tasks/${encodeURIComponent(taskId)}/artifacts`;
    return this.#taskWrite(taskId, path, artifact);
  }

  uploadArtifactContent(taskId, artifact) {
    const path = `/tasks/${encodeURIComponent(taskId)}/artifacts/upload`;
    return this.#taskWrite(taskId, path, artifact);
  }

  completeTask(taskId, result) {
    const path = `/tasks/${encodeURIComponent(taskId)}/complete`;
    return this.#taskWrite(taskId, path, result, { terminal: true });
  }

  contextLimitTask(taskId, result) {
    const path = `/tasks/${encodeURIComponent(taskId)}/context-limit`;
    return this.#taskWrite(taskId, path, result, { terminal: true });
  }

  failTask(taskId, error) {
    const path = `/tasks/${encodeURIComponent(taskId)}/fail`;
    return this.#taskWrite(taskId, path, error, { terminal: true });
  }

  releaseTask(taskId, reason) {
    const path = `/tasks/${encodeURIComponent(taskId)}/release`;
    return this.#taskWrite(taskId, path, reason, { terminal: true });
  }
}
