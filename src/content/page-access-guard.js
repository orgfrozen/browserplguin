import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { isElementVisible, normalizeUiText } from './ui-semantics.js';

const LOGIN_PATH_PATTERNS = [
  /^\/auth\/(?:login|log-in)(?:\/|$)/i,
  /^\/(?:login|log-in)(?:\/|$)/i
];

const CHALLENGE_TITLE_PATTERNS = [
  /^just a moment(?:\.\.\.)?$/i,
  /security (?:check|verification)/i,
  /verify (?:you are|that you are) human/i,
  /checking your browser/i
];

const LOGIN_TEXT_PATTERNS = [
  /^log\s*in$/i,
  /^sign\s*in$/i,
  /^登录$/,
  /^登入$/,
  /^ログイン$/
];

const CHALLENGE_TEXT_PATTERNS = [
  /^verify (?:you are|that you are) human$/i,
  /^i(?:'|’)m not a robot$/i
];

function tagName(node) {
  return String(node?.tagName ?? '').toLowerCase();
}

function attr(node, name) {
  return normalizeUiText(node?.getAttribute?.(name));
}

function semanticControlText(node) {
  return normalizeUiText([
    attr(node, 'aria-label'),
    attr(node, 'title'),
    attr(node, 'data-testid'),
    node?.textContent
  ].filter(Boolean).join(' '));
}

function matchesAny(value, patterns) {
  return patterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function listUiNodes(root) {
  return [...(root?.querySelectorAll?.('textarea, [contenteditable="true"], button, [role="button"], a[href], input, iframe, form') ?? [])]
    .filter(isElementVisible);
}

function hasComposer(nodes) {
  return nodes.some(node => {
    const tag = tagName(node);
    if (tag === 'textarea') return true;
    if (attr(node, 'contenteditable').toLowerCase() === 'true') return true;
    if (tag === 'button' || attr(node, 'role').toLowerCase() === 'button') {
      return /(?:send|发送|送信).*(?:prompt|message)?|^(?:send|发送|送信)$/i.test(semanticControlText(node));
    }
    return false;
  });
}

function hasLoginControl(nodes) {
  return nodes.some(node => {
    const tag = tagName(node);
    if (!['a', 'button'].includes(tag) && attr(node, 'role').toLowerCase() !== 'button') return false;
    const href = attr(node, 'href').toLowerCase();
    if (/(?:^|\/)auth\/(?:login|log-in)(?:[/?#]|$)/i.test(href)) return true;
    if (/(?:^|\/)(?:login|log-in)(?:[/?#]|$)/i.test(href)) return true;
    return matchesAny(semanticControlText(node), LOGIN_TEXT_PATTERNS);
  });
}

function hasChallengeControl(nodes) {
  return nodes.some(node => {
    const tag = tagName(node);
    if (tag === 'iframe') {
      const src = attr(node, 'src').toLowerCase();
      return /(?:cdn-cgi\/challenge-platform|turnstile|captcha|challenge)/i.test(src);
    }
    if (tag === 'form') {
      const action = attr(node, 'action').toLowerCase();
      return /(?:cdn-cgi\/challenge-platform|turnstile|captcha|challenge)/i.test(action)
        || /(?:turnstile|captcha|challenge)/i.test(attr(node, 'data-testid'));
    }
    if (tag === 'button' || attr(node, 'role').toLowerCase() === 'button') {
      return matchesAny(semanticControlText(node), CHALLENGE_TEXT_PATTERNS)
        || /(?:turnstile|captcha|challenge)/i.test(attr(node, 'data-testid'));
    }
    return false;
  });
}

export function classifyChatGptPageAccess({ root = document, location = globalThis.location, title = root?.title ?? '' } = {}) {
  const pathname = String(location?.pathname ?? '');
  const href = String(location?.href ?? '');
  const normalizedTitle = normalizeUiText(title);

  if (LOGIN_PATH_PATTERNS.some(pattern => pattern.test(pathname))) {
    return { status: 'LOGIN_REQUIRED', reason: 'login_url' };
  }
  if (/\/cdn-cgi\/challenge-platform\//i.test(href) || matchesAny(normalizedTitle, CHALLENGE_TITLE_PATTERNS)) {
    return { status: 'CHALLENGE_REQUIRED', reason: href.includes('/cdn-cgi/challenge-platform/') ? 'challenge_url' : 'challenge_title' };
  }

  const nodes = listUiNodes(root);
  if (hasChallengeControl(nodes)) return { status: 'CHALLENGE_REQUIRED', reason: 'challenge_control' };
  if (!hasComposer(nodes) && hasLoginControl(nodes)) return { status: 'LOGIN_REQUIRED', reason: 'login_control' };
  return { status: 'READY', reason: 'chat_ui' };
}

export function assertChatGptPageAccessible(context = {}) {
  const state = classifyChatGptPageAccess(context);
  if (state.status === 'READY') return state;
  throw new RunnerError(
    ERROR_CODES.LOGIN_OR_CHALLENGE_REQUIRED,
    state.status === 'LOGIN_REQUIRED'
      ? 'ChatGPT login is required before browser automation can continue'
      : 'ChatGPT access/security challenge must be completed before browser automation can continue',
    { accessStatus: state.status, reason: state.reason }
  );
}
