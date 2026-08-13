export const SELECTORS = Object.freeze({
  composerButtons: ['button[aria-label]', 'button[title]', 'button[data-testid]'],
  assistantMessages: ['[data-message-author-role="assistant"]', '[data-testid^="conversation-turn-"]'],
  projectLinks: ['a[href*="/g/"]', 'a[href*="/project"]', '[role="link"]'],
  fileInputs: ['input[type="file"]']
});

export function describeButton(element) {
  return {
    ariaLabel: element?.getAttribute?.('aria-label') ?? '',
    title: element?.getAttribute?.('title') ?? '',
    text: element?.textContent?.trim?.() ?? '',
    testId: element?.getAttribute?.('data-testid') ?? ''
  };
}
