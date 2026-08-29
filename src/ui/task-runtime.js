export function formatLocalRuntime(startedAt, nowMs = Date.now()) {
  const startedMs = Date.parse(startedAt ?? '');
  const currentMs = Number(nowMs);
  if (!Number.isFinite(startedMs) || !Number.isFinite(currentMs) || currentMs <= startedMs) return '00:00:00';

  const totalSeconds = Math.floor((currentMs - startedMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
