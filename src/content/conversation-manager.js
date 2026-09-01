import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { getActiveSelectorProfile } from '../shared/selector-registry.js';
import { elementSemanticText, findUniqueSemantic, isElementVisible } from './ui-semantics.js';

const SELECTOR_PROFILE = getActiveSelectorProfile();
const CONVERSATION_PATTERNS = SELECTOR_PROFILE.patterns.conversation;
const CONVERSATION_SELECTORS = SELECTOR_PROFILE.selectors;

function normalizeConversationId(value) {
  const id = String(value ?? '').trim();
  if (!id || /[/?#]/.test(id)) return null;
  return id;
}

function conversationIdFromHref(href) {
  try {
    const url = new URL(String(href ?? ''), 'https://chatgpt.com/');
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'chatgpt.com') return null;
    const match = url.pathname.match(/^\/c\/([^/]+)\/?$/);
    if (!match?.[1]) return null;
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  } catch {
    return null;
  }
}

function isExactSidebarNewChatControl(node) {
  if (String(node?.tagName ?? '').toUpperCase() !== 'A') return false;
  if (String(node?.getAttribute?.('data-testid') ?? '').trim() !== 'create-new-chat-button') return false;
  if (String(node?.getAttribute?.('data-sidebar-item') ?? '').trim().toLowerCase() !== 'true') return false;
  try {
    const href = new URL(String(node?.getAttribute?.('href') ?? ''), 'https://chatgpt.com/');
    return href.protocol === 'https:' && href.hostname.toLowerCase() === 'chatgpt.com' && href.pathname === '/';
  } catch {
    return false;
  }
}

export class ConversationManager {
  constructor(root = document, {
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollMs = 200,
    timeoutMs = 8000
  } = {}) {
    this.root = root;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
  }

  async waitFor(read, { label = 'ChatGPT conversation UI', timeoutMs = this.timeoutMs } = {}) {
    const attempts = Math.max(1, Math.ceil(timeoutMs / this.pollMs));
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const value = read();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await this.sleep(this.pollMs);
    }
    if (lastError) throw lastError;
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, `${label} did not appear before timeout`);
  }

  findNewChatControl({ required = true, label = 'New Chat control' } = {}) {
    const visibleControls = [...(this.root?.querySelectorAll?.(CONVERSATION_SELECTORS.conversationControls) ?? [])]
      .filter(isElementVisible);
    const exactSidebar = visibleControls.filter(isExactSidebarNewChatControl);
    if (exactSidebar.length === 1) return exactSidebar[0];
    if (exactSidebar.length > 1) {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, `${label} exact sidebar control is ambiguous`, {
        selector: CONVERSATION_SELECTORS.conversationControls,
        matches: exactSidebar.slice(0, 10).map(elementSemanticText)
      });
    }
    return findUniqueSemantic(
      this.root,
      CONVERSATION_SELECTORS.conversationControls,
      CONVERSATION_PATTERNS.newChat,
      { required, label }
    );
  }

  prepareNewChat() {
    const control = this.findNewChatControl();
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

  listVisibleConversationAnchors() {
    return [...(this.root?.querySelectorAll?.('a[href]') ?? [])]
      .filter(isElementVisible)
      .map(element => ({ element, conversationId: conversationIdFromHref(element.getAttribute?.('href')) }))
      .filter(item => item.conversationId);
  }

  exactConversationAnchor(conversationId) {
    const expected = normalizeConversationId(conversationId);
    if (!expected) {
      throw new RunnerError(ERROR_CODES.CHAT_IDENTITY_MISSING, 'Conversation cleanup requires an exact conversation id');
    }
    const exact = this.listVisibleConversationAnchors().filter(item => item.conversationId === expected);
    if (exact.length === 1) return exact[0].element;
    if (exact.length > 1) {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, `Owned conversation row is ambiguous for ${expected}`);
    }
    return null;
  }

  conversationSidebarLoaded() {
    if (this.listVisibleConversationAnchors().length > 0) return true;
    return Boolean(this.findNewChatControl({
      required: false,
      label: 'New Chat control for conversation sidebar'
    }));
  }

  findNearbyConversationMenu(anchor, { required = true } = {}) {
    for (let scope = anchor?.parentElement ?? null, depth = 0; scope && depth < 4; scope = scope.parentElement, depth += 1) {
      const buttons = [...(scope.querySelectorAll?.(CONVERSATION_SELECTORS.semanticButtons) ?? [])].filter(isElementVisible);
      const matches = buttons.filter(button => CONVERSATION_PATTERNS.menu.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(elementSemanticText(button));
      }));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Owned conversation menu is ambiguous inside the exact conversation row');
      }
    }
    if (!required) return null;
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Owned conversation menu was not found inside the exact conversation row');
  }

  revealConversationRowControl(anchor) {
    const eventTypes = ['pointerover', 'mouseover', 'mouseenter'];
    for (let scope = anchor, depth = 0; scope && depth < 3; scope = scope.parentElement, depth += 1) {
      for (const type of eventTypes) {
        try {
          const EventCtor = globalThis.MouseEvent ?? globalThis.Event;
          scope.dispatchEvent?.(EventCtor ? new EventCtor(type, { bubbles: true }) : { type });
        } catch {
          scope.dispatchEvent?.({ type });
        }
      }
    }
  }

  listVisibleDialogs() {
    const nodes = [
      ...(this.root?.querySelectorAll?.(CONVERSATION_SELECTORS.dialogs) ?? []),
      ...(this.root?.querySelectorAll?.('dialog[open]') ?? [])
    ];
    return [...new Set(nodes)].filter(isElementVisible);
  }

  async deleteConversationById(conversationId) {
    const expected = normalizeConversationId(conversationId);
    if (!expected) {
      throw new RunnerError(ERROR_CODES.CHAT_IDENTITY_MISSING, 'Conversation cleanup requires an exact conversation id');
    }

    const anchor = this.exactConversationAnchor(expected);
    if (!anchor) {
      if (!this.conversationSidebarLoaded()) {
        throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Conversation sidebar is not loaded; exact absence cannot be proven');
      }
      return { deleted: false, alreadyMissing: true, conversationId: expected };
    }

    let menu = this.findNearbyConversationMenu(anchor, { required: false });
    if (!menu) {
      this.revealConversationRowControl(anchor);
      menu = await this.waitFor(
        () => this.findNearbyConversationMenu(anchor, { required: false }),
        { label: `Owned conversation menu for ${expected}`, timeoutMs: Math.min(this.timeoutMs, 2500) }
      );
    }
    menu.click?.();

    const deleteAction = await this.waitFor(() => findUniqueSemantic(
      this.root,
      '[role="menuitem"], button, [role="button"]',
      CONVERSATION_PATTERNS.delete,
      { required: false, label: 'Delete conversation action' }
    ), { label: 'Delete conversation action' });
    deleteAction.click?.();

    const dialog = await this.waitFor(() => {
      const dialogs = this.listVisibleDialogs();
      if (dialogs.length === 1) return dialogs[0];
      if (dialogs.length > 1) {
        throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Delete conversation confirmation dialog is ambiguous');
      }
      return null;
    }, { label: 'Delete conversation confirmation dialog' });

    const confirm = findUniqueSemantic(
      dialog,
      CONVERSATION_SELECTORS.semanticButtons,
      CONVERSATION_PATTERNS.confirmDelete,
      { label: 'Delete conversation confirmation' }
    );
    confirm.click?.();

    await this.waitFor(
      () => this.exactConversationAnchor(expected) ? null : true,
      { label: `Conversation deletion ${expected}` }
    );
    return { deleted: true, alreadyMissing: false, conversationId: expected };
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
    const messages = [...this.root.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')];
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
