import { RunnerError, ERROR_CODES } from '../shared/errors.js';

function isMissingReceiverError(error) {
  const message = String(error?.message ?? error ?? '');
  return /receiving end does not exist|could not establish connection/i.test(message);
}

export class TabManager {
  constructor(tabs = chrome.tabs) { this.tabs = tabs; }

  async findChatGptTab() {
    const matches = await this.tabs.query({ url: 'https://chatgpt.com/*' });
    if (matches.length === 0) {
      const authTabs = await this.tabs.query({ url: 'https://auth.openai.com/*' });
      if (authTabs.length > 0) {
        throw new RunnerError(ERROR_CODES.LOGIN_OR_CHALLENGE_REQUIRED, 'OpenAI authentication is required before ChatGPT automation can continue');
      }
      throw new RunnerError(ERROR_CODES.PROJECT_NOT_FOUND, 'No open chatgpt.com tab found');
    }
    if (matches.length > 1) {
      const active = matches.find(tab => tab.active);
      if (active) return active;
    }
    return matches[0];
  }

  async #waitComplete(tabId, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = 250, timeoutMs = 30000 } = {}) {
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
    for (let i = 0; i < attempts; i++) {
      const tab = await this.tabs.get(tabId);
      if (tab?.status === 'complete') return tab;
      await sleep(pollMs);
    }
    throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, `ChatGPT tab ${tabId} did not finish navigation before timeout`);
  }

  async getTab(tabId) { return this.tabs.get(tabId); }

  async createChatGptTab(options = {}) {
    const tab = await this.tabs.create({ url: 'https://chatgpt.com/', active: true });
    if (!Number.isInteger(tab?.id)) {
      throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'Unable to create a dedicated ChatGPT tab');
    }
    return this.#waitComplete(tab.id, options);
  }

  async activateTab(tabId) {
    return this.tabs.update(tabId, { active: true });
  }

  async reloadTab(tabId, options = {}) {
    await this.tabs.reload(tabId);
    return this.#waitComplete(tabId, options);
  }

  async navigateTab(tabId, url, options = {}) {
    await this.tabs.update(tabId, { url });
    return this.#waitComplete(tabId, options);
  }

  async send(tabId, message, options = {}) {
    try {
      return await this.tabs.sendMessage(tabId, message);
    } catch (error) {
      if (!isMissingReceiverError(error)) throw error;
      const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const pollMs = options.pollMs ?? 250;
      const timeoutMs = options.timeoutMs ?? 8000;
      await this.reloadTab(tabId, { sleep, pollMs, timeoutMs });
      const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
      let lastError = error;
      for (let i = 0; i < attempts; i += 1) {
        try {
          return await this.tabs.sendMessage(tabId, message);
        } catch (retryError) {
          if (!isMissingReceiverError(retryError)) throw retryError;
          lastError = retryError;
          await sleep(pollMs);
        }
      }
      throw lastError;
    }
  }
}
