import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceLoader } from '../src/background/resource-loader.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

function response(bytes, { status = 200, headers = {} } = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return normalized.get(String(name).toLowerCase()) ?? null; } },
    async arrayBuffer() { return Uint8Array.from(bytes).buffer; }
  };
}

test('downloads resource and derives safe metadata from response URL and content type', async () => {
  const loader = new ResourceLoader({
    fetchImpl: async () => response([1, 2, 3], { headers: { 'content-type': 'application/zip' } }),
    maxBytes: 1024
  });
  const result = await loader.load({ url: 'https://assets.example.com/build/source.zip' });
  assert.equal(result.filename, 'source.zip');
  assert.equal(result.mimeType, 'application/zip');
  assert.equal(result.size, 3);
  assert.equal(result.base64, 'AQID');
  assert.equal(result.sourceUrl, 'https://assets.example.com/build/source.zip');
});

test('explicit resource filename wins over response metadata', async () => {
  const loader = new ResourceLoader({
    fetchImpl: async () => response([65], { headers: { 'content-disposition': 'attachment; filename="server.zip"' } })
  });
  const result = await loader.load({ url: 'https://assets.example.com/download?id=1', filename: 'task-source.zip' });
  assert.equal(result.filename, 'task-source.zip');
});

test('non-2xx empty and oversize resources fail closed', async () => {
  const notFound = new ResourceLoader({ fetchImpl: async () => response([], { status: 404 }) });
  await assert.rejects(notFound.load({ url: 'https://assets.example.com/missing.zip' }), error => error instanceof RunnerError && error.code === ERROR_CODES.RESOURCE_DOWNLOAD_FAILED);

  const empty = new ResourceLoader({ fetchImpl: async () => response([]) });
  await assert.rejects(empty.load({ url: 'https://assets.example.com/empty.zip' }), error => error instanceof RunnerError && error.code === ERROR_CODES.RESOURCE_DOWNLOAD_FAILED);

  const large = new ResourceLoader({ fetchImpl: async () => response([1, 2, 3, 4]), maxBytes: 3 });
  await assert.rejects(large.load({ url: 'https://assets.example.com/large.zip' }), error => error instanceof RunnerError && error.code === ERROR_CODES.RESOURCE_DOWNLOAD_FAILED);
});
