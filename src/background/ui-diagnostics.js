export async function inspectChatGptUi(tabManager) {
  const tab = await tabManager.findChatGptTab();
  const items = await tabManager.send(tab.id, { type: 'CHATGPT_UI_DIAGNOSTICS' });
  return {
    tabId: tab.id,
    url: tab.url ?? 'https://chatgpt.com/',
    count: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items) ? items : []
  };
}
