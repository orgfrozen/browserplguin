import { RunnerError, ERROR_CODES } from '../shared/errors.js';
export async function inspectChatGptUi(tabManager) {
  const tab = await tabManager.findChatGptTab();
  const diagnostics = await tabManager.send(tab.id, { type: 'CHATGPT_UI_DIAGNOSTICS' });
  if (diagnostics?.ok === false) {
    throw new RunnerError(diagnostics.error?.code ?? ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, diagnostics.error?.message ?? 'ChatGPT UI diagnostics failed', diagnostics.error);
  }
  const items = Array.isArray(diagnostics?.controls) ? diagnostics.controls : [];
  return {
    tabId: tab.id,
    url: tab.url ?? 'https://chatgpt.com/',
    selectorProfile: diagnostics?.selectorProfile ?? null,
    count: items.length,
    items
  };
}
