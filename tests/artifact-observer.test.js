import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPatchCandidatesFromElement } from '../src/content/artifact-observer.js';

function node({ text = '', href = null, download = '' }) {
  return {
    textContent: text,
    getAttribute(name) {
      if (name === 'href') return href;
      if (name === 'download') return download;
      return null;
    }
  };
}

test('recognizes a visible 下载 Patch control even when filename is not exposed yet', () => {
  const button = node({ text: '下载 Patch' });
  const root = { querySelectorAll() { return [button]; } };
  const result = extractPatchCandidatesFromElement(root);
  assert.equal(result.length, 1);
  assert.equal(result[0].filename, null);
  assert.equal(result[0].label, '下载 Patch');
});
