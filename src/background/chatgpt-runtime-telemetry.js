export const CHATGPT_RUNTIME_TELEMETRY_STATE_KEY = 'chatgptRuntimeTelemetry';

const START_WINDOW_MS = 15 * 60 * 1000;
const ACTIVE_STALE_MS = 30 * 60 * 1000;
const MAX_START_EVENTS = 200;

function safeGenerationEvent(value = {}) {
  return {
    slot_id: typeof value.slot_id === 'string' ? value.slot_id : null,
    tab_id: Number.isInteger(Number(value.tab_id)) ? Number(value.tab_id) : null,
    task_id: typeof value.task_id === 'string' ? value.task_id : null,
    type: typeof value.type === 'string' ? value.type : 'unknown',
    started_at: typeof value.started_at === 'string' ? value.started_at : null
  };
}

function pruneState(state, nowMs) {
  const active = Array.isArray(state?.active_generations) ? state.active_generations : [];
  const starts = Array.isArray(state?.prompt_starts) ? state.prompt_starts : [];
  return {
    active_generations: active
      .map(safeGenerationEvent)
      .filter(item => {
        const startedMs = Date.parse(item.started_at ?? '');
        return Number.isFinite(startedMs) && nowMs - startedMs >= 0 && nowMs - startedMs <= ACTIVE_STALE_MS;
      }),
    prompt_starts: starts
      .map(safeGenerationEvent)
      .filter(item => {
        const startedMs = Date.parse(item.started_at ?? '');
        return Number.isFinite(startedMs) && nowMs - startedMs >= 0 && nowMs - startedMs <= START_WINDOW_MS;
      })
      .slice(-MAX_START_EVENTS),
    last_generation_event: state?.last_generation_event && typeof state.last_generation_event === 'object'
      ? structuredClone(state.last_generation_event)
      : null,
    last_access_signal: state?.last_access_signal && typeof state.last_access_signal === 'object'
      ? structuredClone(state.last_access_signal)
      : null
  };
}

function startsWithin(events, nowMs, windowMs) {
  return events.filter(item => {
    const startedMs = Date.parse(item.started_at ?? '');
    return Number.isFinite(startedMs) && nowMs - startedMs >= 0 && nowMs - startedMs <= windowMs;
  }).length;
}

export function buildChatGptRuntimeTelemetrySnapshot(value, now = () => new Date()) {
  const nowValue = now();
  const nowMs = (nowValue instanceof Date ? nowValue : new Date(nowValue)).getTime();
  const state = pruneState(value ?? {}, nowMs);
  return {
    active_generation_count: state.active_generations.length,
    active_generations: state.active_generations.map(item => structuredClone(item)),
    prompt_starts_last_1m: startsWithin(state.prompt_starts, nowMs, 60 * 1000),
    prompt_starts_last_5m: startsWithin(state.prompt_starts, nowMs, 5 * 60 * 1000),
    prompt_starts_last_15m: startsWithin(state.prompt_starts, nowMs, 15 * 60 * 1000),
    last_generation_event: state.last_generation_event ? structuredClone(state.last_generation_event) : null,
    last_access_signal: state.last_access_signal ? structuredClone(state.last_access_signal) : null
  };
}

export class ChatGptRuntimeTelemetry {
  constructor({ storage, now = () => new Date(), key = CHATGPT_RUNTIME_TELEMETRY_STATE_KEY } = {}) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') throw new TypeError('storage is required');
    this.storage = storage;
    this.now = now;
    this.key = key;
    this.mutationTail = Promise.resolve();
  }

  async #mutate(mutator) {
    const run = async () => {
      const nowValue = this.now();
      const nowMs = (nowValue instanceof Date ? nowValue : new Date(nowValue)).getTime();
      const current = pruneState((await this.storage.get(this.key)) ?? {}, nowMs);
      const next = await mutator(current, (nowValue instanceof Date ? nowValue : new Date(nowValue)).toISOString());
      const normalized = pruneState(next ?? current, nowMs);
      await this.storage.set(this.key, normalized);
      return buildChatGptRuntimeTelemetrySnapshot(normalized, () => new Date(nowMs));
    };
    const pending = this.mutationTail.then(run, run);
    this.mutationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async recordPromptSubmitted({ slotId, tabId, taskId = null, type = 'unknown' } = {}) {
    return this.#mutate((current, submittedAt) => {
      const event = safeGenerationEvent({ slot_id: slotId, tab_id: tabId, task_id: taskId, type, started_at: submittedAt });
      return {
        ...current,
        prompt_starts: [...current.prompt_starts, event].slice(-MAX_START_EVENTS),
        last_generation_event: { phase: 'submitted', ...event }
      };
    });
  }

  async recordGenerationStart({ slotId, tabId, taskId = null, type = 'unknown' } = {}) {
    return this.#mutate((current, startedAt) => {
      const event = safeGenerationEvent({ slot_id: slotId, tab_id: tabId, task_id: taskId, type, started_at: startedAt });
      const active = current.active_generations.filter(item => item.slot_id !== event.slot_id);
      active.push(event);
      return {
        ...current,
        active_generations: active,
        last_generation_event: { phase: 'started', ...event }
      };
    });
  }

  async recordGenerationEnd({ slotId, tabId, taskId = null, type = 'unknown', outcome = 'finished' } = {}) {
    return this.#mutate((current, finishedAt) => ({
      ...current,
      active_generations: current.active_generations.filter(item => {
        if (typeof slotId === 'string' && item.slot_id !== slotId) return true;
        if (Number.isInteger(Number(tabId)) && item.tab_id !== Number(tabId)) return true;
        return false;
      }),
      last_generation_event: {
        phase: 'finished',
        slot_id: typeof slotId === 'string' ? slotId : null,
        tab_id: Number.isInteger(Number(tabId)) ? Number(tabId) : null,
        task_id: typeof taskId === 'string' ? taskId : null,
        type: typeof type === 'string' ? type : 'unknown',
        outcome: typeof outcome === 'string' ? outcome : 'finished',
        finished_at: finishedAt
      }
    }));
  }

  async recordAccessSignal({ slotId, tabId, taskId = null, accessState = null } = {}) {
    let evidence = null;
    await this.#mutate((current, detectedAt) => {
      const advisory = accessState?.advisory && typeof accessState.advisory === 'object' ? accessState.advisory : null;
      const snapshot = buildChatGptRuntimeTelemetrySnapshot(current, () => new Date(detectedAt));
      evidence = {
        detected_at: detectedAt,
        slot_id: typeof slotId === 'string' ? slotId : null,
        tab_id: Number.isInteger(Number(tabId)) ? Number(tabId) : null,
        task_id: typeof taskId === 'string' ? taskId : null,
        access_status: typeof accessState?.status === 'string' ? accessState.status : null,
        detector: typeof (advisory?.kind ?? accessState?.reason) === 'string' ? (advisory?.kind ?? accessState.reason) : null,
        visible: advisory?.visible === true,
        composer_present: typeof advisory?.composer_present === 'boolean' ? advisory.composer_present : null,
        active_generation_count: snapshot.active_generation_count,
        prompt_starts_last_1m: snapshot.prompt_starts_last_1m,
        prompt_starts_last_5m: snapshot.prompt_starts_last_5m,
        prompt_starts_last_15m: snapshot.prompt_starts_last_15m
      };
      return { ...current, last_access_signal: evidence };
    });
    return evidence;
  }

  async snapshot() {
    return buildChatGptRuntimeTelemetrySnapshot(await this.storage.get(this.key), this.now);
  }
}
