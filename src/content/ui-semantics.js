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
