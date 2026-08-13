import { SELECTORS, describeButton } from './selectors.js';

function semanticText(button) {
  return [button.ariaLabel, button.title, button.text, button.testId].filter(Boolean).join(' ').toLowerCase();
}

export function classifyComposerState(buttonDescriptors) {
  const texts = buttonDescriptors.map(semanticText);
  if (texts.some(text => /stop|停止/.test(text))) return 'GENERATING';
  if (texts.some(text => /send|发送|submit|prompt/.test(text))) return 'READY';
  return 'UNKNOWN';
}

export function isRoundTransitionComplete(history) {
  const generatingIndex = history.indexOf('GENERATING');
  return generatingIndex >= 0 && history.slice(generatingIndex + 1).includes('READY');
}

export function readComposerState(root = document) {
  const buttons = [...root.querySelectorAll(SELECTORS.composerButtons.join(','))].map(describeButton);
  return classifyComposerState(buttons);
}
