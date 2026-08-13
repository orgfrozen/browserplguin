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

  getRoundSnapshot() {
    const messages = [...this.root.querySelectorAll('[data-message-author-role=\"user\"], [data-message-author-role=\"assistant\"]')];
    const latest = messages.at(-1) ?? null;
    const users = messages.filter(node => node.getAttribute?.('data-message-author-role') === 'user');
    const assistants = messages.filter(node => node.getAttribute?.('data-message-author-role') === 'assistant');
    return {
      latestRole: latest?.getAttribute?.('data-message-author-role') ?? null,
      latestUserText: users.at(-1)?.textContent?.trim?.() ?? '',
      latestAssistantText: assistants.at(-1)?.textContent?.trim?.() ?? ''
    };
  }

  detectContextLengthLimit() {
    const text = this.root.body?.innerText ?? this.root.documentElement?.innerText ?? '';
    return /maximum (conversation|chat|context) length|conversation.*too long|达到.*(长度|上限)/i.test(text);
  }
}
