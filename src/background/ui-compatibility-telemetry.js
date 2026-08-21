import { ERROR_CODES } from '../shared/errors.js';

const DEFAULT_KEY = 'uiCompatibilityTelemetry';
const DEFAULT_MAX_BUCKETS = 32;
const COMPATIBILITY_ERROR_CODES = new Set([
  ERROR_CODES.UI_SELECTOR_INCOMPATIBLE,
  ERROR_CODES.LOGIN_OR_CHALLENGE_REQUIRED
]);
const ALLOWED_OPERATIONS = new Set([
  'CHATGPT_LIST_PROJECTS',
  'CHATGPT_RESOLVE_PROJECT',
  'CHATGPT_CREATE_PROJECT',
  'CHATGPT_SET_PROJECT_INSTRUCTIONS',
  'CHATGPT_DELETE_PROJECT',
  'CHATGPT_OPEN_PROJECT',
  'CHATGPT_RESOLVE_CHAT',
  'CHATGPT_ATTACH_RESOURCE',
  'CHATGPT_SEND_PROMPT',
  'CHATGPT_STATE',
  'CHATGPT_ROUND_SNAPSHOT',
  'CHATGPT_LATEST_RESPONSE',
  'CHATGPT_DISCOVER_PATCHES',
  'CHATGPT_CLICK_PATCH'
]);
const ACCESS_STATUSES = new Set(['READY', 'LOGIN_REQUIRED', 'CHALLENGE_REQUIRED']);
const PAGE_CATEGORIES = new Set(['chat', 'login', 'challenge', 'other', 'unknown']);

function safeOperation(value) {
  const operation = String(value ?? '');
  return ALLOWED_OPERATIONS.has(operation) ? operation : 'UNKNOWN_OPERATION';
}

function safeProfile(value) {
  const id = String(value?.id ?? '');
  const version = value?.version;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || !Number.isInteger(version) || version < 1 || version > 10000) {
    return { id: 'unknown', version: null };
  }
  return { id, version };
}

function safeAccessStatus(value) {
  const status = String(value ?? '').toUpperCase();
  return ACCESS_STATUSES.has(status) ? status : 'UNKNOWN';
}

function safePageCategory(value) {
  const category = String(value ?? '').toLowerCase();
  return PAGE_CATEGORIES.has(category) ? category : 'unknown';
}

function eventFrom({ operation, error, at }) {
  const diagnostics = error?.details?.diagnostics ?? error?.diagnostics ?? null;
  return {
    selector_profile: safeProfile(diagnostics?.selector_profile),
    operation: safeOperation(operation),
    error_code: String(error?.code ?? 'UNEXPECTED'),
    access_status: safeAccessStatus(diagnostics?.access_state?.status),
    page_category: safePageCategory(diagnostics?.page?.title_category),
    at
  };
}

function bucketKey(event) {
  return [
    event.selector_profile.id,
    event.selector_profile.version ?? 'null',
    event.operation,
    event.error_code,
    event.access_status,
    event.page_category
  ].join('|');
}

export function isUiCompatibilityErrorCode(code) {
  return COMPATIBILITY_ERROR_CODES.has(String(code ?? ''));
}

export class UiCompatibilityTelemetry {
  constructor({ storage, key = DEFAULT_KEY, maxBuckets = DEFAULT_MAX_BUCKETS, now = () => new Date() }) {
    this.storage = storage;
    this.key = key;
    this.maxBuckets = Math.max(1, Number(maxBuckets) || DEFAULT_MAX_BUCKETS);
    this.now = now;
    this.writeChain = Promise.resolve();
  }

  async record({ operation, error }) {
    if (!isUiCompatibilityErrorCode(error?.code)) return false;
    const run = async () => {
      const at = this.now().toISOString();
      const event = eventFrom({ operation, error, at });
      const current = (await this.storage.get(this.key)) ?? {};
      const buckets = Array.isArray(current.buckets) ? current.buckets.map(bucket => ({ ...bucket })) : [];
      const key = bucketKey(event);
      const index = buckets.findIndex(bucket => bucket._key === key || bucketKey({
        selector_profile: bucket.selector_profile ?? { id: 'unknown', version: null },
        operation: bucket.operation,
        error_code: bucket.error_code,
        access_status: bucket.access_status,
        page_category: bucket.page_category
      }) === key);

      const nextBucket = {
        selector_profile: event.selector_profile,
        operation: event.operation,
        error_code: event.error_code,
        access_status: event.access_status,
        page_category: event.page_category,
        count: index >= 0 ? (Number(buckets[index].count) || 0) + 1 : 1,
        last_seen_at: at
      };
      if (index >= 0) buckets.splice(index, 1);
      buckets.push(nextBucket);
      while (buckets.length > this.maxBuckets) buckets.shift();

      await this.storage.set(this.key, {
        version: 1,
        total_events: Math.max(0, Number(current.total_events) || 0) + 1,
        buckets,
        last_event: event
      });
      return true;
    };

    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => {});
    return result;
  }

  async recordSuccess({ operation }) {
    const safe = safeOperation(operation);
    const run = async () => {
      const current = (await this.storage.get(this.key)) ?? null;
      if (!current?.last_event || current.last_event.operation !== safe) return false;
      await this.storage.set(this.key, { ...current, last_event: null });
      return true;
    };
    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => {});
    return result;
  }

  async getSummary() {
    const current = (await this.storage.get(this.key)) ?? null;
    if (!current) return { total_events: 0, bucket_count: 0, last_event: null };
    return {
      total_events: Math.max(0, Number(current.total_events) || 0),
      bucket_count: Array.isArray(current.buckets) ? current.buckets.length : 0,
      last_event: current.last_event ? { ...current.last_event, selector_profile: { ...(current.last_event.selector_profile ?? {}) } } : null
    };
  }
}
