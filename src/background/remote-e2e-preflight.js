const STORAGE_KEY = 'remoteE2ePreflight';
const REQUIRED_PATCH_BYTES = 32 * 1024 * 1024;

export const REMOTE_E2E_BLOCKERS = Object.freeze({
  MODE_NOT_REAL: 'MODE_NOT_REAL',
  TASK_API_URL_INVALID: 'TASK_API_URL_INVALID',
  TASK_API_PERMISSION_MISSING: 'TASK_API_PERMISSION_MISSING',
  NATIVE_MESSAGING_PERMISSION_MISSING: 'NATIVE_MESSAGING_PERMISSION_MISSING',
  NATIVE_HELPER_UNAVAILABLE: 'NATIVE_HELPER_UNAVAILABLE',
  HELPER_READ_PATCH_FILE_MISSING: 'HELPER_READ_PATCH_FILE_MISSING',
  HELPER_CHUNKED_MISSING: 'HELPER_CHUNKED_MISSING',
  HELPER_MAX_PATCH_BYTES_INSUFFICIENT: 'HELPER_MAX_PATCH_BYTES_INSUFFICIENT'
});

function taskApiOrigin(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

function hasNativeMessaging(manifest) {
  return Array.isArray(manifest?.permissions) && manifest.permissions.includes('nativeMessaging');
}

function helperChecks(result) {
  const capabilities = result?.capabilities ?? {};
  return {
    native_helper: 'ready',
    helper_read_patch_file: capabilities.read_patch_file === true,
    helper_chunked: capabilities.chunked === true,
    helper_max_patch_bytes_sufficient: Number.isInteger(capabilities.max_patch_bytes)
      && capabilities.max_patch_bytes >= REQUIRED_PATCH_BYTES
  };
}

export async function runRemoteE2ePreflight({ settings = {}, permissions, manifest = {}, reader, storage, now = () => new Date().toISOString() }) {
  const origin = taskApiOrigin(settings.taskApiBaseUrl);
  const modeReal = settings.mode === 'real';
  const nativeMessagingPermission = hasNativeMessaging(manifest);
  let taskApiPermission = false;
  if (origin && permissions?.contains) {
    try {
      taskApiPermission = await permissions.contains({ origins: [origin] });
    } catch {
      taskApiPermission = false;
    }
  }

  let helper = {
    native_helper: 'unavailable',
    helper_read_patch_file: false,
    helper_chunked: false,
    helper_max_patch_bytes_sufficient: false
  };
  try {
    helper = helperChecks(await reader.checkReady());
  } catch {
    // Keep a stable unavailable summary; native error text must never escape.
  }

  const checks = {
    mode_real: modeReal,
    task_api_url_valid: Boolean(origin),
    task_api_permission: Boolean(taskApiPermission),
    native_messaging_permission: nativeMessagingPermission,
    ...helper
  };

  const blockers = [];
  if (!checks.mode_real) blockers.push(REMOTE_E2E_BLOCKERS.MODE_NOT_REAL);
  if (!checks.task_api_url_valid) blockers.push(REMOTE_E2E_BLOCKERS.TASK_API_URL_INVALID);
  if (!checks.task_api_permission) blockers.push(REMOTE_E2E_BLOCKERS.TASK_API_PERMISSION_MISSING);
  if (!checks.native_messaging_permission) blockers.push(REMOTE_E2E_BLOCKERS.NATIVE_MESSAGING_PERMISSION_MISSING);
  if (checks.native_helper !== 'ready') {
    blockers.push(REMOTE_E2E_BLOCKERS.NATIVE_HELPER_UNAVAILABLE);
  } else {
    if (!checks.helper_read_patch_file) blockers.push(REMOTE_E2E_BLOCKERS.HELPER_READ_PATCH_FILE_MISSING);
    if (!checks.helper_chunked) blockers.push(REMOTE_E2E_BLOCKERS.HELPER_CHUNKED_MISSING);
    if (!checks.helper_max_patch_bytes_sufficient) blockers.push(REMOTE_E2E_BLOCKERS.HELPER_MAX_PATCH_BYTES_INSUFFICIENT);
  }

  const summary = {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    ready_for_remote_e2e: blockers.length === 0,
    checks,
    blockers,
    checked_at: now()
  };
  await storage.set(STORAGE_KEY, summary);
  return summary;
}

export async function getRemoteE2ePreflight(storage) {
  return (await storage.get(STORAGE_KEY)) ?? {
    status: 'never_checked',
    ready_for_remote_e2e: false,
    blockers: []
  };
}
