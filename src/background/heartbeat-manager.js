export class HeartbeatManager {
  constructor({ taskApi, intervalMs = 30000, setTimer = setInterval, clearTimer = clearInterval }) {
    this.taskApi = taskApi;
    this.intervalMs = intervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
  }

  start(taskId) {
    this.stop();
    this.timer = this.setTimer(() => this.taskApi.heartbeatTask(taskId).catch(() => {}), this.intervalMs);
  }

  stop() {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
