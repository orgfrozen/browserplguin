import { RunnerError, ERROR_CODES } from '../shared/errors.js';

export class ConversationManager {
  constructor(root = document) { this.root = root; }

  resolvePrimaryChat() {
    const composer = this.root.querySelector('textarea, [contenteditable="true"]');
    if (!composer) throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'Primary chat/composer was not found');
    return { composerPresent: true };
  }

  getLatestAssistantElement() {
    const nodes = [...this.root.querySelectorAll('[data-message-author-role="assistant"]')];
    return nodes.at(-1) ?? null;
  }

  getLatestAssistantSnapshot() {
    const element = this.getLatestAssistantElement();
    return { text: element?.textContent?.trim?.() ?? '', element };
  }

  detectContextLengthLimit() {
    const text = this.root.body?.innerText ?? this.root.documentElement?.innerText ?? '';
    return /maximum (conversation|chat|context) length|conversation.*too long|达到.*(长度|上限)/i.test(text);
  }
}
