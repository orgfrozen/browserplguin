import { RunnerError, ERROR_CODES } from '../shared/errors.js';

export const DEFAULT_NATIVE_PATCH_HOST = 'com.browserplguin.patch_reader';
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const NATIVE_PATCH_PROTOCOL_VERSION = 1;
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function base64ByteLength(value) {
  if (!nonEmptyString(value) || !BASE64.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3 / 4) - padding;
}

function decodeBase64(parts, sizeBytes) {
  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const part of parts) {
    const binary = atob(part);
    for (let index = 0; index < binary.length; index += 1) bytes[offset + index] = binary.charCodeAt(index);
    offset += binary.length;
  }
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function readError(message, details = {}) {
  return new RunnerError(ERROR_CODES.REMOTE_ARTIFACT_READ_FAILED, message, { retryable: false, ...details });
}

export class NativePatchFileReader {
  constructor({
    runtime = chrome.runtime,
    hostName = DEFAULT_NATIVE_PATCH_HOST,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = 60000,
    requestIdFactory = () => crypto.randomUUID()
  } = {}) {
    if (!runtime || typeof runtime.connectNative !== 'function') throw new TypeError('runtime.connectNative is required');
    if (!nonEmptyString(hostName)) throw new TypeError('hostName is required');
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive integer');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer');
    this.runtime = runtime;
    this.hostName = hostName;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.requestIdFactory = requestIdFactory;
  }


  async checkReady() {
    const requestId = this.requestIdFactory();
    if (!nonEmptyString(requestId)) {
      throw new RunnerError(ERROR_CODES.NATIVE_HELPER_UNAVAILABLE, 'Native Helper request id is required', { retryable: false });
    }

    return new Promise((resolve, reject) => {
      let port;
      try {
        port = this.runtime.connectNative(this.hostName);
      } catch (error) {
        reject(new RunnerError(ERROR_CODES.NATIVE_HELPER_UNAVAILABLE, 'Native Patch file reader host is unavailable', {
          retryable: false, native_error: error?.message ?? null
        }));
        return;
      }
      if (!port?.onMessage || !port?.onDisconnect || typeof port.postMessage !== 'function') {
        reject(new RunnerError(ERROR_CODES.NATIVE_HELPER_UNAVAILABLE, 'Native Patch file reader returned an invalid messaging port', { retryable: false }));
        return;
      }

      let finished = false;
      const timeoutMs = Math.min(this.timeoutMs, 5000);
      const close = () => {
        clearTimeout(timer);
        try { port.disconnect?.(); } catch {}
      };
      const fail = (message, details = {}) => {
        if (finished) return;
        finished = true;
        close();
        reject(new RunnerError(ERROR_CODES.NATIVE_HELPER_UNAVAILABLE, message, { retryable: false, ...details }));
      };
      const timer = setTimeout(() => fail('Native Helper readiness check timed out'), timeoutMs);

      port.onDisconnect.addListener(() => {
        if (finished) return;
        fail('Native Patch file reader host is unavailable', { native_error: this.runtime.lastError?.message ?? null });
      });
      port.onMessage.addListener(message => {
        if (finished) return;
        if (!message || message.request_id !== requestId) return fail('Native Helper readiness request id mismatch');
        if (message.type !== 'PONG') return fail('Native Helper readiness returned unexpected message type');
        if (message.host_name !== this.hostName) return fail('Native Helper host name is incompatible');
        if (message.protocol_version !== NATIVE_PATCH_PROTOCOL_VERSION) return fail('Native Helper protocol version is incompatible');
        const capabilities = message.capabilities ?? null;
        if (capabilities?.read_patch_file !== true || capabilities?.chunked !== true || !Number.isInteger(capabilities?.max_patch_bytes) || capabilities.max_patch_bytes <= 0) {
          return fail('Native Helper capabilities are incompatible');
        }
        finished = true;
        close();
        resolve({
          status: 'ready',
          host_name: message.host_name,
          protocol_version: message.protocol_version,
          capabilities: {
            read_patch_file: true,
            chunked: true,
            max_patch_bytes: capabilities.max_patch_bytes
          }
        });
      });

      try {
        port.postMessage({ type: 'PING', request_id: requestId });
      } catch (error) {
        fail('Native Helper readiness request failed', { native_error: error?.message ?? null });
      }
    });
  }

  async read(artifact) {
    if (!nonEmptyString(artifact?.local_path)) throw readError('Remote Patch local_path is required for Native Helper file reading');
    const requestId = this.requestIdFactory();
    if (!nonEmptyString(requestId)) throw readError('Native Helper request id is required');

    return new Promise((resolve, reject) => {
      let port;
      try {
        port = this.runtime.connectNative(this.hostName);
      } catch (error) {
        reject(readError('Native Patch file reader host is unavailable', { native_error: error?.message ?? null }));
        return;
      }
      if (!port?.onMessage || !port?.onDisconnect || typeof port.postMessage !== 'function') {
        reject(readError('Native Patch file reader returned an invalid messaging port'));
        return;
      }

      let finished = false;
      let began = false;
      let expectedSize = null;
      let expectedSha = null;
      let expectedChunks = null;
      let nextIndex = 0;
      let receivedBytes = 0;
      const chunks = [];
      const timer = setTimeout(() => fail('Native Patch file reader timed out'), this.timeoutMs);

      const close = () => {
        clearTimeout(timer);
        try { port.disconnect?.(); } catch {}
      };
      const fail = (message, details = {}) => {
        if (finished) return;
        finished = true;
        close();
        reject(readError(message, details));
      };
      const succeed = result => {
        if (finished) return;
        finished = true;
        close();
        resolve(result);
      };

      port.onDisconnect.addListener(() => {
        if (finished) return;
        fail('Native Patch file reader disconnected before completion', {
          native_error: this.runtime.lastError?.message ?? null
        });
      });

      port.onMessage.addListener(message => {
        void (async () => {
          try {
            if (finished) return;
            if (!message || message.request_id !== requestId) return fail('Native Patch file reader response request id mismatch');
            if (message.type === 'PATCH_FILE_ERROR') {
              return fail('Native Patch file reader rejected the file', { native_code: message.error?.code ?? null });
            }
            if (message.type === 'PATCH_FILE_BEGIN') {
              if (began) return fail('Native Patch file reader sent duplicate BEGIN');
              if (!Number.isInteger(message.size_bytes) || message.size_bytes <= 0 || message.size_bytes > this.maxBytes) {
                return fail('Native Patch file reader returned invalid Patch size', { size_bytes: message.size_bytes ?? null });
              }
              if (!nonEmptyString(message.sha256) || !SHA256_HEX.test(message.sha256)) return fail('Native Patch file reader returned invalid SHA-256');
              if (!Number.isInteger(message.chunks) || message.chunks <= 0) return fail('Native Patch file reader returned invalid chunk count');
              began = true;
              expectedSize = message.size_bytes;
              expectedSha = message.sha256.toLowerCase();
              expectedChunks = message.chunks;
              return;
            }
            if (message.type === 'PATCH_FILE_CHUNK') {
              if (!began || nextIndex >= expectedChunks || message.index !== nextIndex) return fail('Native Patch file reader chunk order is invalid');
              const length = base64ByteLength(message.content_base64);
              if (!Number.isInteger(length) || length <= 0) return fail('Native Patch file reader returned invalid base64 chunk');
              if (nextIndex < expectedChunks - 1 && message.content_base64.endsWith('=')) return fail('Native Patch file reader padded a non-final chunk');
              if (receivedBytes + length > expectedSize) return fail('Native Patch file reader returned too many bytes');
              chunks.push(message.content_base64);
              receivedBytes += length;
              nextIndex += 1;
              return;
            }
            if (message.type === 'PATCH_FILE_END') {
              if (!began || message.chunks !== expectedChunks || nextIndex !== expectedChunks || receivedBytes !== expectedSize) {
                return fail('Native Patch file reader stream ended with incomplete content');
              }
              const bytes = decodeBase64(chunks, expectedSize);
              const actualSha = await sha256Hex(bytes);
              if (actualSha !== expectedSha) return fail('Native Patch file reader SHA-256 verification failed');
              return succeed({
                ...artifact,
                content_base64: chunks.join(''),
                size_bytes: expectedSize,
                sha256: expectedSha
              });
            }
            return fail('Native Patch file reader returned an unknown message type');
          } catch (error) {
            fail('Native Patch file reader response validation failed', { native_error: error?.message ?? null });
          }
        })();
      });

      try {
        port.postMessage({
          type: 'READ_PATCH_FILE',
          request_id: requestId,
          path: artifact.local_path,
          max_bytes: this.maxBytes
        });
      } catch (error) {
        fail('Native Patch file reader request failed', { native_error: error?.message ?? null });
      }
    });
  }
}
