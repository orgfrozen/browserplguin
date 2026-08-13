import test from 'node:test';
import assert from 'node:assert/strict';
import { NativePatchFileReader } from '../src/background/native-patch-file-reader.js';
import { ERROR_CODES } from '../src/shared/errors.js';

function artifact(overrides = {}) {
  return {
    task_id: 't1',
    session_id: 's1',
    filename: 'patch-s1-001.patch',
    patch_key: 'patch-s1-001.patch',
    local_path: '/Users/test/Downloads/patch-s1-001.patch',
    ...overrides
  };
}

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(value) { for (const listener of listeners) listener(value); }
  };
}

function runtimeWith(onPost) {
  const calls = [];
  const runtime = { calls, lastError: null };
  runtime.connectNative = hostName => {
    const onMessage = event();
    const onDisconnect = event();
    const port = {
      onMessage,
      onDisconnect,
      disconnected: false,
      postMessage(message) {
        calls.push({ hostName, message: structuredClone(message) });
        onPost({ runtime, port, message });
      },
      disconnect() { this.disconnected = true; }
    };
    return port;
  };
  return runtime;
}

function emitSuccess(port, requestId) {
  queueMicrotask(() => {
    port.onMessage.emit({
      type: 'PATCH_FILE_BEGIN',
      request_id: requestId,
      size_bytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      chunks: 2
    });
    port.onMessage.emit({ type: 'PATCH_FILE_CHUNK', request_id: requestId, index: 0, content_base64: 'aGVs' });
    port.onMessage.emit({ type: 'PATCH_FILE_CHUNK', request_id: requestId, index: 1, content_base64: 'bG8=' });
    port.onMessage.emit({ type: 'PATCH_FILE_END', request_id: requestId, chunks: 2 });
  });
}

test('NativePatchFileReader requests exact local path and reassembles verified chunked Patch bytes', async () => {
  const runtime = runtimeWith(({ port, message }) => emitSuccess(port, message.request_id));
  const reader = new NativePatchFileReader({
    runtime,
    hostName: 'com.browserplguin.patch_reader',
    maxBytes: 1024,
    requestIdFactory: () => 'req-1'
  });

  const result = await reader.read(artifact());

  assert.deepEqual(runtime.calls, [{
    hostName: 'com.browserplguin.patch_reader',
    message: {
      type: 'READ_PATCH_FILE',
      request_id: 'req-1',
      path: '/Users/test/Downloads/patch-s1-001.patch',
      max_bytes: 1024
    }
  }]);
  assert.equal(result.content_base64, 'aGVsbG8=');
  assert.equal(result.size_bytes, 5);
  assert.equal(result.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(result.local_path, artifact().local_path);
});

test('NativePatchFileReader fails closed for missing host, host error, request mismatch, chunk disorder, or malformed stream', async () => {
  const cases = [
    runtimeWith(({ runtime, port }) => queueMicrotask(() => {
      runtime.lastError = { message: 'Specified native messaging host not found.' };
      port.onDisconnect.emit();
      runtime.lastError = null;
    })),
    runtimeWith(({ port, message }) => queueMicrotask(() => port.onMessage.emit({ type: 'PATCH_FILE_ERROR', request_id: message.request_id, error: { code: 'PATCH_FILE_NOT_ALLOWED' } }))),
    runtimeWith(({ port }) => queueMicrotask(() => port.onMessage.emit({ type: 'PATCH_FILE_BEGIN', request_id: 'other', size_bytes: 5, sha256: 'a'.repeat(64), chunks: 1 }))),
    runtimeWith(({ port, message }) => queueMicrotask(() => {
      port.onMessage.emit({ type: 'PATCH_FILE_BEGIN', request_id: message.request_id, size_bytes: 5, sha256: 'a'.repeat(64), chunks: 2 });
      port.onMessage.emit({ type: 'PATCH_FILE_CHUNK', request_id: message.request_id, index: 1, content_base64: 'bG8=' });
    })),
    runtimeWith(({ port, message }) => queueMicrotask(() => {
      port.onMessage.emit({ type: 'PATCH_FILE_BEGIN', request_id: message.request_id, size_bytes: 5, sha256: 'a'.repeat(64), chunks: 1 });
      port.onMessage.emit({ type: 'PATCH_FILE_CHUNK', request_id: message.request_id, index: 0, content_base64: 'not/base64?' });
    })),
    runtimeWith(({ port, message }) => queueMicrotask(() => {
      port.onMessage.emit({ type: 'PATCH_FILE_BEGIN', request_id: message.request_id, size_bytes: 6, sha256: 'a'.repeat(64), chunks: 1 });
      port.onMessage.emit({ type: 'PATCH_FILE_CHUNK', request_id: message.request_id, index: 0, content_base64: 'aGVsbG8=' });
      port.onMessage.emit({ type: 'PATCH_FILE_END', request_id: message.request_id, chunks: 1 });
    })),
    runtimeWith(({ port, message }) => queueMicrotask(() => port.onMessage.emit({ type: 'PATCH_FILE_BEGIN', request_id: message.request_id, size_bytes: 5, sha256: 'bad', chunks: 1 })))
  ];

  for (const runtime of cases) {
    const reader = new NativePatchFileReader({ runtime, maxBytes: 1024, requestIdFactory: () => 'req-1' });
    await assert.rejects(
      () => reader.read(artifact()),
      error => error.code === ERROR_CODES.REMOTE_ARTIFACT_READ_FAILED
    );
  }
});

test('NativePatchFileReader rejects missing local path and BEGIN size beyond configured max bytes', async () => {
  const runtime = runtimeWith(({ port, message }) => queueMicrotask(() => port.onMessage.emit({
    type: 'PATCH_FILE_BEGIN',
    request_id: message.request_id,
    size_bytes: 6,
    sha256: 'a'.repeat(64),
    chunks: 1
  })));
  const reader = new NativePatchFileReader({ runtime, maxBytes: 5, requestIdFactory: () => 'req-1' });

  await assert.rejects(() => reader.read(artifact({ local_path: null })), error => error.code === ERROR_CODES.REMOTE_ARTIFACT_READ_FAILED);
  await assert.rejects(() => reader.read(artifact()), error => error.code === ERROR_CODES.REMOTE_ARTIFACT_READ_FAILED);
});
