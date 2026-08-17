function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validHttpUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateTask(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['task must be an object'] };
  if (!nonEmptyString(raw.task_id)) errors.push('task_id is required');
  if (!nonEmptyString(raw.project_id)) errors.push('project_id is required');
  if (!nonEmptyString(raw.task_prompt)) errors.push('task_prompt is required');
  if (raw.resource != null) {
    if (!raw.resource || typeof raw.resource !== 'object') errors.push('resource must be an object');
    else {
      if (!validHttpUrl(raw.resource.url)) errors.push('resource.url must be an absolute http(s) URL');
      if (raw.resource.filename != null && !nonEmptyString(raw.resource.filename)) errors.push('resource.filename must be a non-empty string');
    }
  }
  if (raw.patch_goal != null) {
    const minimum = raw.patch_goal?.minimum;
    if (!Number.isInteger(minimum) || minimum <= 0) {
      errors.push('patch_goal.minimum must be a positive integer');
    }
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeTask(raw) {
  const result = validateTask(raw);
  if (!result.ok) throw new TypeError(result.errors.join('; '));
  return {
    ...raw,
    title: raw.title ?? raw.task_id,
    project_constraints: raw.project_constraints ?? '',
    resource: raw.resource ? { url: raw.resource.url, ...(raw.resource.filename != null ? { filename: raw.resource.filename } : {}) } : null,
    patch_goal: raw.patch_goal ? { minimum: raw.patch_goal.minimum } : null,
    initialization_prompt: raw.initialization_prompt ?? '请先完整分析已上传的项目源码，理解现有架构、技术栈、当前 Task 目标和 PatchSync 交付约束。完成分析后再开始执行当前 Task。'
  };
}
