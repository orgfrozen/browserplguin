const STATUS_RE = /<TASK_STATUS>\s*(CONTINUE|DONE|BLOCKED)\s*<\/TASK_STATUS>/i;

export function parseTaskStatus(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(STATUS_RE);
  return match ? match[1].toUpperCase() : null;
}

export function decideTaskAction({ status, taskPatchCount, patchGoal, fallbackCount, fallbackLimit }) {
  if (status === 'BLOCKED') return 'BLOCK';
  if (status === 'CONTINUE') return 'CONTINUE';
  if (status === 'DONE') {
    if (patchGoal?.minimum && taskPatchCount < patchGoal.minimum) return 'CONTINUE';
    return 'COMPLETE';
  }
  return fallbackCount < fallbackLimit ? 'CONTINUE' : 'PROTOCOL_ERROR';
}
