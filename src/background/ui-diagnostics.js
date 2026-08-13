export async function inspectChatGptUi(tabManager) {
  const tab = await tabManager.findChatGptTab();
  const diagnostics = await tabManager.send(tab.id, { type: 'CHATGPT_UI_DIAGNOSTICS' });
  const items = Array.isArray(diagnostics?.controls) ? diagnostics.controls : [];
  return {
    tabId: tab.id,
    url: tab.url ?? 'https://chatgpt.com/',
    selectorProfile: diagnostics?.selectorProfile ?? null,
    count: items.length,
    items
  };
}
