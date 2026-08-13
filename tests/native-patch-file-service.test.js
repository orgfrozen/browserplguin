import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readPatchFile } from '../native-host/patch-file-service.mjs';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'browserplguin-native-'));
  const downloadsRoot = path.join(base, 'Downloads');
  await fs.mkdir(downloadsRoot);
  return { base, downloadsRoot };
}

test('native file service reads only a regular Patch inside canonical Downloads root and hashes exact bytes', async t => {
  const { base, downloadsRoot } = await fixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const file = path.join(downloadsRoot, 'patch-s1-001.patch');
  const bytes = Buffer.from('diff --git a/a b/a\n+hello\n', 'utf8');
  await fs.writeFile(file, bytes);

  const result = await readPatchFile(file, { downloadsRoot, maxBytes: 1024 });

  assert.deepEqual(result, {
    bytes,
    size_bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
});

test('native file service rejects traversal outside Downloads, non-Patch files, symlinks, and oversized content', async t => {
  const { base, downloadsRoot } = await fixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const outside = path.join(base, 'outside.patch');
  const textFile = path.join(downloadsRoot, 'notes.txt');
  const largeFile = path.join(downloadsRoot, 'large.patch');
  const symlink = path.join(downloadsRoot, 'linked.patch');
  await fs.writeFile(outside, 'outside');
  await fs.writeFile(textFile, 'not patch');
  await fs.writeFile(largeFile, Buffer.alloc(33));
  await fs.symlink(outside, symlink);

  await assert.rejects(() => readPatchFile(outside, { downloadsRoot, maxBytes: 1024 }), error => error.code === 'PATCH_FILE_NOT_ALLOWED');
  await assert.rejects(() => readPatchFile(textFile, { downloadsRoot, maxBytes: 1024 }), error => error.code === 'PATCH_FILE_NOT_ALLOWED');
  await assert.rejects(() => readPatchFile(symlink, { downloadsRoot, maxBytes: 1024 }), error => error.code === 'PATCH_FILE_NOT_ALLOWED');
  await assert.rejects(() => readPatchFile(largeFile, { downloadsRoot, maxBytes: 32 }), error => error.code === 'PATCH_FILE_TOO_LARGE');
});

test('native file service rejects a Patch reached through a symlinked directory that escapes Downloads', async t => {
  const { base, downloadsRoot } = await fixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const outsideDir = path.join(base, 'outside-dir');
  await fs.mkdir(outsideDir);
  await fs.writeFile(path.join(outsideDir, 'escape.patch'), 'escape');
  await fs.symlink(outsideDir, path.join(downloadsRoot, 'linked-dir'));

  await assert.rejects(
    () => readPatchFile(path.join(downloadsRoot, 'linked-dir', 'escape.patch'), { downloadsRoot, maxBytes: 1024 }),
    error => error.code === 'PATCH_FILE_NOT_ALLOWED'
  );
});
