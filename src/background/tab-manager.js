import { RunnerError, ERROR_CODES } from '../shared/errors.js';

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

  send(tabId, message) { return this.tabs.sendMessage(tabId, message); }
}
