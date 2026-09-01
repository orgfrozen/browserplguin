import { sanitizeCalibrationFingerprints } from './calibration-fingerprint.js';

const REVIEW_SURFACES = Object.freeze([
  'context_limit',
  'patch_candidates',
  'new_chat',
  'project_create',
  'project_settings',
  'resource_input',
  'project_delete',
  'conversation_delete'
]);
const VALID_STATUSES = new Set(['pass', 'unavailable', 'incompatible']);
const VALID_PAGE_CATEGORIES = new Set(['home', 'chat', 'project', 'login', 'challenge', 'other']);

function safeCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function safeStatus(value) {
  const status = String(value ?? '').toLowerCase();
  return VALID_STATUSES.has(status) ? status : null;
}

function safePageCategory(value) {
  const category = String(value ?? '').toLowerCase();
  return VALID_PAGE_CATEGORIES.has(category) ? category : null;
}

function safeTimestamp(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function safeProfile(value) {
  const id = String(value?.id ?? '');
  const version = value?.version;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || !Number.isInteger(version) || version < 1 || version > 10000) {
    return null;
  }
  return { id, version };
}

function buildSurface(source) {
  const passCount = safeCount(source?.pass_count);
  const latestStatus = safeStatus(source?.latest_status);
  let coverage = 'missing_pass';
  if (passCount > 0) {
    coverage = latestStatus === 'incompatible' || latestStatus === null ? 'needs_review' : 'covered';
  }

  return {
    coverage,
    total_runs: safeCount(source?.total_runs),
    pass_count: passCount,
    unavailable_count: safeCount(source?.unavailable_count),
    incompatible_count: safeCount(source?.incompatible_count),
    latest_status: latestStatus,
    latest_page_category: safePageCategory(source?.latest_page_category),
    last_seen_at: safeTimestamp(source?.last_seen_at),
    latest_fingerprints: sanitizeCalibrationFingerprints(source?.latest_fingerprints)
  };
}

export function buildCalibrationCoverage(summary, { now = () => new Date() } = {}) {
  const surfaces = {};
  let coveredCount = 0;
  let needsReviewCount = 0;
  let missingPassCount = 0;

  for (const id of REVIEW_SURFACES) {
    const projection = buildSurface(summary?.surfaces?.[id]);
    surfaces[id] = projection;
    if (projection.coverage === 'covered') coveredCount += 1;
    else if (projection.coverage === 'needs_review') needsReviewCount += 1;
    else missingPassCount += 1;
  }

  const profiles = [];
  const seenProfiles = new Set();
  for (const value of Array.isArray(summary?.selector_profiles) ? summary.selector_profiles : []) {
    const profile = safeProfile(value);
    if (!profile) continue;
    const key = `${profile.id}|${profile.version}`;
    if (seenProfiles.has(key)) continue;
    seenProfiles.add(key);
    profiles.push(profile);
  }

  return {
    version: 1,
    generated_at: now().toISOString(),
    ready_for_review: coveredCount === REVIEW_SURFACES.length,
    required_count: REVIEW_SURFACES.length,
    covered_count: coveredCount,
    needs_review_count: needsReviewCount,
    missing_pass_count: missingPassCount,
    total_recorded_runs: safeCount(summary?.total_runs),
    selector_profiles: profiles,
    surfaces
  };
}

export { REVIEW_SURFACES as CALIBRATION_REVIEW_SURFACES };
