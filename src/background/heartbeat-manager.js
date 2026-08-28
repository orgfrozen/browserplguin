function heartbeatDelay(configuredIntervalMs, lease) {
  if (!Number.isInteger(lease?.ttl_ms) || lease.ttl_ms <= 0) return configuredIntervalMs;
  return Math.max(1000, Math.floor(lease.ttl_ms / 3));
}

const LEASE_LOSS_CODES = new Set(['assignment_not_found', 'agent_assignment_mismatch', 'assignment_lease_stale', 'assignment_lease_expired', 'assignment_lease_inactive']);

export function isConfirmedLeaseLoss(error) {
  return Boolean(error && LEASE_LOSS_CODES.has(error.code));
}

export class HeartbeatManager {
  constructor({ taskApi, intervalMs = 30000, onLeaseUpdated = null, onLeaseLost = null, onHeartbeatSuccess = null, setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (...args) => globalThis.clearTimeout(...args) }) {
    this.taskApi = taskApi;
    this.intervalMs = intervalMs;
    this.onLeaseUpdated = onLeaseUpdated;
    this.onLeaseLost = onLeaseLost;
    this.onHeartbeatSuccess = onHeartbeatSuccess;
    this.leaseLoss = null;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.taskId = null;
  }

  #schedule() {
    if (!this.taskId) return;
    const taskId = this.taskId;
    const lease = this.taskApi.getLease?.(taskId) ?? null;
    const delay = heartbeatDelay(this.intervalMs, lease);
    this.timer = this.setTimer(async () => {
      this.timer = null;
      try {
        await this.taskApi.heartbeatTask(taskId);
        if (this.onHeartbeatSuccess) {
          try { await this.onHeartbeatSuccess(taskId); } catch { /* liveness telemetry must not affect lease renewal */ }
        }
        const refreshed = this.taskApi.getLease?.(taskId) ?? null;
        if (refreshed && this.onLeaseUpdated) await this.onLeaseUpdated(taskId, refreshed);
      } catch (error) {
        if (isConfirmedLeaseLoss(error)) {
          this.leaseLoss = error;
          this.taskId = null;
          if (this.onLeaseLost) await this.onLeaseLost(taskId, error);
          return;
        }
        // Transient heartbeat failures retry on the next lease-aware interval.
      }
      if (this.taskId === taskId) this.#schedule();
    }, delay);
  }

  start(taskId) {
    this.stop();
    this.leaseLoss = null;
    this.taskId = taskId;
    this.#schedule();
  }

  getLeaseLoss() { return this.leaseLoss; }

  assertLeaseActive() {
    if (this.leaseLoss) throw this.leaseLoss;
  }

  stop() {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    this.taskId = null;
  }
}
