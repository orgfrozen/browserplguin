import { RunnerError, ERROR_CODES } from '../shared/errors.js';

export function normalizeUiText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function isElementVisible(element) {
  if (!element || element.hidden) return false;
  const rect = element.getBoundingClientRect?.();
  if (rect && rect.width === 0 && rect.height === 0) return false;
  return true;
}

export function elementSemanticText(element) {
  const values = [
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    element?.getAttribute?.('data-testid'),
    element?.getAttribute?.('name'),
    element?.textContent
  ];
  return normalizeUiText(values.filter(Boolean).join(' ')).toLowerCase();
}

export function findUniqueSemantic(root, selector, patterns, { required = true, visibleOnly = true, label = 'UI control' } = {}) {
  const nodes = [...(root?.querySelectorAll?.(selector) ?? [])];
  const regexes = patterns.map(pattern => pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i'));
  const matches = nodes.filter(node => {
    if (visibleOnly && !isElementVisible(node)) return false;
    const semantic = elementSemanticText(node);
    return regexes.some(regex => {
      regex.lastIndex = 0;
      return regex.test(semantic);
    });
  });

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, `${label} is ambiguous`, {
      selector,
      matches: matches.slice(0, 10).map(elementSemanticText)
    });
  }
  if (!required) return null;
  throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, `${label} was not found`, { selector });
}

export function collectUiDiagnostics(root, { limit = 120 } = {}) {
  const nodes = [...(root?.querySelectorAll?.('button, [role="button"], input, textarea, [role="dialog"], [role="menuitem"], a[href]') ?? [])];
  return nodes.filter(node => {
    if (!isElementVisible(node)) return false;
    const tag = String(node.tagName ?? '').toLowerCase();
    const role = normalizeUiText(node.getAttribute?.('role')).toLowerCase();
    return ['button', 'input', 'textarea', 'a'].includes(tag) || ['button', 'dialog', 'menuitem'].includes(role);
  }).slice(0, limit).map(node => ({
    tag: String(node.tagName ?? '').toLowerCase(),
    role: normalizeUiText(node.getAttribute?.('role')),
    ariaLabel: normalizeUiText(node.getAttribute?.('aria-label')).slice(0, 160),
    title: normalizeUiText(node.getAttribute?.('title')).slice(0, 160),
    testId: normalizeUiText(node.getAttribute?.('data-testid')).slice(0, 160),
    name: normalizeUiText(node.getAttribute?.('name')).slice(0, 160),
    type: normalizeUiText(node.getAttribute?.('type')).slice(0, 80),
    placeholder: normalizeUiText(node.getAttribute?.('placeholder')).slice(0, 160),
    href: normalizeUiText(node.getAttribute?.('href')).slice(0, 240)
  }));
}


function sanitizeDiagnosticPath(pathname) {
  const safeSegments = new Set(['auth', 'login', 'log-in', 'cdn-cgi', 'challenge-platform', 'c', 'g', 'project', 'projects']);
  const segments = String(pathname ?? '').split('/').filter(Boolean).map(segment => {
    const normalized = normalizeUiText(segment).toLowerCase();
    return safeSegments.has(normalized) ? normalized : ':segment';
  });
  return `/${segments.join('/')}` || '/';
}

function diagnosticTitleCategory(title, accessState) {
  if (accessState?.status === 'LOGIN_REQUIRED') return 'login';
  if (accessState?.status === 'CHALLENGE_REQUIRED') return 'challenge';
  const normalized = normalizeUiText(title).toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('chatgpt')) return 'chat';
  return 'other';
}

function sanitizeMachineAttribute(value) {
  const normalized = normalizeUiText(value);
  if (!normalized) return '';
  if (normalized.length > 80 || /[@/?#\\]/.test(normalized) || /[a-z0-9_-]{20,}/i.test(normalized)) return '[redacted]';
  if (!/^[a-z0-9_.:-]+$/i.test(normalized)) return '[redacted]';
  return normalized;
}

function diagnosticSemanticHint(value) {
  const normalized = normalizeUiText(value).toLowerCase();
  if (!normalized) return null;
  const hints = [
    ['new_project', /new project|新建项目|新規プロジェクト/i],
    ['project_settings', /project settings|项目设置|プロジェクト設定/i],
    ['delete', /delete|删除|削除/i],
    ['save', /save|保存/i],
    ['send', /send|发送|送信/i],
    ['stop', /stop|停止/i],
    ['attach', /attach|upload|附件|上传|添付|アップロード/i],
    ['context_limit', /maximum conversation length|conversation.*limit|context.*limit|上下文.*限制|对话.*上限|コンテキスト.*上限/i],
    ['patch_download', /download.*patch|下载.*patch|\.patch\b/i],
    ['login', /log in|login|sign in|登录|登入|ログイン/i],
    ['challenge', /verify you are human|captcha|turnstile|challenge|i.?m not a robot|验证.*人|人間.*確認/i],
    ['menu', /menu|more|options|菜单|更多|メニュー|その他/i]
  ];
  return hints.find(([, pattern]) => pattern.test(normalized))?.[0] ?? '[redacted]';
}



const CALIBRATION_SAFE_TAGS = new Set([
  'a', 'button', 'div', 'form', 'header', 'input', 'label', 'main', 'nav', 'section', 'textarea'
]);
const CALIBRATION_SAFE_ROLES = new Set([
  'alert', 'banner', 'button', 'dialog', 'form', 'link', 'main', 'menu', 'menuitem', 'navigation',
  'region', 'status', 'textbox', 'toolbar'
]);
const CALIBRATION_SAFE_TYPES = new Set([
  'button', 'file', 'submit', 'text', 'search'
]);

function calibrationTag(value) {
  const tag = String(value ?? '').toLowerCase();
  return CALIBRATION_SAFE_TAGS.has(tag) ? tag : 'other';
}

function calibrationRole(value) {
  const role = normalizeUiText(value).toLowerCase();
  if (!role) return null;
  return CALIBRATION_SAFE_ROLES.has(role) ? role : 'other';
}

function calibrationType(value) {
  const type = normalizeUiText(value).toLowerCase();
  if (!type) return null;
  return CALIBRATION_SAFE_TYPES.has(type) ? type : 'other';
}

function calibrationMachineCategory(value) {
  const normalized = normalizeUiText(value);
  if (!normalized) return 'absent';
  const hint = diagnosticSemanticHint(normalized);
  return hint && hint !== '[redacted]' ? hint : 'present_unknown';
}

function calibrationAncestorCategory(node) {
  const role = calibrationRole(node?.getAttribute?.('role'));
  if (role && role !== 'other') return role;
  return calibrationTag(node?.tagName);
}

export function buildSafeCalibrationFingerprint(node) {
  const semanticSource = [
    node?.getAttribute?.('aria-label'),
    node?.getAttribute?.('title'),
    node?.getAttribute?.('placeholder'),
    node?.getAttribute?.('data-testid'),
    node?.getAttribute?.('name'),
    node?.textContent
  ].filter(Boolean).join(' ');
  const semantic = diagnosticSemanticHint(semanticSource);
  const ancestorRoles = [];
  let parent = node?.parentElement ?? null;
  while (parent && ancestorRoles.length < 3) {
    ancestorRoles.push(calibrationAncestorCategory(parent));
    parent = parent.parentElement ?? null;
  }
  return {
    tag: calibrationTag(node?.tagName),
    role: calibrationRole(node?.getAttribute?.('role')),
    type: calibrationType(node?.getAttribute?.('type')),
    test_id_category: calibrationMachineCategory(node?.getAttribute?.('data-testid')),
    name_category: calibrationMachineCategory(node?.getAttribute?.('name')),
    semantic_hint: semantic && semantic !== '[redacted]' ? semantic : 'unknown',
    ancestor_roles: ancestorRoles
  };
}

function diagnosticControlFingerprint(node) {
  const href = normalizeUiText(node?.getAttribute?.('href'));
  let hrefShape = null;
  if (href) {
    try {
      const parsed = new URL(href, 'https://chatgpt.com/');
      hrefShape = { hostname: parsed.hostname.toLowerCase(), pathname: sanitizeDiagnosticPath(parsed.pathname) };
    } catch {
      hrefShape = { hostname: '[invalid]', pathname: '/' };
    }
  }
  return {
    tag: String(node?.tagName ?? '').toLowerCase(),
    role: sanitizeMachineAttribute(node?.getAttribute?.('role')),
    type: sanitizeMachineAttribute(node?.getAttribute?.('type')),
    testId: sanitizeMachineAttribute(node?.getAttribute?.('data-testid')),
    name: sanitizeMachineAttribute(node?.getAttribute?.('name')),
    ariaHint: diagnosticSemanticHint(node?.getAttribute?.('aria-label')),
    titleHint: diagnosticSemanticHint(node?.getAttribute?.('title')),
    placeholderHint: diagnosticSemanticHint(node?.getAttribute?.('placeholder')),
    href: hrefShape
  };
}

export function collectErrorDomDiagnostics(root, {
  location = globalThis.location,
  title = root?.title ?? '',
  accessState = null,
  selectorProfile = null,
  errorCode = 'UNEXPECTED',
  limit = 40
} = {}) {
  const nodes = [...(root?.querySelectorAll?.('button, [role="button"], input, textarea, [role="dialog"], [role="menuitem"], a[href], iframe, form') ?? [])];
  const controls = nodes.filter(node => {
    if (!isElementVisible(node)) return false;
    const tag = String(node.tagName ?? '').toLowerCase();
    const role = normalizeUiText(node.getAttribute?.('role')).toLowerCase();
    return ['button', 'input', 'textarea', 'a', 'iframe', 'form'].includes(tag) || ['button', 'dialog', 'menuitem'].includes(role);
  });
  const max = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 120) : 40;
  return {
    error_code: String(errorCode ?? 'UNEXPECTED'),
    selector_profile: selectorProfile ? { id: selectorProfile.id ?? null, version: selectorProfile.version ?? null } : null,
    access_state: accessState ? { status: accessState.status ?? null, reason: accessState.reason ?? null } : null,
    page: {
      hostname: String(location?.hostname ?? '').toLowerCase(),
      pathname: sanitizeDiagnosticPath(location?.pathname ?? '/'),
      title_category: diagnosticTitleCategory(title, accessState)
    },
    control_count: controls.length,
    controls: controls.slice(0, max).map(diagnosticControlFingerprint)
  };
}
