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
  async reportArtifact(taskId, artifact) { this.#event(taskId, { type: 'ARTIFACT', ...artifact }); return { artifact: structuredClone(artifact) }; }
  async completionCheckTask(taskId, result = {}) {
    const r = this.#get(taskId);
    const minimum = r.task.patch_goal?.minimum ?? null;
    const patchCount = Number.isInteger(result.task_patch_count)
      ? result.task_patch_count
      : r.events.filter(event => event.type === 'ARTIFACT').length;
    const directive = minimum && patchCount < minimum ? 'CONTINUE' : 'READY_TO_FINALIZE';
    const preview = {
      directive,
      status: directive === 'CONTINUE' ? 'unmet' : 'satisfied',
      summary: directive === 'CONTINUE'
        ? `Mock acceptance requires ${minimum} patches; current ${patchCount}`
        : 'Mock acceptance is ready for final completion',
      counts: { successful_patches: patchCount },
      unmet_criteria: directive === 'CONTINUE' ? ['min_successful_patches'] : []
    };
    r.events.push({ type: 'COMPLETION_CHECK', result: structuredClone(preview) });
    return preview;
  }
  async completeTask(taskId, result) {
    const r = this.#get(taskId);
    r.status = 'completed';
    r.events.push({ type: 'COMPLETED', result });
    return { task: { ...structuredClone(r.task), status: 'completed' }, acceptance_evaluation: { status: 'satisfied' } };
  }
  async contextLimitTask(taskId, result) { const r = this.#get(taskId); r.status = 'context_limit'; r.events.push({ type: 'CONTEXT_LIMIT', result }); }
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
