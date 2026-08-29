import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { getActiveSelectorProfile } from '../shared/selector-registry.js';
import { isElementVisible, normalizeUiText } from './ui-semantics.js';

const SELECTOR_PROFILE = getActiveSelectorProfile();
const ACCESS_PATTERNS = SELECTOR_PROFILE.patterns.access;
const ACCESS_SELECTORS = SELECTOR_PROFILE.selectors;

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
  return [...(root?.querySelectorAll?.(ACCESS_SELECTORS.accessNodes) ?? [])]
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
    return matchesAny(semanticControlText(node), ACCESS_PATTERNS.loginText);
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
      return matchesAny(semanticControlText(node), ACCESS_PATTERNS.challengeText)
        || /(?:turnstile|captcha|challenge)/i.test(attr(node, 'data-testid'));
    }
    return false;
  });
}

function accessLimitDialogReason(nodes) {
  for (const node of nodes) {
    const role = attr(node, 'role').toLowerCase();
    if (!['dialog', 'alert', 'status'].includes(role)) continue;
    const text = semanticControlText(node);
    if (matchesAny(text, ACCESS_PATTERNS.requestFrequencyText ?? [])) return 'request_frequency_dialog';
    if (matchesAny(text, ACCESS_PATTERNS.usageLimitText ?? [])) return 'usage_limit_dialog';
  }
  return null;
}

export function classifyChatGptPageAccess({ root = document, location = globalThis.location, title = root?.title ?? '' } = {}) {
  const pathname = String(location?.pathname ?? '');
  const href = String(location?.href ?? '');
  const normalizedTitle = normalizeUiText(title);

  if (ACCESS_PATTERNS.loginPath.some(pattern => pattern.test(pathname))) {
    return { status: 'LOGIN_REQUIRED', reason: 'login_url' };
  }
  if (/\/cdn-cgi\/challenge-platform\//i.test(href) || matchesAny(normalizedTitle, ACCESS_PATTERNS.challengeTitle)) {
    return { status: 'CHALLENGE_REQUIRED', reason: href.includes('/cdn-cgi/challenge-platform/') ? 'challenge_url' : 'challenge_title' };
  }

  const nodes = listUiNodes(root);
  if (hasChallengeControl(nodes)) return { status: 'CHALLENGE_REQUIRED', reason: 'challenge_control' };
  const composerPresent = hasComposer(nodes);
  const accessLimitReason = accessLimitDialogReason(nodes);
  if (accessLimitReason === 'request_frequency_dialog') {
    return {
      status: composerPresent ? 'READY' : 'DEGRADED',
      reason: composerPresent ? 'composer_available' : accessLimitReason,
      advisory: { kind: accessLimitReason, visible: true, composer_present: composerPresent }
    };
  }
  if (accessLimitReason === 'usage_limit_dialog' && composerPresent) {
    return {
      status: 'READY',
      reason: 'composer_available',
      advisory: { kind: accessLimitReason, visible: true, composer_present: true }
    };
  }
  if (accessLimitReason) {
    return {
      status: 'USAGE_LIMITED',
      reason: accessLimitReason,
      advisory: { kind: accessLimitReason, visible: true, composer_present: composerPresent }
    };
  }
  if (!composerPresent && hasLoginControl(nodes)) return { status: 'LOGIN_REQUIRED', reason: 'login_control' };
  return { status: 'READY', reason: 'chat_ui' };
}

export function assertChatGptPageAccessible(context = {}) {
  const state = classifyChatGptPageAccess(context);
  if (state.status === 'READY' || state.status === 'DEGRADED') return state;
  if (state.status === 'USAGE_LIMITED') {
    throw new RunnerError(
      ERROR_CODES.CHATGPT_ACCESS_LIMITED,
      'ChatGPT usage/access limit is active; browser automation must cool down before starting more work',
      {
        accessStatus: state.status,
        reason: state.reason,
        detector: state.advisory?.kind ?? state.reason,
        visible: state.advisory?.visible === true,
        composerPresent: state.advisory?.composer_present === true
      }
    );
  }
  throw new RunnerError(
    ERROR_CODES.LOGIN_OR_CHALLENGE_REQUIRED,
    state.status === 'LOGIN_REQUIRED'
      ? 'ChatGPT login is required before browser automation can continue'
      : 'ChatGPT access/security challenge must be completed before browser automation can continue',
    { accessStatus: state.status, reason: state.reason }
  );
}
