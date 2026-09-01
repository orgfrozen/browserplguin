import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { ResourceHostPermissionManager } from './resource-host-permission.js';
import { DEFAULT_MAX_BYTES } from './resource-loader.js';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(message, details = undefined, code = ERROR_CODES.RESOURCE_DOWNLOAD_FAILED) {
  throw new RunnerError(code, message, details);
}

function operationFor(path, method = 'GET') {
  if (/\/ensure-ready$/.test(path)) return 'ensure_ready';
  if (path === '/v1/exports' && method === 'POST') return 'export_create';
  if (/^\/v1\/exports\//.test(path) && method === 'GET') return 'export_status';
  if (path === '/v1/patches' && method === 'POST') return 'patch_upload';
  if (/LLM_RULES\.md(?:$|\?)/.test(path)) return 'rules_download';
  if (/\.zip(?:$|\?)/.test(path)) return 'source_download';
  return `${String(method || 'GET').toLowerCase()}_request`;
}

const DEFAULT_EXPORT_POLL_BACKOFF_MS = Object.freeze([2000, 3000, 5000, 8000, 10000]);

function responseReason(body) {
  const text = String(body ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    for (const key of ['error', 'message', 'reason']) {
      if (typeof parsed?.[key] === 'string' && parsed[key].trim()) return parsed[key].trim();
    }
  } catch { /* fall through to compact text */ }
  return text;
}


function base64ToBytes(value) {
  if (!nonEmptyString(value)) fail('PatchSync Patch content_base64 is required');
  let binary;
  try { binary = atob(value); } catch (error) { fail('PatchSync Patch content_base64 is invalid', { cause: error?.message }); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class PatchSyncClient {
  constructor({ baseUrl, accessToken, fetchImpl = (...args) => globalThis.fetch(...args), permissions, permissionManager, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (!nonEmptyString(baseUrl)) throw new TypeError('baseUrl is required');
    if (!nonEmptyString(accessToken)) throw new TypeError('accessToken is required');
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('baseUrl must use http(s)');
    if (parsed.username || parsed.password) throw new TypeError('baseUrl must not contain credentials');
    this.baseUrl = parsed.href.replace(/\/$/, '');
    this.origin = parsed.origin;
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
    this.permissionManager = permissionManager ?? new ResourceHostPermissionManager({ permissions });
    this.sleep = sleep;
    this.maxBytes = maxBytes;
  }

  #safeText(value, max = 500) {
    let text = String(value ?? '').trim();
    if (!text) return null;
    if (this.accessToken) text = text.split(this.accessToken).join('[redacted]');
    text = text.replace(/\b(Bearer|PatchSync)\s+[A-Za-z0-9._~+\/-]{12,}/gi, '$1 [redacted]');
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  }

  #url(path) {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== this.origin) fail('PatchSync URL must stay on the configured API origin', { url: url.href, origin: this.origin });
    return url.href;
  }

  async #fetch(path, init = {}) {
    const url = this.#url(path);
    await this.permissionManager.assertGranted(url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const operation = operationFor(path, method);
    const diagnostic = { origin: this.origin, operation };
    const headers = {
      ...(init.headers ?? {}),
      Authorization: `PatchSync ${this.accessToken}`
    };
    let response;
    try {
      response = await this.fetchImpl(url, { ...init, headers, credentials: 'omit', redirect: 'follow' });
    } catch (error) {
      fail('PatchSync API is unreachable', {
        ...diagnostic,
        cause: this.#safeText(error?.message) ?? 'request failed'
      }, ERROR_CODES.PATCHSYNC_UNREACHABLE);
    }
    if (!response?.ok) {
      let body = '';
      try { body = await response.text(); } catch { /* best effort */ }
      const status = Number(response?.status);
      const serverReason = this.#safeText(responseReason(body));
      const details = {
        ...diagnostic,
        ...(Number.isInteger(status) ? { status } : {}),
        ...(serverReason ? { server_reason: serverReason } : {})
      };
      if (status === 401 || status === 403) {
        fail(`PatchSync authentication failed (HTTP ${status})`, details, ERROR_CODES.PATCHSYNC_AUTH_FAILED);
      }
      fail(`PatchSync request returned HTTP ${Number.isInteger(status) ? status : 'unknown'}`, details, ERROR_CODES.PATCHSYNC_HTTP_ERROR);
    }
    return { response, url };
  }

  async #json(path, init = {}) {
    const { response } = await this.#fetch(path, init);
    try {
      return await response.json();
    } catch (error) {
      fail('PatchSync response is not valid JSON', { path, cause: error?.message });
    }
  }

  async ensureReady(projectId) {
    if (!nonEmptyString(projectId)) throw new TypeError('projectId is required');
    let result;
    try {
      result = await this.#json(`/v1/projects/${encodeURIComponent(projectId)}/ensure-ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId })
      });
    } catch (error) {
      if (Number(error?.details?.status) === 409) {
        const serverReason = String(error?.details?.server_reason ?? '');
        if (/project operation is busy(?::|\b)/i.test(serverReason)) throw error;
        throw new RunnerError(ERROR_CODES.PATCHSYNC_PROJECT_NOT_READY, 'PatchSync project worker requires operator action', {
          project_id: projectId,
          origin: error?.details?.origin ?? this.origin,
          operation: 'ensure_ready',
          status: 409,
          server_reason: error?.details?.server_reason ?? null
        });
      }
      throw error;
    }
    if (result?.ready !== true || result?.project_id !== projectId) {
      fail('PatchSync project worker is not ready', { projectId, result });
    }
    if (result.runtime_status !== 'current' || result.worker_status !== 'running' || result.queue_paused === true) {
      fail('PatchSync project readiness response is invalid', { projectId, result });
    }
    return result;
  }

  async createExport(projectId) {
    if (!nonEmptyString(projectId)) throw new TypeError('projectId is required');
    const result = await this.#json('/v1/exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId })
    });
    if (!nonEmptyString(result?.export_id)) fail('PatchSync export response is missing export_id', { projectId });
    return result;
  }

  async waitForExport(exportId, { pollIntervalMs = null, onStatus = null } = {}) {
    if (!nonEmptyString(exportId)) throw new TypeError('exportId is required');
    const pollBackoffMs = pollIntervalMs == null
      ? DEFAULT_EXPORT_POLL_BACKOFF_MS
      : [Math.max(0, Number(pollIntervalMs) || 0)];
    let lastObserved = null;
    let unchangedPolls = 0;
    while (true) {
      const manifest = await this.#json(`/v1/exports/${encodeURIComponent(exportId)}`, { method: 'GET' });
      if (manifest?.export_id !== exportId) fail('PatchSync export manifest identity mismatch', { expected: exportId, actual: manifest?.export_id });
      const observed = `${manifest?.status ?? ''}\n${manifest?.stage ?? ''}`;
      const statusChanged = observed !== lastObserved;
      if (statusChanged) {
        lastObserved = observed;
        unchangedPolls = 0;
        if (typeof onStatus === 'function') {
          await onStatus({ export_id: exportId, status: manifest?.status ?? null, stage: manifest?.stage ?? null });
        }
      }
      if (manifest.status === 'succeeded') {
        if (!nonEmptyString(manifest.patch_session_id)) fail('PatchSync export manifest is missing patch_session_id', { exportId });
        if (!manifest.source || !nonEmptyString(manifest.source.download_url) || !nonEmptyString(manifest.source.filename)) {
          fail('PatchSync export manifest is missing source ZIP', { exportId });
        }
        if (!manifest.rules || (!nonEmptyString(manifest.rules.text) && !nonEmptyString(manifest.rules.download_url))) {
          fail('PatchSync export manifest is missing LLM rules', { exportId });
        }
        return {
          ...manifest,
          source: { ...manifest.source, download_url: this.#url(manifest.source.download_url) },
          rules: {
            ...manifest.rules,
            ...(nonEmptyString(manifest.rules.download_url) ? { download_url: this.#url(manifest.rules.download_url) } : {})
          }
        };
      }
      if (manifest.status === 'failed' || manifest.status === 'restore_failed') {
        fail(`PatchSync export failed: ${this.#safeText(manifest.error) ?? manifest.status}`, {
          origin: this.origin, operation: 'export_status', export_id: exportId, status: manifest.status, stage: manifest.stage ?? null,
          ...(this.#safeText(manifest.error) ? { server_reason: this.#safeText(manifest.error) } : {})
        }, ERROR_CODES.PATCHSYNC_EXPORT_FAILED);
      }
      if (!['queued', 'running'].includes(manifest.status)) {
        fail(`PatchSync export returned unsupported status: ${manifest.status ?? 'missing'}`, { exportId, status: manifest.status });
      }
      const delayMs = pollBackoffMs[Math.min(unchangedPolls, pollBackoffMs.length - 1)];
      if (delayMs > 0) await this.sleep(delayMs);
      unchangedPolls += 1;
    }
  }

  async downloadSource(exportManifest) {
    const source = exportManifest?.source;
    if (!source || !nonEmptyString(source.download_url)) fail('PatchSync source download URL is missing');
    const { response, url } = await this.#fetch(source.download_url, { method: 'GET' });
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
      fail('PatchSync source exceeds the maximum supported size', { size: declaredLength, maxBytes: this.maxBytes });
    }
    let bytes;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      fail('PatchSync source body could not be read', { url, cause: error?.message });
    }
    if (bytes.length === 0) fail('PatchSync source is empty', { url });
    if (bytes.length > this.maxBytes) fail('PatchSync source exceeds the maximum supported size', { size: bytes.length, maxBytes: this.maxBytes });
    return {
      filename: source.filename,
      mimeType: String(response.headers?.get?.('content-type') ?? 'application/zip').split(';')[0].trim() || 'application/zip',
      size: bytes.length,
      base64: bytesToBase64(bytes),
      sourceUrl: url
    };
  }


  async uploadPatch(artifact) {
    if (!artifact || typeof artifact !== 'object') fail('PatchSync Patch artifact is required');
    if (!nonEmptyString(artifact.filename) || !artifact.filename.endsWith('.patch')) fail('PatchSync Patch filename is required');
    const bytes = base64ToBytes(artifact.content_base64);
    if (bytes.length === 0 || bytes.length > this.maxBytes) {
      fail('PatchSync Patch exceeds the supported size range', { filename: artifact.filename, size: bytes.length, maxBytes: this.maxBytes });
    }
    if (artifact.size_bytes != null && artifact.size_bytes !== bytes.length) {
      fail('PatchSync Patch size_bytes does not match content_base64', { filename: artifact.filename, expected: artifact.size_bytes, actual: bytes.length });
    }
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'text/x-diff' }), artifact.filename);
    const receipt = await this.#json('/v1/patches', { method: 'POST', body: form });
    if (receipt?.accepted !== true) fail('PatchSync did not accept the Patch', { filename: artifact.filename });
    if (receipt.filename !== artifact.filename) fail('PatchSync receipt filename does not match the submitted Patch', { expected: artifact.filename, actual: receipt?.filename });
    if (!nonEmptyString(receipt.session_id) || !Number.isInteger(receipt.sequence) || !nonEmptyString(receipt.state)) {
      fail('PatchSync receipt is missing Patch identity fields', { filename: artifact.filename });
    }
    return receipt;
  }

  async downloadRules(exportManifest) {
    const rules = exportManifest?.rules;
    if (!rules || !nonEmptyString(rules.filename)) fail('PatchSync LLM rules metadata is missing');
    if (nonEmptyString(rules.text)) {
      return { filename: rules.filename, text: rules.text, sourceUrl: null };
    }
    if (!nonEmptyString(rules.download_url)) fail('PatchSync LLM rules download URL is missing');
    const { response, url } = await this.#fetch(rules.download_url, { method: 'GET' });
    let text;
    try { text = await response.text(); } catch (error) { fail('PatchSync LLM rules body could not be read', { url, cause: error?.message }); }
    if (!nonEmptyString(text)) fail('PatchSync LLM rules are empty', { url });
    return { filename: rules.filename, text, sourceUrl: url };
  }
}
