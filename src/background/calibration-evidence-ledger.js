import { sanitizeCalibrationFingerprints } from '../shared/calibration-fingerprint.js';

const DEFAULT_KEY = 'calibrationEvidenceLedger';
const DEFAULT_MAX_RECENT_RUNS = 20;
const SURFACE_IDS = Object.freeze([
  'access',
  'composer',
  'model_state',
  'latest_assistant',
  'patch_candidates',
  'context_limit',
  'project_create',
  'project_settings',
  'project_delete',
  'resource_input'
]);
const SURFACE_ID_SET = new Set(SURFACE_IDS);
const STATUSES = new Set(['pass', 'unavailable', 'incompatible']);
const PAGE_CATEGORIES = new Set(['home', 'chat', 'project', 'login', 'challenge', 'other']);
const ACCESS_STATUSES = new Set(['READY', 'LOGIN_REQUIRED', 'CHALLENGE_REQUIRED']);

function emptySummary() {
  return { version: 1, total_runs: 0, selector_profiles: [], surfaces: {}, recent_runs: [], last_run: null };
}

function safeProfile(value) {
  const id = String(value?.id ?? '');
  const version = value?.version;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || !Number.isInteger(version) || version < 1 || version > 10000) {
    return { id: 'unknown', version: null };
  }
  return { id, version };
}

function safePageCategory(value) {
  const category = String(value ?? '').toLowerCase();
  return PAGE_CATEGORIES.has(category) ? category : 'other';
}

function safeAccessStatus(value) {
  const status = String(value ?? '').toUpperCase();
  return ACCESS_STATUSES.has(status) ? status : 'UNKNOWN';
}

function safeStatus(value) {
  const status = String(value ?? '').toLowerCase();
  return STATUSES.has(status) ? status : 'incompatible';
}

function safeTimestamp(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function sanitizeRun(matrix, at) {
  const checksById = new Map();
  for (const check of Array.isArray(matrix?.checks) ? matrix.checks : []) {
    const id = String(check?.id ?? '');
    if (!SURFACE_ID_SET.has(id)) continue;
    checksById.set(id, {
      status: safeStatus(check?.status),
      fingerprints: sanitizeCalibrationFingerprints(check?.evidence?.fingerprints)
    });
  }
  return {
    at,
    selector_profile: safeProfile(matrix?.selector_profile),
    page_category: safePageCategory(matrix?.page?.category),
    access_status: safeAccessStatus(matrix?.page?.access_status),
    checks: [...checksById.entries()].map(([id, value]) => ({ id, ...value }))
  };
}

function sanitizeStoredSurface(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    total_runs: Math.max(0, Number(source.total_runs) || 0),
    pass_count: Math.max(0, Number(source.pass_count) || 0),
    unavailable_count: Math.max(0, Number(source.unavailable_count) || 0),
    incompatible_count: Math.max(0, Number(source.incompatible_count) || 0),
    latest_status: source.latest_status === null || source.latest_status === undefined ? null : safeStatus(source.latest_status),
    latest_page_category: source.latest_page_category ? safePageCategory(source.latest_page_category) : null,
    last_seen_at: safeTimestamp(source.last_seen_at),
    latest_fingerprints: sanitizeCalibrationFingerprints(source.latest_fingerprints)
  };
}

function sanitizeStoredRun(value) {
  if (!value || typeof value !== 'object') return null;
  const checks = [];
  for (const check of Array.isArray(value.checks) ? value.checks : []) {
    const id = String(check?.id ?? '');
    if (!SURFACE_ID_SET.has(id)) continue;
    checks.push({ id, status: safeStatus(check?.status) });
  }
  return {
    at: safeTimestamp(value.at),
    selector_profile: safeProfile(value.selector_profile),
    page_category: safePageCategory(value.page_category),
    access_status: safeAccessStatus(value.access_status),
    checks
  };
}

function profileKey(profile) {
  return `${profile.id}|${profile.version ?? 'null'}`;
}

function cloneSummary(value) {
  const source = value && value.version === 1 ? value : emptySummary();
  const surfaces = {};
  if (source.surfaces && typeof source.surfaces === 'object') {
    for (const id of SURFACE_IDS) {
      if (source.surfaces[id]) surfaces[id] = sanitizeStoredSurface(source.surfaces[id]);
    }
  }
  const recentRuns = Array.isArray(source.recent_runs) ? source.recent_runs.map(sanitizeStoredRun).filter(Boolean) : [];
  return {
    version: 1,
    total_runs: Math.max(0, Number(source.total_runs) || 0),
    selector_profiles: Array.isArray(source.selector_profiles) ? source.selector_profiles.map(safeProfile) : [],
    surfaces,
    recent_runs: recentRuns,
    last_run: sanitizeStoredRun(source.last_run)
  };
}

export class CalibrationEvidenceLedger {
  constructor({ storage, key = DEFAULT_KEY, maxRecentRuns = DEFAULT_MAX_RECENT_RUNS, now = () => new Date() }) {
    this.storage = storage;
    this.key = key;
    this.maxRecentRuns = Math.max(1, Number(maxRecentRuns) || DEFAULT_MAX_RECENT_RUNS);
    this.now = now;
    this.writeChain = Promise.resolve();
  }

  async record(matrix) {
    const run = async () => {
      const at = this.now().toISOString();
      const evidenceRun = sanitizeRun(matrix, at);
      const current = cloneSummary(await this.storage.get(this.key));
      current.total_runs += 1;

      const seenProfiles = new Set(current.selector_profiles.map(profileKey));
      if (!seenProfiles.has(profileKey(evidenceRun.selector_profile))) {
        current.selector_profiles.push(evidenceRun.selector_profile);
      }

      for (const check of evidenceRun.checks) {
        const previous = current.surfaces[check.id] ?? {
          total_runs: 0,
          pass_count: 0,
          unavailable_count: 0,
          incompatible_count: 0,
          latest_status: null,
          latest_page_category: null,
          last_seen_at: null,
          latest_fingerprints: []
        };
        current.surfaces[check.id] = {
          total_runs: Math.max(0, Number(previous.total_runs) || 0) + 1,
          pass_count: Math.max(0, Number(previous.pass_count) || 0) + (check.status === 'pass' ? 1 : 0),
          unavailable_count: Math.max(0, Number(previous.unavailable_count) || 0) + (check.status === 'unavailable' ? 1 : 0),
          incompatible_count: Math.max(0, Number(previous.incompatible_count) || 0) + (check.status === 'incompatible' ? 1 : 0),
          latest_status: check.status,
          latest_page_category: evidenceRun.page_category,
          last_seen_at: at,
          latest_fingerprints: check.fingerprints
        };
      }

      const compactRun = {
        ...evidenceRun,
        checks: evidenceRun.checks.map(({ id, status }) => ({ id, status }))
      };
      current.recent_runs.push(compactRun);
      while (current.recent_runs.length > this.maxRecentRuns) current.recent_runs.shift();
      current.last_run = compactRun;
      await this.storage.set(this.key, current);
      return current;
    };

    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => {});
    return result;
  }

  async getSummary() {
    return cloneSummary(await this.storage.get(this.key));
  }

  async clear() {
    await this.storage.remove(this.key);
  }
}

export { SURFACE_IDS as CALIBRATION_EVIDENCE_SURFACE_IDS };
