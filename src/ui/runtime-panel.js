const TRACE_IDS = Object.freeze([
  'assignment','claim','execution','bootstrap','export','source','project','upload','prompt','patch','completion'
]);

function pendingTrace() {
  return TRACE_IDS.map(id => ({ id, status: 'pending' }));
}

export function selectRuntimePanelSource(status) {
  const active = status?.activeExecution ?? null;
  if (status?.running === true || active) {
    return {
      kind: 'current',
      label: '当前执行',
      taskId: active?.task_id ?? null,
      trace: Array.isArray(status?.activeTrace) && status.activeTrace.length > 0 ? status.activeTrace : pendingTrace(),
      error: active?.recovery_error ?? (active?.error_code ? {
        code: active.error_code,
        message: active.recovery_reason ?? active.patch_delivery?.reason ?? null,
        details: active.patch_delivery ?? null
      } : null)
    };
  }

  const lastRun = status?.lastRun?.trace?.length ? status.lastRun : null;
  const lastRecovery = status?.lastRecovery?.trace?.length ? status.lastRecovery : null;
  const previous = lastRecovery?.taskId && lastRun?.taskId === lastRecovery.taskId
    ? lastRecovery
    : lastRun ?? lastRecovery;

  return {
    kind: 'last',
    label: '上次结果',
    taskId: previous?.taskId ?? null,
    trace: previous?.trace ?? [],
    error: previous?.error ?? null
  };
}
