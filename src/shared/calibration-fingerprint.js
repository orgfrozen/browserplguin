const SAFE_TAGS = new Set(['a', 'button', 'div', 'form', 'header', 'input', 'label', 'main', 'nav', 'section', 'textarea', 'other']);
const SAFE_ROLES = new Set([
  'alert', 'banner', 'button', 'dialog', 'form', 'link', 'main', 'menu', 'menuitem', 'navigation',
  'region', 'status', 'textbox', 'toolbar', 'other'
]);
const SAFE_TYPES = new Set(['button', 'file', 'submit', 'text', 'search', 'other']);
const SAFE_HINTS = new Set([
  'new_project', 'project_settings', 'delete', 'save', 'send', 'stop', 'attach', 'context_limit',
  'patch_download', 'login', 'challenge', 'menu', 'unknown'
]);
const SAFE_MACHINE_CATEGORIES = new Set([...SAFE_HINTS, 'present_unknown', 'absent']);
const SAFE_ANCESTOR_CATEGORIES = new Set([...SAFE_TAGS, ...SAFE_ROLES]);

function enumOr(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function nullableEnum(value, allowed) {
  if (value === null || value === undefined || value === '') return null;
  return enumOr(value, allowed, 'other');
}

function machineCategory(value) {
  if (value === null || value === undefined || value === '') return 'absent';
  return enumOr(value, SAFE_MACHINE_CATEGORIES, 'present_unknown');
}

export function sanitizeCalibrationFingerprint(value) {
  const source = value && typeof value === 'object' ? value : {};
  const ancestors = [];
  for (const item of Array.isArray(source.ancestor_roles) ? source.ancestor_roles : []) {
    if (ancestors.length >= 3) break;
    ancestors.push(enumOr(item, SAFE_ANCESTOR_CATEGORIES, 'other'));
  }
  return {
    tag: enumOr(source.tag, SAFE_TAGS, 'other'),
    role: nullableEnum(source.role, SAFE_ROLES),
    type: nullableEnum(source.type, SAFE_TYPES),
    test_id_category: machineCategory(source.test_id_category),
    name_category: machineCategory(source.name_category),
    semantic_hint: enumOr(source.semantic_hint, SAFE_HINTS, 'unknown'),
    ancestor_roles: ancestors
  };
}

export function sanitizeCalibrationFingerprints(values, { limit = 3 } = {}) {
  const result = [];
  const seen = new Set();
  const max = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 3) : 3;
  for (const value of Array.isArray(values) ? values : []) {
    if (result.length >= max) break;
    const item = sanitizeCalibrationFingerprint(value);
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
