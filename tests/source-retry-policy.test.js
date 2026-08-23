import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableSourceError, sourceRetryDelayMs } from '../src/background/source-retry-policy.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

test('source retry backoff uses 5s 10s 30s then caps at 60s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(sourceRetryDelayMs), [5000, 10000, 30000, 60000, 60000, 60000]);
});

test('source retry policy retries transport failures but not invalid source metadata', () => {
  assert.equal(isRetryableSourceError(new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'PatchSync request failed', { cause: 'Failed to fetch' })), true);
  assert.equal(isRetryableSourceError(new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'PatchSync request returned HTTP 503', { status: 503 })), true);
  assert.equal(isRetryableSourceError(new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'PatchSync request returned HTTP 429', { status: 429 })), true);
  assert.equal(isRetryableSourceError(new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'PatchSync export project does not match the Task project', { task_project_id: 'a', export_project_id: 'b' })), false);
  assert.equal(isRetryableSourceError(new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'PatchSync source is empty')), false);
  assert.equal(isRetryableSourceError(new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'PatchSync request returned HTTP 404', { status: 404 })), false);
});
