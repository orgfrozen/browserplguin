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
      error: active?.error_code ? { code: active.error_code, message: null, details: null } : null
    };
  }

  const previous = status?.lastRun?.trace?.length
    ? status.lastRun
    : status?.lastRecovery?.trace?.length
      ? status.lastRecovery
      : null;

  return {
    kind: 'last',
    label: '上次结果',
    taskId: previous?.taskId ?? null,
    trace: previous?.trace ?? [],
    error: previous?.error ?? null
  };
}
