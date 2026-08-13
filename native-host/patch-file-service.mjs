import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_MAX_PATCH_BYTES = 32 * 1024 * 1024;

export class NativePatchHostError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativePatchHostError';
    this.code = code;
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function readPatchFile(filePath, { downloadsRoot, maxBytes = DEFAULT_MAX_PATCH_BYTES } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.patch') {
    throw new NativePatchHostError('PATCH_FILE_NOT_ALLOWED');
  }
  if (typeof downloadsRoot !== 'string' || downloadsRoot.length === 0) {
    throw new NativePatchHostError('DOWNLOADS_ROOT_INVALID');
  }

  const limit = positiveInteger(maxBytes, DEFAULT_MAX_PATCH_BYTES);
  const [rootReal, targetLstat] = await Promise.all([
    fs.realpath(downloadsRoot).catch(() => { throw new NativePatchHostError('DOWNLOADS_ROOT_INVALID'); }),
    fs.lstat(filePath).catch(() => { throw new NativePatchHostError('PATCH_FILE_NOT_FOUND'); })
  ]);

  if (targetLstat.isSymbolicLink() || !targetLstat.isFile()) {
    throw new NativePatchHostError('PATCH_FILE_NOT_ALLOWED');
  }

  const targetReal = await fs.realpath(filePath).catch(() => { throw new NativePatchHostError('PATCH_FILE_NOT_FOUND'); });
  if (!containedBy(rootReal, targetReal)) {
    throw new NativePatchHostError('PATCH_FILE_NOT_ALLOWED');
  }

  const handle = await fs.open(targetReal, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new NativePatchHostError('PATCH_FILE_NOT_ALLOWED');
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > limit) {
      throw new NativePatchHostError(stat.size > limit ? 'PATCH_FILE_TOO_LARGE' : 'PATCH_FILE_INVALID');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new NativePatchHostError('PATCH_FILE_CHANGED');
    return {
      bytes,
      size_bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    };
  } finally {
    await handle.close();
  }
}
