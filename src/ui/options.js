const ids = [
  'mode', 'taskApiBaseUrl', 'taskApiToken', 'heartbeatIntervalMs',
  'fallbackLimit', 'maxTaskRounds', 'patchDownloadTimeoutMs', 'patchTransferMode'
];
const numeric = new Set(['heartbeatIntervalMs', 'fallbackLimit', 'maxTaskRounds', 'patchDownloadTimeoutMs']);

async function load() {
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  for (const id of ids) {
    const element = document.getElementById(id);
    if (settings[id] !== undefined) element.value = String(settings[id]);
  }
}

async function requestEndpointPermission(baseUrl) {
  if (!baseUrl) return;
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Task API 必须使用 http/https');
  const origin = `${url.protocol}//${url.host}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`未授予 Task API 域名权限：${origin}`);
}

document.getElementById('save').addEventListener('click', async () => {
  const message = document.getElementById('message');
  try {
    const settings = Object.fromEntries(ids.map(id => {
      const value = document.getElementById(id).value;
      return [id, numeric.has(id) ? Number(value) : value];
    }));
    await requestEndpointPermission(settings.taskApiBaseUrl);
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    message.textContent = '已保存';
  } catch (error) {
    message.textContent = `保存失败：${error.message}`;
  }
});

load().catch(error => { document.getElementById('message').textContent = `读取失败：${error.message}`; });
