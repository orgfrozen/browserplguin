function dateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

export function makeProjectName(projectId, date = new Date(), collisionIndex = 1, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const p = dateParts(date, timeZone);
  const base = `${projectId}${p.year}${p.month}${p.day}${p.hour}`;
  return collisionIndex > 1 ? `${base}-${String(collisionIndex).padStart(2, '0')}` : base;
}

export function makeSessionId(uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`) {
  const hex = String(uuid).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length < 12) throw new TypeError('session id source must provide at least 12 hex characters');
  return hex.slice(0, 12);
}

export function makeAvailableProjectName(projectId, visibleNames, date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const names = new Set((visibleNames ?? []).map(value => String(value).trim()));
  for (let collisionIndex = 1; collisionIndex <= 99; collisionIndex++) {
    const candidate = makeProjectName(projectId, date, collisionIndex, timeZone);
    if (!names.has(candidate)) return candidate;
  }
  throw new RangeError('unable to allocate a unique project name within 99 collisions');
}

export function buildProjectInstructions({ sessionId, projectConstraints = '' }) {
  return [
    projectConstraints.trim(),
    `当前执行 Session ID：${sessionId}`,
    `本 Project/Chat 的所有 Patch 文件名必须包含 Session ID ${sessionId}。`,
    '本 Session 的 Patch 序号从 001 开始，并在这个 Task 生命周期内持续递增。',
    '一个 Task 只使用当前这个 Project/Chat/Session，不创建第二个 Session。',
    '如果聊天达到最大长度或上下文上限，当前 Task 直接结束，不做迁移或续接。',
    '任务尚未完成时，在回复末尾输出 <TASK_STATUS>CONTINUE</TASK_STATUS>。',
    '任务全部完成时，在回复末尾输出 <TASK_STATUS>DONE</TASK_STATUS>。',
    '无法继续时，在回复末尾输出 <TASK_STATUS>BLOCKED</TASK_STATUS>。'
  ].filter(Boolean).join('\n\n');
}
