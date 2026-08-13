import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyComposerState, isRoundTransitionComplete } from '../src/content/model-state-observer.js';

test('classifies generating from stop semantics and ready from send semantics', () => {
  assert.equal(classifyComposerState([{ ariaLabel: 'Stop generating', text: '', title: '' }]), 'GENERATING');
  assert.equal(classifyComposerState([{ ariaLabel: 'Send prompt', text: '', title: '' }]), 'READY');
  assert.equal(classifyComposerState([{ ariaLabel: 'Something else', text: '', title: '' }]), 'UNKNOWN');
});

test('round completion requires READY to GENERATING to READY transition', () => {
  assert.equal(isRoundTransitionComplete(['READY']), false);
  assert.equal(isRoundTransitionComplete(['READY', 'GENERATING']), false);
  assert.equal(isRoundTransitionComplete(['READY', 'GENERATING', 'READY']), true);
  assert.equal(isRoundTransitionComplete(['GENERATING', 'READY']), true);
});
