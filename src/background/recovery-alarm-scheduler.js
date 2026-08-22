export function nextRecoveryAlarmWhen({ activeExecution, nowMs = Date.now(), retryDelayMs = 2000 } = {}) {
  if (!activeExecution?.task_id) return null;
  const durableWhen = Date.parse(activeExecution.next_recovery_at ?? '');
  if (!Number.isFinite(durableWhen)) return null;
  const now = Number(nowMs);
  const delay = Number(retryDelayMs);
  if (!Number.isFinite(now) || !Number.isFinite(delay)) return null;
  return Math.max(durableWhen, now + Math.max(0, delay));
}
