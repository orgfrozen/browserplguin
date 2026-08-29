export async function probeChatGptAccessTabs(tabs) {
  if (!tabs || typeof tabs.query !== 'function' || typeof tabs.sendMessage !== 'function') {
    throw new TypeError('tabs query/sendMessage API is required');
  }
  const matches = await tabs.query({ url: 'https://chatgpt.com/*' });
  let readyTabs = 0;
  let limitedTabs = 0;
  let unavailableTabs = 0;
  let checkedTabs = 0;
  for (const tab of matches ?? []) {
    if (!Number.isInteger(tab?.id)) continue;
    checkedTabs += 1;
    try {
      const state = await tabs.sendMessage(tab.id, { type: 'CHATGPT_ACCESS_STATE' });
      if (state?.status === 'READY') readyTabs += 1;
      else if (state?.status === 'USAGE_LIMITED') limitedTabs += 1;
      else unavailableTabs += 1;
    } catch {
      unavailableTabs += 1;
    }
  }
  return {
    status: readyTabs > 0 ? 'healthy' : limitedTabs > 0 ? 'limited' : 'unknown',
    checked_tabs: checkedTabs,
    ready_tabs: readyTabs,
    limited_tabs: limitedTabs,
    unavailable_tabs: unavailableTabs
  };
}
