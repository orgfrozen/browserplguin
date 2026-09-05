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


function formatDurationSeconds(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatSourceExport(sourceExport, nowMs = Date.now()) {
  if (!sourceExport?.export_id) return '-';
  if (sourceExport.stage === 'waiting_for_idle') {
    const startedMs = Date.parse(sourceExport.wait_started_at ?? '');
    const elapsed = Number.isFinite(startedMs)
      ? formatLocalRuntime(sourceExport.wait_started_at, nowMs)
      : Number.isFinite(Number(sourceExport.wait_duration)) ? formatDurationSeconds(sourceExport.wait_duration) : null;
    const blocker = [
      sourceExport.blocking_project,
      Number.isInteger(Number(sourceExport.blocking_pid)) ? `PID ${Number(sourceExport.blocking_pid)}` : null,
      sourceExport.blocking_phase,
      sourceExport.blocking_reason
    ].filter(Boolean);
    return [
      `Waiting for PatchSync idle${elapsed ? ` — ${elapsed}` : ''}`,
      blocker.length > 0 ? `Blocked by: ${blocker.join(' / ')}` : null
    ].filter(Boolean).join(' · ');
  }
  return [sourceExport.stage ?? sourceExport.status, sourceExport.export_id].filter(Boolean).join(' · ') || '-';
}
