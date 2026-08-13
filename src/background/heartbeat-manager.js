function heartbeatDelay(configuredIntervalMs, lease) {
  if (!Number.isInteger(lease?.ttl_ms) || lease.ttl_ms <= 0) return configuredIntervalMs;
  return Math.min(configuredIntervalMs, Math.max(1000, Math.floor(lease.ttl_ms / 3)));
}

export class HeartbeatManager {
  constructor({ taskApi, intervalMs = 30000, onLeaseUpdated = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.taskApi = taskApi;
    this.intervalMs = intervalMs;
    this.onLeaseUpdated = onLeaseUpdated;
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
        const refreshed = this.taskApi.getLease?.(taskId) ?? null;
        if (refreshed && this.onLeaseUpdated) await this.onLeaseUpdated(taskId, refreshed);
      } catch {
        // The runner owns terminal handling; heartbeat retries on the next lease-aware interval.
      }
      if (this.taskId === taskId) this.#schedule();
    }, delay);
  }

  start(taskId) {
    this.stop();
    this.taskId = taskId;
    this.#schedule();
  }

  stop() {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    this.taskId = null;
  }
}
