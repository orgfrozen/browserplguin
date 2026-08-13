import { normalizeTask } from '../shared/task-schema.js';

export class MockTaskApi {
  constructor(tasks = []) {
    this.tasks = new Map(tasks.map(raw => {
      const task = normalizeTask(raw);
      return [task.task_id, { task, status: 'ready', events: [] }];
    }));
  }

  async claimTask() {
    for (const record of this.tasks.values()) {
      if (record.status === 'ready') {
        record.status = 'locked';
        record.events.push({ type: 'CLAIMED', at: Date.now() });
        return structuredClone(record.task);
      }
    }
    return null;
  }

  async heartbeatTask(taskId) { this.#event(taskId, { type: 'HEARTBEAT', at: Date.now() }); }
  async reportProgress(taskId, event) { this.#event(taskId, event); }
  async reportArtifact(taskId, artifact) { this.#event(taskId, { type: 'ARTIFACT', ...artifact }); }
  async completeTask(taskId, result) { const r = this.#get(taskId); r.status = 'completed'; r.events.push({ type: 'COMPLETED', result }); }
  async failTask(taskId, error) { const r = this.#get(taskId); r.status = 'failed'; r.events.push({ type: 'FAILED', error }); }
  async releaseTask(taskId, reason) { const r = this.#get(taskId); r.status = 'ready'; r.events.push({ type: 'RELEASED', reason }); }

  #get(taskId) {
    const record = this.tasks.get(taskId);
    if (!record) throw new Error(`Unknown mock task ${taskId}`);
    return record;
  }

  #event(taskId, event) { this.#get(taskId).events.push(structuredClone(event)); }

  getSnapshot() {
    return {
      tasks: Object.fromEntries([...this.tasks.entries()].map(([id, r]) => [id, structuredClone({ status: r.status, task: r.task, events: r.events })]))
    };
  }
}
