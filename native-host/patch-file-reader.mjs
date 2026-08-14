#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { readPatchFile, DEFAULT_MAX_PATCH_BYTES, NativePatchHostError } from './patch-file-service.mjs';

const MAX_HOST_MESSAGE_BYTES = 1024 * 1024;
const HOST_NAME = 'com.browserplguin.patch_reader';
const HOST_PROTOCOL_VERSION = 1;
const RAW_CHUNK_BYTES = (512 * 1024) - 2; // 524286, divisible by 3 so only the final base64 chunk can contain padding.
const downloadsRoot = process.env.CHATGPT_TASK_RUNNER_DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads');

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length >= MAX_HOST_MESSAGE_BYTES) throw new NativePatchHostError('NATIVE_MESSAGE_TOO_LARGE');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function requestIdOf(message) {
  return typeof message?.request_id === 'string' && message.request_id.length > 0 ? message.request_id : null;
}

async function handleRequest(message) {
  const requestId = requestIdOf(message);
  try {
    if (message?.type === 'PING' && requestId) {
      writeMessage({
        type: 'PONG',
        request_id: requestId,
        host_name: HOST_NAME,
        protocol_version: HOST_PROTOCOL_VERSION,
        capabilities: {
          read_patch_file: true,
          chunked: true,
          max_patch_bytes: DEFAULT_MAX_PATCH_BYTES
        }
      });
      return;
    }
    if (message?.type !== 'READ_PATCH_FILE' || !requestId || typeof message.path !== 'string') {
      throw new NativePatchHostError('INVALID_REQUEST');
    }
    const requestedMax = Number.isInteger(message.max_bytes) && message.max_bytes > 0
      ? Math.min(message.max_bytes, DEFAULT_MAX_PATCH_BYTES)
      : DEFAULT_MAX_PATCH_BYTES;
    const file = await readPatchFile(message.path, { downloadsRoot, maxBytes: requestedMax });
    const chunks = Math.ceil(file.size_bytes / RAW_CHUNK_BYTES);
    writeMessage({
      type: 'PATCH_FILE_BEGIN',
      request_id: requestId,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
      chunks
    });
    for (let index = 0; index < chunks; index += 1) {
      const start = index * RAW_CHUNK_BYTES;
      const end = Math.min(start + RAW_CHUNK_BYTES, file.size_bytes);
      writeMessage({
        type: 'PATCH_FILE_CHUNK',
        request_id: requestId,
        index,
        content_base64: file.bytes.subarray(start, end).toString('base64')
      });
    }
    writeMessage({ type: 'PATCH_FILE_END', request_id: requestId, chunks });
  } catch (error) {
    writeMessage({
      type: 'PATCH_FILE_ERROR',
      request_id: requestId,
      error: { code: error instanceof NativePatchHostError ? error.code : 'PATCH_FILE_READ_FAILED' }
    });
  }
}

let buffer = Buffer.alloc(0);
let chain = Promise.resolve();
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length <= 0 || length > 64 * 1024 * 1024) {
      chain = chain.then(() => handleRequest({ type: 'INVALID' }));
      buffer = Buffer.alloc(0);
      break;
    }
    if (buffer.length < 4 + length) break;
    const body = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);
    let message;
    try {
      message = JSON.parse(body.toString('utf8'));
    } catch {
      message = { type: 'INVALID' };
    }
    chain = chain.then(() => handleRequest(message));
  }
});
process.stdin.on('end', () => {
  chain.catch(error => console.error(error)).finally(() => {
    if (buffer.length !== 0) process.exitCode = 1;
  });
});
