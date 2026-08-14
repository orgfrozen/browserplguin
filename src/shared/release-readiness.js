export const RELEASE_READINESS_BLOCKERS = Object.freeze({
  CALIBRATION_INCOMPLETE: 'CALIBRATION_INCOMPLETE',
  CALIBRATION_NEEDS_REVIEW: 'CALIBRATION_NEEDS_REVIEW',
  RESOURCE_E2E_REQUIRED: 'RESOURCE_E2E_REQUIRED',
  REMOTE_E2E_REQUIRED: 'REMOTE_E2E_REQUIRED',
  REMOTE_PRODUCTION_REQUIRED: 'REMOTE_PRODUCTION_REQUIRED',
  REMOTE_PREFLIGHT_BLOCKED: 'REMOTE_PREFLIGHT_BLOCKED'
});

const SAFE_REMOTE_PREFLIGHT_BLOCKERS = new Set([
  'MODE_NOT_REAL',
  'TASK_API_URL_INVALID',
  'TASK_API_PERMISSION_MISSING',
  'NATIVE_MESSAGING_PERMISSION_MISSING',
  'NATIVE_HELPER_UNAVAILABLE',
  'HELPER_READ_PATCH_FILE_MISSING',
  'HELPER_CHUNKED_MISSING',
  'HELPER_MAX_PATCH_BYTES_INSUFFICIENT'
]);

function safeCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function safeRemoteBlockers(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const blocker of value) {
    if (!SAFE_REMOTE_PREFLIGHT_BLOCKERS.has(blocker) || result.includes(blocker)) continue;
    result.push(blocker);
  }
  return result;
}

export function buildReleaseReadiness({
  calibration = {},
  resourceEvidence = {},
  remoteEvidence = {},
  remoteProduction = {},
  remotePreflight = {}
} = {}, { now = () => new Date() } = {}) {
  const requiredCount = safeCount(calibration.required_count);
  const coveredCount = safeCount(calibration.covered_count);
  const needsReviewCount = safeCount(calibration.needs_review_count);
  const missingPassCount = safeCount(calibration.missing_pass_count);
  const calibrationSatisfied = calibration.ready_for_review === true
    && requiredCount > 0
    && coveredCount === requiredCount
    && needsReviewCount === 0
    && missingPassCount === 0;

  const resourceTotal = safeCount(resourceEvidence.total_runs);
  const resourcePassed = safeCount(resourceEvidence.passed_runs);
  const remoteTotal = safeCount(remoteEvidence.total_runs);
  const remotePassed = safeCount(remoteEvidence.passed_runs);
  const productionEnabled = remoteProduction.enabled === true;
  const preflightBlockers = safeRemoteBlockers(remotePreflight.blockers);
  const preflightReady = remotePreflight.ready_for_remote_e2e === true;

  const blockers = [];
  if (!calibrationSatisfied && (missingPassCount > 0 || coveredCount < requiredCount || requiredCount === 0)) {
    blockers.push(RELEASE_READINESS_BLOCKERS.CALIBRATION_INCOMPLETE);
  }
  if (needsReviewCount > 0) blockers.push(RELEASE_READINESS_BLOCKERS.CALIBRATION_NEEDS_REVIEW);
  if (resourcePassed < 1) blockers.push(RELEASE_READINESS_BLOCKERS.RESOURCE_E2E_REQUIRED);
  if (remotePassed < 1) blockers.push(RELEASE_READINESS_BLOCKERS.REMOTE_E2E_REQUIRED);
  if (!productionEnabled) blockers.push(RELEASE_READINESS_BLOCKERS.REMOTE_PRODUCTION_REQUIRED);
  if (!preflightReady) blockers.push(RELEASE_READINESS_BLOCKERS.REMOTE_PREFLIGHT_BLOCKED);

  const ready = blockers.length === 0;
  return {
    version: 1,
    generated_at: now().toISOString(),
    status: ready ? 'ready_for_release_review' : 'blocked',
    ready_for_release_review: ready,
    blockers,
    calibration: {
      satisfied: calibrationSatisfied,
      required_count: requiredCount,
      covered_count: coveredCount,
      needs_review_count: needsReviewCount,
      missing_pass_count: missingPassCount
    },
    resource_e2e: {
      satisfied: resourcePassed >= 1,
      total_runs: resourceTotal,
      passed_runs: resourcePassed
    },
    remote_e2e: {
      satisfied: remotePassed >= 1,
      total_runs: remoteTotal,
      passed_runs: remotePassed
    },
    remote_production: {
      satisfied: productionEnabled,
      enabled: productionEnabled
    },
    remote_preflight: {
      satisfied: preflightReady,
      ready: preflightReady,
      blockers: preflightBlockers
    }
  };
}
