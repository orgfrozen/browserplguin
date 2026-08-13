import { getActiveSelectorProfile } from '../shared/selector-registry.js';

const SELECTOR_PROFILE = getActiveSelectorProfile();

export const SELECTORS = SELECTOR_PROFILE.selectors;

export function describeButton(element) {
  return {
    ariaLabel: element?.getAttribute?.('aria-label') ?? '',
    title: element?.getAttribute?.('title') ?? '',
    text: element?.textContent?.trim?.() ?? '',
    testId: element?.getAttribute?.('data-testid') ?? ''
  };
}
