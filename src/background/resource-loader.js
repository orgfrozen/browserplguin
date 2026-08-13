import { RunnerError, ERROR_CODES } from '../shared/errors.js';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function fail(message, details) {
  throw new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, message, details);
}

function safeFilename(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '.' || text === '..' || /[\\/\0-\x1f]/.test(text)) return null;
  return text;
}

function filenameFromContentDisposition(header) {
  const value = String(header ?? '');
  const utf8 = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return safeFilename(decodeURIComponent(utf8.replace(/^"|"$/g, ''))); } catch { return null; }
  }
  return safeFilename(value.match(/filename\s*=\s*"([^"]+)"/i)?.[1] ?? value.match(/filename\s*=\s*([^;]+)/i)?.[1]);
}

function filenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last ? safeFilename(decodeURIComponent(last)) : null;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class ResourceLoader {
  constructor({ fetchImpl = fetch, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.fetchImpl = fetchImpl;
    this.maxBytes = maxBytes;
  }

  async load(resource) {
    const sourceUrl = resource?.url;
    let response;
    try {
      response = await this.fetchImpl(sourceUrl, { method: 'GET', credentials: 'omit', redirect: 'follow' });
    } catch (error) {
      fail('Task resource download request failed', { sourceUrl, cause: error?.message });
    }

    if (!response?.ok) fail(`Task resource download returned HTTP ${response?.status ?? 'unknown'}`, { sourceUrl, status: response?.status });

    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
      fail('Task resource exceeds the maximum supported size', { sourceUrl, size: declaredLength, maxBytes: this.maxBytes });
    }

    let bytes;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      fail('Task resource body could not be read', { sourceUrl, cause: error?.message });
    }
    if (bytes.length === 0) fail('Task resource is empty', { sourceUrl });
    if (bytes.length > this.maxBytes) fail('Task resource exceeds the maximum supported size', { sourceUrl, size: bytes.length, maxBytes: this.maxBytes });

    const explicit = resource?.filename == null ? null : safeFilename(resource.filename);
    if (resource?.filename != null && !explicit) fail('Task resource filename is invalid', { sourceUrl, filename: resource.filename });
    const filename = explicit
      ?? filenameFromContentDisposition(response.headers?.get?.('content-disposition'))
      ?? filenameFromUrl(sourceUrl)
      ?? 'task-resource.bin';
    const mimeType = String(response.headers?.get?.('content-type') ?? 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';

    return {
      filename,
      mimeType,
      size: bytes.length,
      base64: bytesToBase64(bytes),
      sourceUrl
    };
  }
}

export { DEFAULT_MAX_BYTES };
