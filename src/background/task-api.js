export class TaskApi {
  async claimTask() { throw new Error('Not implemented'); }
  async heartbeatTask(_taskId) { throw new Error('Not implemented'); }
  async reportProgress(_taskId, _event) { throw new Error('Not implemented'); }
  async reportArtifact(_taskId, _artifact) { throw new Error('Not implemented'); }
  async completeTask(_taskId, _result) { throw new Error('Not implemented'); }
  async failTask(_taskId, _error) { throw new Error('Not implemented'); }
  async releaseTask(_taskId, _reason) { throw new Error('Not implemented'); }
}

export class HttpTaskApi extends TaskApi {
  constructor({ baseUrl, token = '' }) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async #request(path, init = {}) {
    const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`Task API ${response.status}: ${await response.text()}`);
    return response.json();
  }

  claimTask() { return this.#request('/tasks/claim', { method: 'POST' }); }
  heartbeatTask(taskId) { return this.#request(`/tasks/${encodeURIComponent(taskId)}/heartbeat`, { method: 'POST' }); }
  reportProgress(taskId, event) { return this.#request(`/tasks/${encodeURIComponent(taskId)}/progress`, { method: 'POST', body: JSON.stringify(event) }); }
  reportArtifact(taskId, artifact) { return this.#request(`/tasks/${encodeURIComponent(taskId)}/artifacts`, { method: 'POST', body: JSON.stringify(artifact) }); }
  completeTask(taskId, result) { return this.#request(`/tasks/${encodeURIComponent(taskId)}/complete`, { method: 'POST', body: JSON.stringify(result) }); }
  failTask(taskId, error) { return this.#request(`/tasks/${encodeURIComponent(taskId)}/fail`, { method: 'POST', body: JSON.stringify(error) }); }
  releaseTask(taskId, reason) { return this.#request(`/tasks/${encodeURIComponent(taskId)}/release`, { method: 'POST', body: JSON.stringify(reason) }); }
}
