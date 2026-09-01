import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { getActiveSelectorProfile } from '../shared/selector-registry.js';
import { findUniqueSemantic } from './ui-semantics.js';

const SELECTOR_PROFILE = getActiveSelectorProfile();
const CONVERSATION_PATTERNS = SELECTOR_PROFILE.patterns.conversation;
const CONVERSATION_SELECTORS = SELECTOR_PROFILE.selectors;

export class ConversationManager {
  constructor(root = document) { this.root = root; }


  prepareNewChat() {
    const control = findUniqueSemantic(
      this.root,
      CONVERSATION_SELECTORS.conversationControls,
      CONVERSATION_PATTERNS.newChat,
      { label: 'New Chat control' }
    );
    control.click?.();
    return this.resolvePrimaryChat();
  }

  currentConversationIdentity(href = globalThis.location?.href) {
    let url;
    try {
      url = new URL(String(href ?? ''));
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'chatgpt.com') return null;
    const match = url.pathname.match(/^\/c\/([^/]+)\/?$/);
    if (!match) return null;
    const conversationId = match[1];
    if (!conversationId) return null;
    return {
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      conversationId
    };
  }
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
