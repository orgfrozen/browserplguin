function safeCount(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

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

export function buildRemoteProductionStatus({ settings = {}, evidenceSummary = {} } = {}) {
  const passedRuns = safeCount(evidenceSummary?.passed_runs);
  const enabled = settings.patchTransferMode === 'remote'
    && settings.remoteProductionMode === true
    && settings.remoteE2eTestMode !== true;
  return {
    enabled,
    eligible_evidence: passedRuns >= 1,
    passed_runs: passedRuns,
    patch_transfer_mode: settings.patchTransferMode === 'remote' ? 'remote' : 'local'
  };
}

export async function enableRemoteProductionMode({ settings = {}, evidenceSummary = {}, runPreflight, storage }) {
  const status = buildRemoteProductionStatus({ settings, evidenceSummary });
  if (!status.eligible_evidence) {
    return {
      status: 'blocked',
      enabled: false,
      eligible_evidence: false,
      passed_runs: status.passed_runs,
      patch_transfer_mode: settings.patchTransferMode === 'remote' ? 'remote' : 'local',
      blockers: ['REMOTE_E2E_EVIDENCE_REQUIRED']
    };
  }

  const preflight = compactPreflight(await runPreflight());
  if (!preflight.ready_for_remote_e2e) {
    return {
      status: 'blocked',
      enabled: false,
      eligible_evidence: true,
      passed_runs: status.passed_runs,
      patch_transfer_mode: settings.patchTransferMode === 'remote' ? 'remote' : 'local',
      blockers: preflight.blockers
    };
  }

  const next = {
    ...settings,
    remoteE2eTestMode: false,
    remoteProductionMode: true,
    patchTransferMode: 'remote'
  };
  await storage.set('settings', next);
  return {
    status: 'enabled',
    enabled: true,
    eligible_evidence: true,
    passed_runs: status.passed_runs,
    patch_transfer_mode: 'remote',
    preflight
  };
}

export async function disableRemoteProductionMode({ settings = {}, storage }) {
  await storage.set('settings', {
    ...settings,
    remoteE2eTestMode: false,
    remoteProductionMode: false,
    patchTransferMode: 'local'
  });
  return { status: 'disabled', enabled: false, patch_transfer_mode: 'local' };
}

export async function assertRemoteProductionReady({ settings = {}, evidenceSummary = {}, runPreflight }) {
  if (settings.patchTransferMode !== 'remote') return { status: 'not_required' };
  if (settings.remoteProductionMode !== true) {
    throw codedError('REMOTE_PRODUCTION_MODE_REQUIRED', 'Production remote mode is not enabled');
  }
  if (settings.remoteE2eTestMode === true) {
    throw codedError('REMOTE_MODE_CONFLICT', 'Remote E2E test mode and production mode cannot be enabled together');
  }
  if (safeCount(evidenceSummary?.passed_runs) < 1) {
    throw codedError('REMOTE_PRODUCTION_EVIDENCE_REQUIRED', 'Production remote mode requires passed Remote E2E evidence');
  }

  const preflight = compactPreflight(await runPreflight());
  if (!preflight.ready_for_remote_e2e) {
    throw codedError(
      'REMOTE_PRODUCTION_PREFLIGHT_BLOCKED',
      `Production remote preflight blocked: ${preflight.blockers.join(',') || 'UNKNOWN_BLOCKER'}`,
      preflight.blockers
    );
  }
  return preflight;
}
