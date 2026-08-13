import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPatchIdentity, isCurrentSessionPatch, dedupePatchCandidates } from '../src/shared/patch-identity.js';

test('extracts session-local patch identity', () => {
  assert.deepEqual(extractPatchIdentity('vetatool-b81ac90277-001.patch', 'b81ac90277'), {
    key: 'vetatool-b81ac90277-001.patch', filename: 'vetatool-b81ac90277-001.patch', sessionId: 'b81ac90277', sequence: 1
  });
});

test('different session ids keep their 001 patch identities distinct', () => {
  assert.equal(isCurrentSessionPatch('patch-faf42343242-001.patch', 'b81ac90277'), false);
  assert.equal(isCurrentSessionPatch('patch-b81ac90277-001.patch', 'b81ac90277'), true);
});

test('dedupe keeps only current-session unseen patch candidates', () => {
  const candidates = [
    { filename: 'patch-b81ac90277-001.patch', url: 'blob:a' },
    { filename: 'patch-b81ac90277-001.patch', url: 'blob:a2' },
    { filename: 'patch-b81ac90277-002.patch', url: 'blob:b' },
    { filename: 'patch-faf42343242-010.patch', url: 'blob:old' }
  ];
  const result = dedupePatchCandidates(candidates, new Set(['patch-b81ac90277-002.patch']), 'b81ac90277');
  assert.deepEqual(result.map(x => x.filename), ['patch-b81ac90277-001.patch']);
});
