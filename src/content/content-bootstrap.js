(async () => {
  const moduleUrl = chrome.runtime.getURL('src/content/content-script.js');
  const { installContentScript } = await import(moduleUrl);
  installContentScript();
})().catch(error => console.error('[ChatGPT Web Task Runner] content bootstrap failed', error));
