export const AGENT_HEARTBEAT_ALARM_NAME = 'browser-agent-heartbeat';
export const MIN_AGENT_HEARTBEAT_INTERVAL_MS = 30000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeIntervalMs(value, fallbackMs) {
  const parsed = Number(value);
  const fallback = Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : MIN_AGENT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(MIN_AGENT_HEARTBEAT_INTERVAL_MS, Math.round(fallback));
  return Math.max(MIN_AGENT_HEARTBEAT_INTERVAL_MS, Math.round(parsed));
}


function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function buildAgentInfrastructureDiagnostics(runtimeStatus = {}) {
  const raw = runtimeStatus?.infrastructure_circuit;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (raw.state === 'closed') return { infrastructure_circuit: { state: 'closed' } };
  if (raw.state !== 'open') return {};
  const service = raw.service === 'patchsync' || raw.service === 'control_plane' ? raw.service : 'unknown';
  const operation = typeof raw.last_operation === 'string' && raw.last_operation.trim()
    ? raw.last_operation.trim().slice(0, 120)
    : null;
  const retryAt = typeof raw.retry_at === 'string' && raw.retry_at.trim()
    ? raw.retry_at.trim().slice(0, 64)
    : null;
  const errorCode = typeof raw.last_error_code === 'string' && raw.last_error_code.trim()
    ? raw.last_error_code.trim().slice(0, 120)
    : null;
  return {
    infrastructure_circuit: {
      state: 'open',
      service,
      operation,
      retry_at: retryAt,
      last_error_code: errorCode
    }
  };
}

export function buildAgentCapacityDiagnostics(runtimeStatus = {}) {
  const configured = positiveInteger(runtimeStatus?.max_parallel_tasks);
  const reportedEffective = positiveInteger(runtimeStatus?.effective_parallel_tasks);
  if (!configured || !reportedEffective) return {};
  const effective = Math.min(configured, reportedEffective);
  const state = typeof runtimeStatus?.adaptive_backpressure?.state === 'string'
    ? runtimeStatus.adaptive_backpressure.state
    : 'normal';
  const reasons = Array.isArray(runtimeStatus?.adaptive_backpressure?.reasons)
    ? runtimeStatus.adaptive_backpressure.reasons.filter(value => typeof value === 'string' && value.length > 0)
    : [];
  return {
    configured_parallel_tasks: configured,
    effective_parallel_tasks: effective,
    capacity_state: state,
    capacity_reasons: reasons
  };
}

function readySettings(settings) {
  return settings?.mode === 'real'
    && nonEmptyString(settings.taskApiBaseUrl)
    && nonEmptyString(settings.agentId);
}

export class AgentHeartbeatManager {
  constructor({
    alarms,
    createTaskApi,
    loadSettings,
    loadDiagnostics = null,
    defaultIntervalMs = MIN_AGENT_HEARTBEAT_INTERVAL_MS,
    now = Date.now,
    logger = console
  }) {
    if (!alarms || typeof alarms.create !== 'function' || typeof alarms.clear !== 'function') {
      throw new TypeError('alarms.create and alarms.clear are required');
    }
    if (typeof createTaskApi !== 'function') throw new TypeError('createTaskApi is required');
    if (typeof loadSettings !== 'function') throw new TypeError('loadSettings is required');
    this.alarms = alarms;
    this.createTaskApi = createTaskApi;
    this.loadSettings = loadSettings;
    this.loadDiagnostics = typeof loadDiagnostics === 'function' ? loadDiagnostics : null;
    this.defaultIntervalMs = defaultIntervalMs;
    this.now = now;
    this.logger = logger;
    this.lastAttemptAt = null;
  }

  async #settings(settings) {
    return settings ?? await this.loadSettings();
  }

  async #send(settings, { dedupeWindowMs = 0 } = {}) {
    const effective = await this.#settings(settings);
    if (!readySettings(effective)) return { status: 'disabled' };

    const nowMs = this.now();
    if (this.lastAttemptAt != null && nowMs - this.lastAttemptAt < dedupeWindowMs) {
      return { status: 'skipped' };
    }
    this.lastAttemptAt = nowMs;

    try {
      let diagnostics = { surface: 'service_worker' };
      if (this.loadDiagnostics) {
        try {
          const extra = await this.loadDiagnostics();
          if (extra && typeof extra === 'object' && !Array.isArray(extra)) diagnostics = { ...extra, surface: 'service_worker' };
        } catch (error) {
          this.logger?.warn?.('[ChatGPT Web Task Runner] Agent heartbeat diagnostics collection failed', error?.message ?? String(error));
        }
      }
      const result = await this.createTaskApi(effective).heartbeatAgent({
        condition: 'healthy',
        diagnostics
      });
      return {
        status: 'sent',
        presence: nonEmptyString(result?.health?.presence) ? result.health.presence : null
      };
    } catch (error) {
      const errorCode = error?.code ?? 'agent_heartbeat_failed';
      const errorMessage = error?.message ?? String(error);
      this.logger?.warn?.('[ChatGPT Web Task Runner] Agent heartbeat failed', errorCode, errorMessage);
      return { status: 'failed', error_code: errorCode, error_message: errorMessage };
    }
  }

  async configure(settings = null, { sendImmediately = true } = {}) {
    const effective = await this.#settings(settings);
    await this.alarms.clear(AGENT_HEARTBEAT_ALARM_NAME);
    if (!readySettings(effective)) return { status: 'disabled' };

    const intervalMs = normalizeIntervalMs(effective.heartbeatIntervalMs, this.defaultIntervalMs);
    this.alarms.create(AGENT_HEARTBEAT_ALARM_NAME, { periodInMinutes: intervalMs / 60000 });
    if (sendImmediately !== false) return this.#send(effective);

    void this.#send(effective);
    return { status: 'scheduled' };
  }

  async handleAlarm(alarm) {
    if (alarm?.name !== AGENT_HEARTBEAT_ALARM_NAME) return { handled: false };
    return {
      handled: true,
      result: await this.#send(null, { dedupeWindowMs: 1000 })
    };
  }
}
