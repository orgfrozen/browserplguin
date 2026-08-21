const ids = [
  'mode', 'taskApiBaseUrl', 'taskApiToken', 'agentId', 'heartbeatIntervalMs',
  'fallbackLimit', 'maxTaskRounds', 'composerPollIntervalMs', 'composerStallTimeoutMs', 'workspaceMaxRetries', 'patchDownloadTimeoutMs', 'patchTransferMode'
];
const numeric = new Set(['heartbeatIntervalMs', 'fallbackLimit', 'maxTaskRounds', 'composerPollIntervalMs', 'composerStallTimeoutMs', 'workspaceMaxRetries', 'patchDownloadTimeoutMs']);

function renderDiagnosticScreenshotPolicy(policy) {
  const status = document.getElementById('diagnosticScreenshotPolicyStatus');
  const rules = document.getElementById('diagnosticScreenshotPolicyRules');
  if (!policy || policy.capture_enabled !== false) {
    status.textContent = 'unavailable';
    rules.textContent = '策略不可用；截图保持禁用。';
    return;
  }
  status.textContent = `disabled by policy · v${policy.version ?? '?'}`;
  rules.textContent = '未来实现必须显式 opt-in；仅 UI_SELECTOR_INCOMPATIBLE + READY/chat；只允许语义控件区域 + solid-mask redaction。整页截图、自由坐标、OCR、文本提取、持久化、导出和上传均禁止。';
}

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


function renderRemoteE2ePreflight(result) {
  const status = document.getElementById('remoteE2ePreflightStatus');
  const blockers = document.getElementById('remoteE2ePreflightBlockers');
  if (!result || result.status === 'never_checked') {
    status.textContent = '未检测';
    blockers.textContent = '该检查无副作用：不会 claim Task、读取 Patch、上传 artifact 或启用 remote。';
    return;
  }
  if (result.ready_for_remote_e2e === true) {
    status.textContent = 'ready · 可以开始真实 remote E2E';
    blockers.textContent = '前置条件已满足；可显式启用 Remote E2E 测试模式。正式 remote 选项仍保持锁定。';
    return;
  }
  status.textContent = 'blocked';
  blockers.textContent = Array.isArray(result.blockers) && result.blockers.length
    ? `阻塞项：${result.blockers.join(' · ')}`
    : '阻塞项未知';
}


function renderRemoteE2eTestMode(settings) {
  const enabled = settings?.remoteE2eTestMode === true && settings?.patchTransferMode === 'remote';
  const status = document.getElementById('remoteE2eTestModeStatus');
  const enable = document.getElementById('enableRemoteE2eTestMode');
  const disable = document.getElementById('disableRemoteE2eTestMode');
  status.textContent = enabled ? 'enabled · remote (E2E test only)' : 'disabled · local';
  enable.disabled = enabled;
  disable.disabled = !enabled;
  document.getElementById('patchTransferMode').value = enabled ? 'remote' : 'local';
}

function renderRemoteProduction(result, settings = {}) {
  const enabled = result?.enabled === true;
  const eligible = result?.eligible_evidence === true;
  const passedRuns = Number.isInteger(result?.passed_runs) ? result.passed_runs : 0;
  document.getElementById('remoteProductionStatus').textContent = enabled
    ? 'enabled · production remote'
    : eligible ? 'eligible · explicit promotion required' : 'locked · passed evidence required';
  document.getElementById('remoteProductionEvidence').textContent = `passed ${passedRuns}`;
  document.getElementById('promoteRemoteProduction').disabled = enabled || !eligible;
  document.getElementById('disableRemoteProduction').disabled = !enabled;
  const remoteOption = document.querySelector('#patchTransferMode option[value="remote"]');
  remoteOption.disabled = !enabled;
  const testEnabled = settings?.remoteE2eTestMode === true && settings?.patchTransferMode === 'remote';
  document.getElementById('patchTransferMode').value = enabled || testEnabled ? 'remote' : 'local';
}

async function load() {
  document.getElementById('nativeHelperExtensionId').textContent = chrome.runtime.id;
  const [settings, helperStatus, remotePreflight, remoteProduction, screenshotPolicy] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
    chrome.runtime.sendMessage({ type: 'GET_NATIVE_HELPER_STATUS' }),
    chrome.runtime.sendMessage({ type: 'GET_REMOTE_E2E_PREFLIGHT' }),
    chrome.runtime.sendMessage({ type: 'GET_REMOTE_PRODUCTION_STATUS' }),
    chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTIC_SCREENSHOT_POLICY' })
  ]);
  for (const id of ids) {
    const element = document.getElementById(id);
    if (settings[id] !== undefined) element.value = String(settings[id]);
  }
  renderNativeHelperStatus(helperStatus);
  renderRemoteE2ePreflight(remotePreflight);
  renderRemoteE2eTestMode(settings);
  renderRemoteProduction(remoteProduction, settings);
  renderDiagnosticScreenshotPolicy(screenshotPolicy);
}

function resourcePermissionPattern(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('资源 URL 必须是绝对 http/https URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('资源 URL 必须使用 http/https');
  if (url.username || url.password) throw new Error('资源 URL 不能包含用户名或密码');
  return `${url.protocol}//${url.host}/*`;
}

function setResourcePermissionStatus(text) {
  document.getElementById('resourcePermissionStatus').textContent = text;
}

function currentResourcePermissionPattern() {
  return resourcePermissionPattern(document.getElementById('resourcePermissionUrl').value);
}

function currentTaskApiConnectionSettings() {
  return {
    taskApiBaseUrl: document.getElementById('taskApiBaseUrl').value.trim(),
    taskApiToken: document.getElementById('taskApiToken').value,
    agentId: document.getElementById('agentId').value.trim()
  };
}

function renderTaskApiConnection(result) {
  const status = document.getElementById('taskApiConnectionStatus');
  if (result?.connected === true) {
    const presence = result.presence ? ` · ${result.presence}` : '';
    status.textContent = `连接成功 · Agent ${result.agent_id} · protocol v${result.protocol_version}${presence}`;
    return;
  }
  if (result?.status === 401) {
    status.textContent = '连接失败 · 401 · Task API Token 无效';
    return;
  }
  if (result?.error_code === 'agent_not_found') {
    status.textContent = `连接失败 · Agent ${document.getElementById('agentId').value.trim() || '?'} 不存在`;
    return;
  }
  if (result?.error_code === 'task_protocol_incompatible') {
    status.textContent = '连接失败 · Agent Control 协议不兼容';
    return;
  }
  if (result?.error_code === 'invalid_connection_settings') {
    status.textContent = `连接失败 · ${result.error_message ?? '连接配置无效'}`;
    return;
  }
  const detail = result?.error_message ? ` · ${result.error_message}` : '';
  status.textContent = `连接失败 · 无法连接 Task API${detail}`;
}

async function requestEndpointPermission(baseUrl) {
  if (!baseUrl) return;
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Task API 必须使用 http/https');
  const origin = `${url.protocol}//${url.host}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`未授予 Task API 域名权限：${origin}`);
}


document.getElementById('testTaskApiConnection').addEventListener('click', async () => {
  const status = document.getElementById('taskApiConnectionStatus');
  status.textContent = '连接中…';
  try {
    const settings = currentTaskApiConnectionSettings();
    await requestEndpointPermission(settings.taskApiBaseUrl);
    const result = await chrome.runtime.sendMessage({ type: 'TEST_TASK_API_CONNECTION', settings });
    renderTaskApiConnection(result);
  } catch (error) {
    status.textContent = `连接失败 · ${error.message}`;
  }
});

document.getElementById('enableRemoteE2eTestMode').addEventListener('click', async () => {
  const status = document.getElementById('remoteE2eTestModeStatus');
  status.textContent = '启用前检测中…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ENABLE_REMOTE_E2E_TEST_MODE' });
    if (result?.preflight) renderRemoteE2ePreflight(result.preflight);
    renderRemoteE2eTestMode({
      remoteE2eTestMode: result?.enabled === true,
      remoteProductionMode: false,
      patchTransferMode: result?.patch_transfer_mode ?? 'local'
    });
    await load();
  } catch (error) {
    status.textContent = `启用失败：${error.message}`;
  }
});

document.getElementById('disableRemoteE2eTestMode').addEventListener('click', async () => {
  const status = document.getElementById('remoteE2eTestModeStatus');
  status.textContent = '关闭中…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'DISABLE_REMOTE_E2E_TEST_MODE' });
    renderRemoteE2eTestMode({
      remoteE2eTestMode: result?.enabled === true,
      remoteProductionMode: false,
      patchTransferMode: result?.patch_transfer_mode ?? 'local'
    });
    await load();
  } catch (error) {
    status.textContent = `关闭失败：${error.message}`;
  }
});

document.getElementById('promoteRemoteProduction').addEventListener('click', async () => {
  const status = document.getElementById('remoteProductionStatus');
  status.textContent = 'promotion 检测中…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'PROMOTE_REMOTE_PRODUCTION' });
    if (result?.preflight) renderRemoteE2ePreflight(result.preflight);
    if (result?.status === 'blocked') {
      status.textContent = `blocked · ${(result.blockers ?? []).join(' · ') || 'UNKNOWN_BLOCKER'}`;
    }
    await load();
  } catch (error) {
    status.textContent = `promotion 失败：${error.message}`;
  }
});

document.getElementById('disableRemoteProduction').addEventListener('click', async () => {
  const status = document.getElementById('remoteProductionStatus');
  status.textContent = '恢复 local 中…';
  try {
    await chrome.runtime.sendMessage({ type: 'DISABLE_REMOTE_PRODUCTION' });
    await load();
  } catch (error) {
    status.textContent = `关闭失败：${error.message}`;
  }
});

document.getElementById('checkRemoteE2ePreflight').addEventListener('click', async () => {
  const status = document.getElementById('remoteE2ePreflightStatus');
  status.textContent = '检测中…';
  try {
    renderRemoteE2ePreflight(await chrome.runtime.sendMessage({ type: 'CHECK_REMOTE_E2E_PREFLIGHT' }));
  } catch (error) {
    status.textContent = `检测失败：${error.message}`;
  }
});

document.getElementById('checkNativeHelper').addEventListener('click', async () => {
  const status = document.getElementById('nativeHelperStatus');
  status.textContent = '检测中…';
  try {
    renderNativeHelperStatus(await chrome.runtime.sendMessage({ type: 'CHECK_NATIVE_HELPER' }));
  } catch (error) {
    status.textContent = `检测失败：${error.message}`;
  }
});

document.getElementById('checkResourcePermission').addEventListener('click', async () => {
  try {
    const originPattern = currentResourcePermissionPattern();
    const granted = await chrome.permissions.contains({ origins: [originPattern] });
    setResourcePermissionStatus(`${granted ? 'granted' : 'missing'} · ${originPattern}`);
  } catch {
    setResourcePermissionStatus('invalid');
  }
});

document.getElementById('grantResourcePermission').addEventListener('click', async () => {
  try {
    const originPattern = currentResourcePermissionPattern();
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    setResourcePermissionStatus(`${granted ? 'granted' : 'denied'} · ${originPattern}`);
  } catch {
    setResourcePermissionStatus('invalid');
  }
});

document.getElementById('revokeResourcePermission').addEventListener('click', async () => {
  try {
    const originPattern = currentResourcePermissionPattern();
    const removed = await chrome.permissions.remove({ origins: [originPattern] });
    setResourcePermissionStatus(`${removed ? 'removed' : 'missing'} · ${originPattern}`);
  } catch {
    setResourcePermissionStatus('invalid');
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
    const saved = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    renderRemoteE2eTestMode(saved);
    renderRemoteProduction(await chrome.runtime.sendMessage({ type: 'GET_REMOTE_PRODUCTION_STATUS' }), saved);
    message.textContent = '已保存；Remote E2E/Production 模式已退出并恢复 local';
  } catch (error) {
    message.textContent = `保存失败：${error.message}`;
  }
});

load().catch(error => { document.getElementById('message').textContent = `读取失败：${error.message}`; });
