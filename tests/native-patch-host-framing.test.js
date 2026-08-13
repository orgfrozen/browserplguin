import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset < buffer.length) {
    assert.ok(offset + 4 <= buffer.length);
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    assert.ok(offset + length <= buffer.length);
    messages.push(JSON.parse(buffer.subarray(offset, offset + length).toString('utf8')));
    offset += length;
  }
  return messages;
}

test('native host streams Chrome-framed BEGIN CHUNK END messages without path leakage', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'browserplguin-host-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const downloadsRoot = path.join(base, 'Downloads');
  await fs.mkdir(downloadsRoot);
  const patchPath = path.join(downloadsRoot, 'safe.patch');
  await fs.writeFile(patchPath, 'hello');

  const child = spawn(process.execPath, ['native-host/patch-file-reader.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, CHATGPT_TASK_RUNNER_DOWNLOADS_DIR: downloadsRoot },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin.end(frame({ type: 'READ_PATCH_FILE', request_id: 'req-1', path: patchPath, max_bytes: 1024 }));
  const [stdout, stderr, exitCode] = await Promise.all([
    readAll(child.stdout),
    readAll(child.stderr),
    new Promise(resolve => child.once('close', resolve))
  ]);

  assert.equal(exitCode, 0, stderr.toString('utf8'));
  const messages = parseFrames(stdout);
  assert.deepEqual(messages.map(message => message.type), ['PATCH_FILE_BEGIN', 'PATCH_FILE_CHUNK', 'PATCH_FILE_END']);
  assert.equal(messages[0].request_id, 'req-1');
  assert.equal(messages[0].size_bytes, 5);
  assert.equal(messages[0].chunks, 1);
  assert.match(messages[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(messages[1].index, 0);
  assert.equal(messages[1].content_base64, 'aGVsbG8=');
  assert.equal(messages[2].chunks, 1);
  assert.equal(JSON.stringify(messages).includes(patchPath), false);
});
