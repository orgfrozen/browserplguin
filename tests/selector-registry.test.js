import test from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, RunnerError } from '../src/shared/errors.js';
import {
  ACTIVE_SELECTOR_PROFILE_ID,
  getSelectorProfile,
  getActiveSelectorProfile,
  getActiveSelectorProfileMetadata
} from '../src/shared/selector-registry.js';

test('active selector profile has stable id/version and preserves current selector ordering', () => {
  assert.equal(ACTIVE_SELECTOR_PROFILE_ID, 'chatgpt-semantic-v1');
  const profile = getActiveSelectorProfile();
  assert.equal(profile.id, 'chatgpt-semantic-v1');
  assert.equal(profile.version, 1);
  assert.deepEqual(profile.selectors.composerButtons, [
    'button[aria-label]',
    'button[title]',
    'button[data-testid]'
  ]);
  assert.deepEqual(profile.selectors.assistantMessages, [
    '[data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn-"]'
  ]);
  assert.deepEqual(profile.selectors.projectLinks, [
    'a[href*="/g/"]',
    'a[href*="/project"]',
    '[role="link"]'
  ]);
  assert.deepEqual(profile.selectors.fileInputs, ['input[type="file"]']);
});

test('active selector profile keeps existing multilingual semantic patterns in order', () => {
  const profile = getActiveSelectorProfile();
  assert.match('New project', profile.patterns.project.newProject[0]);
  assert.match('新建项目', profile.patterns.project.newProject[1]);
  assert.match('新規プロジェクト', profile.patterns.project.newProject[2]);
  assert.match('新项目', profile.patterns.project.newProject[3]);
  assert.match('Send', profile.patterns.composer.send[0]);
  assert.match('发送', profile.patterns.composer.send[2]);
  assert.match('ログイン', profile.patterns.access.loginText.at(-1));
  assert.match('Just a moment...', profile.patterns.access.challengeTitle[0]);
});

test('selector profile metadata is compact and profile data is immutable', () => {
  const profile = getActiveSelectorProfile();
  assert.deepEqual(getActiveSelectorProfileMetadata(), { id: 'chatgpt-semantic-v1', version: 1 });
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.selectors), true);
  assert.equal(Object.isFrozen(profile.patterns.project.newProject), true);
  assert.throws(() => profile.selectors.composerButtons.push('button.foo'), TypeError);
});

test('unknown selector profile fails closed', () => {
  assert.throws(
    () => getSelectorProfile('chatgpt-semantic-v999'),
    error => error instanceof RunnerError && error.code === ERROR_CODES.UI_SELECTOR_INCOMPATIBLE
  );
});

test('active selector profile exposes multilingual exact-conversation cleanup semantics', () => {
  const profile = getActiveSelectorProfile();
  assert.match('Chat options', profile.patterns.conversation.menu[0]);
  assert.ok(profile.patterns.conversation.delete.some(pattern => pattern.test('Delete')));
  assert.ok(profile.patterns.conversation.delete.some(pattern => pattern.test('删除')));
  assert.ok(profile.patterns.conversation.confirmDelete.some(pattern => pattern.test('Delete')));
});
