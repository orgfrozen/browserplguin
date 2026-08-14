function compactPreflight(result) {
  return {
    status: result?.status === 'ready' ? 'ready' : 'blocked',
    ready_for_remote_e2e: result?.ready_for_remote_e2e === true,
    blockers: Array.isArray(result?.blockers)
      ? result.blockers.filter(value => typeof value === 'string').slice(0, 16)
      : [],
    checked_at: typeof result?.checked_at === 'string' ? result.checked_at : null
  };
}

function codedError(code, message, blockers = []) {
  const error = new Error(message);
  error.code = code;
  error.blockers = blockers.slice(0, 16);
  return error;
}

export async function enableRemoteE2eTestMode({ settings = {}, runPreflight, storage }) {
  const preflight = compactPreflight(await runPreflight());
  if (!preflight.ready_for_remote_e2e) {
    const next = { ...settings, remoteE2eTestMode: false, patchTransferMode: 'local' };
    await storage.set('settings', next);
    return {
      status: 'blocked',
      enabled: false,
      patch_transfer_mode: 'local',
      preflight
    };
  }

  const next = { ...settings, remoteE2eTestMode: true, patchTransferMode: 'remote' };
  await storage.set('settings', next);
  return {
    status: 'enabled',
    enabled: true,
    patch_transfer_mode: 'remote',
    preflight
  };
}

export async function disableRemoteE2eTestMode({ settings = {}, storage }) {
  await storage.set('settings', { ...settings, remoteE2eTestMode: false, patchTransferMode: 'local' });
  return { status: 'disabled', enabled: false, patch_transfer_mode: 'local' };
}

export function buildSafeSettingsUpdate({ defaults = {}, current = {}, incoming = {} } = {}) {
  return {
    ...defaults,
    ...current,
    ...incoming,
    remoteE2eTestMode: false,
    patchTransferMode: 'local'
  };
}

export async function assertRemoteE2eTestModeReady({ settings = {}, runPreflight }) {
  if (settings.patchTransferMode !== 'remote') return { status: 'not_required' };
  if (settings.remoteE2eTestMode !== true) {
    throw codedError(
      'REMOTE_E2E_TEST_MODE_REQUIRED',
      'Remote transfer requires explicit Remote E2E test mode enablement'
    );
  }

  const preflight = compactPreflight(await runPreflight());
  if (!preflight.ready_for_remote_e2e) {
    throw codedError(
      'REMOTE_E2E_PREFLIGHT_BLOCKED',
      `Remote E2E preflight blocked: ${preflight.blockers.join(',') || 'UNKNOWN_BLOCKER'}`,
      preflight.blockers
    );
  }
  return preflight;
}
