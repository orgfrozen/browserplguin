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

export function makeAvailableProjectName(projectId, visibleNames, date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const names = new Set((visibleNames ?? []).map(value => String(value).trim()));
  for (let collisionIndex = 1; collisionIndex <= 99; collisionIndex++) {
    const candidate = makeProjectName(projectId, date, collisionIndex, timeZone);
    if (!names.has(candidate)) return candidate;
  }
  throw new RangeError('unable to allocate a unique project name within 99 collisions');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildProjectInstructions({ project = {}, task = {}, llmRules = '', projectConstraints = '' } = {}) {
  const sections = [
    nonEmpty(project.name) || nonEmpty(project.project_id)
      ? `项目：${project.name || project.project_id}`
      : '',
    nonEmpty(project.description) ? `项目描述：\n${project.description.trim()}` : '',
    nonEmpty(project.goal) ? `项目长期目标：\n${project.goal.trim()}` : '',
    nonEmpty(projectConstraints) ? `附加约束：\n${projectConstraints.trim()}` : '',
    nonEmpty(llmRules) ? `PatchSync 交付规则（以下内容必须原样遵守）：\n${llmRules}` : '',
    '只有在聊天中收到明确的正式 Task Prompt 后才执行具体业务任务；初始化分析阶段不得修改文件或生成 Git Patch。',
    '任务尚未完成且仍可继续执行时，在回复末尾输出 <TASK_STATUS>CONTINUE</TASK_STATUS>。',
    '你认为当前任务已经达到最终目标时，在回复末尾输出 <TASK_STATUS>DONE</TASK_STATUS>；最终是否结束由服务端验收决定。',
    '无法继续时，在回复末尾输出 <TASK_STATUS>BLOCKED</TASK_STATUS>。'
  ];
  return sections.filter(Boolean).join('\n\n');
}
