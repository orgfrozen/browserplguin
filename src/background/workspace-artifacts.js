import { RunnerError, ERROR_CODES } from '../shared/errors.js';

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return globalThis.btoa(binary);
}

export function createRulesResource(rules) {
  const text = typeof rules?.text === 'string' ? rules.text : '';
  if (!text.trim()) {
    throw new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'LLM rules text is missing from the prepared PatchSync export');
  }
  const bytes = new TextEncoder().encode(text);
  return {
    filename: typeof rules?.filename === 'string' && rules.filename.trim() ? rules.filename.trim() : 'LLM_RULES.md',
    mimeType: 'text/markdown',
    size: bytes.length,
    base64: bytesToBase64(bytes)
  };
}
