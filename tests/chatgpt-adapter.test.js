import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseExactProjectCandidate } from '../src/content/project-manager.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

test('exact project identity beats substring matches', () => {
  const candidates = [
    { name: 'vetatool-old', href: '/project/1' },
    { name: 'vetatool', href: '/project/2' },
    { name: 'my-vetatool-test', href: '/project/3' }
  ];
  assert.deepEqual(chooseExactProjectCandidate(candidates, 'vetatool'), { name: 'vetatool', href: '/project/2' });
});

test('uncertain project selection fails closed', () => {
  assert.throws(
    () => chooseExactProjectCandidate([{ name: 'vetatool-old' }, { name: 'vetatool-new' }], 'vetatool'),
    error => error instanceof RunnerError && error.code === ERROR_CODES.PROJECT_NOT_FOUND
  );
});

test('duplicate exact identities are ambiguous and fail closed', () => {
  assert.throws(
    () => chooseExactProjectCandidate([{ name: 'vetatool', href: 'a' }, { name: 'vetatool', href: 'b' }], 'vetatool'),
    error => error instanceof RunnerError && error.code === ERROR_CODES.UI_SELECTOR_INCOMPATIBLE
  );
});
