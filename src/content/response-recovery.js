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
  /(?:出了点问题|发生错误|出现错误|网络错误|请求失败)/i
];


const SHORT_FAILURE_PATTERNS = [
  /^(?:something went wrong|there was an error|response (?:generation )?failed|try again)/i,
  /^(?:出了点问题|发生错误|出现错误|生成回复时出现错误|回复生成失败|响应失败)/i
];

const RETRY_PATTERNS = [
  /\bretry\b/i,
  /try again/i,
  /regenerate/i,
  /retry-turn-action-button/i,
  /regenerate-turn-action-button/i,
  /重试|重試|重新生成|重新回答|再试一次|再試一次/i
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
  return [...(root?.querySelectorAll?.('[data-message-author-role="assistant"]') ?? [])].at(-1) ?? null;
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

function findErrorScope(root) {
  const assistant = latestAssistant(root);
  if (!assistant) return null;
  for (const scope of scopesFrom(assistant)) {
    const errorNodes = visible(scope?.querySelectorAll?.('[role="alert"], [aria-live="assertive"], [data-testid*="error"], [data-testid*="failed"]') ?? []);
    if (errorNodes.some(errorTextMatches)) return scope;
    const text = normalizeUiText(scope?.textContent);
    if (text && text.length <= 280 && SHORT_FAILURE_PATTERNS.some(pattern => pattern.test(text)) && findRetryControl(scope)) return scope;
  }
  return null;
}

function findRetryControl(scope) {
  const controls = visible(scope?.querySelectorAll?.('button, [role="button"], [data-testid]') ?? []);
  return controls.filter(node => semanticMatches(node, RETRY_PATTERNS)).at(-1) ?? null;
}

export class ResponseRecovery {
  constructor(root = document) {
    this.root = root;
  }

  getFailureState() {
    const scope = findErrorScope(this.root);
    if (!scope) return { failed: false, retryAvailable: false };
    return { failed: true, retryAvailable: Boolean(findRetryControl(scope)) };
  }

  retryLatestResponse() {
    const scope = findErrorScope(this.root);
    if (!scope) return { retried: false, reason: 'response_not_failed' };
    const retry = findRetryControl(scope);
    if (!retry) return { retried: false, reason: 'retry_not_found' };
    retry.click?.();
    return { retried: true };
  }
}
