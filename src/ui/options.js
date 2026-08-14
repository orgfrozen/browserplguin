const ids = [
  'mode', 'taskApiBaseUrl', 'taskApiToken', 'heartbeatIntervalMs',
  'fallbackLimit', 'maxTaskRounds', 'patchDownloadTimeoutMs', 'patchTransferMode'
];
const numeric = new Set(['heartbeatIntervalMs', 'fallbackLimit', 'maxTaskRounds', 'patchDownloadTimeoutMs']);

function renderNativeHelperStatus(status) {
  const element = document.getElementById('nativeHelperStatus');
  if (!status || status.status === 'never_checked') {
    element.textContent = '未检测';
    return;
  }
  if (status.status === 'ready') {
    const maxMiB = Number.isInteger(status.capabilities?.max_patch_bytes)
      ? Math.floor(status.capabilities.max_patch_bytes / (1024 * 1024))
      : null;
    element.textContent = `ready · protocol v${status.protocol_version ?? '?'}${maxMiB ? ` · ${maxMiB} MiB` : ''}`;
    return;
  }
  element.textContent = `不可用 · ${status.error_code ?? 'NATIVE_HELPER_UNAVAILABLE'}`;
}

async function load() {
  document.getElementById('nativeHelperExtensionId').textContent = chrome.runtime.id;
  const [settings, helperStatus] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
    chrome.runtime.sendMessage({ type: 'GET_NATIVE_HELPER_STATUS' })
  ]);
  for (const id of ids) {
    const element = document.getElementById(id);
    if (settings[id] !== undefined) element.value = String(settings[id]);
  }
  renderNativeHelperStatus(helperStatus);
}

async function requestEndpointPermission(baseUrl) {
  if (!baseUrl) return;
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Task API 必须使用 http/https');
  const origin = `${url.protocol}//${url.host}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`未授予 Task API 域名权限：${origin}`);
}

document.getElementById('checkNativeHelper').addEventListener('click', async () => {
  const status = document.getElementById('nativeHelperStatus');
  status.textContent = '检测中…';
  try {
    renderNativeHelperStatus(await chrome.runtime.sendMessage({ type: 'CHECK_NATIVE_HELPER' }));
  } catch (error) {
    status.textContent = `检测失败：${error.message}`;
  }
});

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
