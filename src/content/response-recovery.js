import { InteractionPacing } from '../shared/interaction-pacing.js';
import { elementSemanticText, isElementVisible, normalizeUiText } from './ui-semantics.js';

const ERROR_PATTERNS = [
  /something went wrong/i,
  /there was an error/i,
  /error (?:while|when) generating/i,
  /failed to (?:generate|respond|complete)/i,
  /response (?:generation )?failed/i,
  /try again/i,
  /生成.*(?:失败|错误|出错)/i,
  /回复.*(?:失败|错误|出错)/i,
  /响应.*(?:失败|错误|出错)/i,
  /(?:出了点问题|出错了|发生错误|出现错误|网络错误|请求失败)/i
];


const SHORT_FAILURE_PATTERNS = [
  /^(?:something went wrong|there was an error|response (?:generation )?failed|try again)/i,
  /^(?:出了点问题|出错了|发生错误|出现错误|生成回复时出现错误|回复生成失败|响应失败)/i
];

const RETRY_PATTERNS = [
  /\bretry\b/i,
  /try again/i,
  /regenerate/i,
  /retry-turn-action-button/i,
  /regenerate-turn-action-button/i,
  /重试|重試|重新生成|重新回答|再试一次|再試一次/i
];

const MODEL_SWITCH_PATTERNS = [
  /switch model/i,
  /切换模型|切換模型/i
];

const RETRY_MENU_PATTERNS = [
  /后重试|後重試/i,
  /\bretry\b.*\b(?:with|using)\b/i
];

function visible(nodes) {
  return [...(nodes ?? [])].filter(isElementVisible);
}

function semanticMatches(node, patterns) {
  const text = elementSemanticText(node);
  return patterns.some(pattern => pattern.test(text));
}

function errorTextMatches(node) {
  const text = normalizeUiText(node?.textContent);
  return ERROR_PATTERNS.some(pattern => pattern.test(text));
}

function latestAssistant(root) {
  return [...(root?.querySelectorAll?.('[data-message-author-role="assistant"], [data-turn="assistant"]') ?? [])].at(-1) ?? null;
}

function scopesFrom(node) {
  const scopes = [];
  let current = node;
  for (let depth = 0; current && depth < 6; depth += 1) {
    scopes.push(current);
    current = current.parentElement ?? null;
  }
  return scopes;
}

function findDirectRetryControl(scope) {
  const controls = visible(scope?.querySelectorAll?.('button, [role="button"], [data-testid]') ?? []);
  return controls.filter(node => semanticMatches(node, RETRY_PATTERNS)).at(-1) ?? null;
}

function findModelSwitchControl(scope) {
  const controls = visible(scope?.querySelectorAll?.('button, [role="button"]') ?? []);
  return controls.filter(node => semanticMatches(node, MODEL_SWITCH_PATTERNS)).at(-1) ?? null;
}

function findRecoveryControl(scope) {
  return findDirectRetryControl(scope) ?? findModelSwitchControl(scope);
}

function findRetryMenuItem(root) {
  const controls = visible(root?.querySelectorAll?.('[role="menuitem"], [role="option"], [role="menu"] button, [role="menu"] [role="button"], button') ?? []);
  return controls.find(node => semanticMatches(node, RETRY_MENU_PATTERNS)) ?? null;
}

function findErrorScope(root) {
  const assistant = latestAssistant(root);
  if (!assistant) return null;
  for (const scope of scopesFrom(assistant)) {
    const errorNodes = visible(scope?.querySelectorAll?.('[role="alert"], [aria-live="assertive"], [data-testid*="error"], [data-testid*="failed"]') ?? []);
    if (errorNodes.some(errorTextMatches)) return scope;
    const text = normalizeUiText(scope?.textContent);
    if (text && text.length <= 280 && SHORT_FAILURE_PATTERNS.some(pattern => pattern.test(text)) && findRecoveryControl(scope)) return scope;
  }
  return null;
}

export class ResponseRecovery {
  constructor(root = document, {
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    retryMenuPollMs = 50,
    retryMenuTimeoutMs = 1500,
    interactionPacing = null
  } = {}) {
    this.root = root;
    this.sleep = sleep;
    this.retryMenuPollMs = retryMenuPollMs;
    this.retryMenuTimeoutMs = retryMenuTimeoutMs;
    this.interactionPacing = interactionPacing ?? new InteractionPacing({ baseMs: 0 });
  }

  getFailureState() {
    const scope = findErrorScope(this.root);
    if (!scope) return { failed: false, retryAvailable: false };
    return { failed: true, retryAvailable: Boolean(findRecoveryControl(scope)) };
  }

  async retryLatestResponse() {
    const scope = findErrorScope(this.root);
    if (!scope) return { retried: false, reason: 'response_not_failed' };

    const retry = findDirectRetryControl(scope);
    if (retry) {
      retry.click?.();
      await this.interactionPacing.wait('click');
      return { retried: true };
    }

    const modelSwitch = findModelSwitchControl(scope);
    if (!modelSwitch) return { retried: false, reason: 'retry_not_found' };
    modelSwitch.click?.();

    const pollMs = Math.max(1, Number(this.retryMenuPollMs) || 1);
    const attempts = Math.max(1, Math.ceil((Number(this.retryMenuTimeoutMs) || pollMs) / pollMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const menuRetry = findRetryMenuItem(this.root);
      if (menuRetry) {
        await this.interactionPacing.wait('menu');
        menuRetry.click?.();
        await this.interactionPacing.wait('click');
        return { retried: true };
      }
      if (attempt + 1 < attempts) await this.sleep(pollMs);
    }

    return { retried: false, reason: 'retry_menu_not_found' };
  }
}
