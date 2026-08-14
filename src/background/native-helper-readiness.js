import { ERROR_CODES } from '../shared/errors.js';

const STORAGE_KEY = 'nativeHelperReadiness';

function safeReady(result, checkedAt) {
  const capabilities = result?.capabilities ?? {};
  return {
    status: 'ready',
    host_name: typeof result?.host_name === 'string' ? result.host_name : 'unknown',
    protocol_version: Number.isInteger(result?.protocol_version) ? result.protocol_version : null,
    capabilities: {
      read_patch_file: capabilities.read_patch_file === true,
      chunked: capabilities.chunked === true,
      max_patch_bytes: Number.isInteger(capabilities.max_patch_bytes) && capabilities.max_patch_bytes > 0
        ? capabilities.max_patch_bytes
        : null
    },
    checked_at: checkedAt
  };
}

export async function checkNativeHelperReadiness({ reader, storage, now = () => new Date().toISOString() }) {
  const checkedAt = now();
  let summary;
  try {
    summary = safeReady(await reader.checkReady(), checkedAt);
  } catch (error) {
    summary = {
      status: 'unavailable',
      error_code: typeof error?.code === 'string' ? error.code : ERROR_CODES.NATIVE_HELPER_UNAVAILABLE,
      checked_at: checkedAt
    };
  }
  await storage.set(STORAGE_KEY, summary);
  return summary;
}

export async function getNativeHelperReadiness(storage) {
  return (await storage.get(STORAGE_KEY)) ?? { status: 'never_checked' };
}
