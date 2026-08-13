import { RunnerError, ERROR_CODES } from '../shared/errors.js';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(message, details = {}) {
  throw new RunnerError(ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED, message, { retryable: false, ...details });
}

function base64ByteLength(value) {
  if (!nonEmptyString(value) || !BASE64.test(value)) fail('Remote Patch content_base64 must be valid canonical base64');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3 / 4) - padding;
}

function buildPayload(artifact, maxBytes) {
  if (!artifact || typeof artifact !== 'object') fail('Remote Patch artifact is required');
  for (const field of ['task_id', 'session_id', 'filename', 'patch_key']) {
    if (!nonEmptyString(artifact[field])) fail(`Remote Patch ${field} is required`, { filename: artifact.filename ?? null });
  }
  const sizeBytes = base64ByteLength(artifact.content_base64);
  if (sizeBytes <= 0 || sizeBytes > maxBytes) {
    fail(`Remote Patch size must be between 1 and ${maxBytes} bytes`, { filename: artifact.filename, size_bytes: sizeBytes });
  }
  if (artifact.size_bytes != null && (!Number.isInteger(artifact.size_bytes) || artifact.size_bytes !== sizeBytes)) {
    fail('Remote Patch size_bytes does not match content_base64', { filename: artifact.filename, size_bytes: artifact.size_bytes, actual_size_bytes: sizeBytes });
  }
  return {
    session_id: artifact.session_id,
    filename: artifact.filename,
    patch_key: artifact.patch_key,
    content_type: nonEmptyString(artifact.content_type) ? artifact.content_type : 'text/x-diff',
    content_base64: artifact.content_base64,
    size_bytes: sizeBytes
  };
}

function validateReceipt(raw, payload) {
  if (!raw || typeof raw !== 'object') fail('Remote artifact upload receipt is required');
  if (!nonEmptyString(raw.artifact_id)) fail('Remote artifact receipt artifact_id is required');
  if (raw.filename !== payload.filename) fail('Remote artifact receipt filename does not match uploaded Patch', { filename: payload.filename });
  if (!Number.isInteger(raw.size_bytes) || raw.size_bytes !== payload.size_bytes) {
    fail('Remote artifact receipt size_bytes does not match uploaded Patch', { filename: payload.filename, size_bytes: raw.size_bytes });
  }
  if (raw.sha256 != null && (!nonEmptyString(raw.sha256) || !SHA256_HEX.test(raw.sha256))) {
    fail('Remote artifact receipt sha256 must be a 64-character hexadecimal digest', { filename: payload.filename });
  }
  const receipt = {
    artifact_id: raw.artifact_id,
    filename: raw.filename,
    size_bytes: raw.size_bytes
  };
  if (raw.sha256 != null) receipt.sha256 = raw.sha256.toLowerCase();
  return receipt;
}

function isTransient(error) {
  if (error?.details?.retryable === false) return false;
  if (Number.isInteger(error?.status)) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return true;
}

function retryDelay(baseDelayMs, attempt) {
  return baseDelayMs * (2 ** Math.max(0, attempt - 1));
}

export class RemoteArtifactTransport {
  constructor({
    taskApi,
    maxBytes = DEFAULT_MAX_BYTES,
    maxAttempts = 3,
    baseDelayMs = 250,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  } = {}) {
    if (!taskApi || typeof taskApi.uploadArtifactContent !== 'function') throw new TypeError('taskApi.uploadArtifactContent is required');
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive integer');
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new TypeError('maxAttempts must be a positive integer');
    if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) throw new TypeError('baseDelayMs must be non-negative');
    this.taskApi = taskApi;
    this.maxBytes = maxBytes;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.sleep = sleep;
  }

  async upload(artifact) {
    const payload = buildPayload(artifact, this.maxBytes);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const raw = await this.taskApi.uploadArtifactContent(artifact.task_id, payload);
        return validateReceipt(raw, payload);
      } catch (error) {
        const transient = isTransient(error);
        if (!transient || attempt >= this.maxAttempts) {
          if (error instanceof RunnerError && error.code === ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED && error.details?.retryable === false) {
            throw error;
          }
          throw new RunnerError(
            ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED,
            `Remote Patch upload failed after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
            {
              filename: artifact.filename,
              attempts: attempt,
              status: Number.isInteger(error?.status) ? error.status : null,
              retryable: transient
            }
          );
        }
        await this.sleep(retryDelay(this.baseDelayMs, attempt));
      }
    }
    throw new RunnerError(ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED, 'Remote Patch upload failed', { filename: artifact.filename });
  }
}
