import { ERROR_CODES } from '../shared/errors.js';

const BACKOFF_MS = Object.freeze([5000, 10000, 30000, 60000]);

export function sourceRetryDelayMs(attempt) {
  const index = Math.max(0, Number(attempt) - 1);
  return BACKOFF_MS[Math.min(index, BACKOFF_MS.length - 1)];
}

export function isRetryableSourceError(error) {
  if (error?.code === ERROR_CODES.PATCHSYNC_UNREACHABLE) return true;
  if (error?.code === ERROR_CODES.PATCHSYNC_AUTH_FAILED || error?.code === ERROR_CODES.PATCHSYNC_EXPORT_FAILED) return false;
  if (![ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, ERROR_CODES.PATCHSYNC_HTTP_ERROR].includes(error?.code)) return false;

  const status = Number(error?.details?.status ?? error?.status);
  if (Number.isInteger(status)) {
    if (status === 409) {
      const body = typeof error?.details?.body === 'string' ? error.details.body : String(error?.details?.server_reason ?? '');
      return /project operation is busy(?::|\b)/i.test(body);
    }
    return status === 408 || status === 429 || status >= 500;
  }

  const message = String(error?.message ?? '');
  if (/project does not match|identity mismatch|missing|invalid|unsupported|exceeds|\bis empty\b/i.test(message)) return false;
  return Boolean(error?.details?.cause)
    || /request failed|could not be read|network|fetch|timeout|temporar|unavailable/i.test(message);
}
