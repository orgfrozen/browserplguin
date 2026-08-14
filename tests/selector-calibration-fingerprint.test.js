import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeCalibrationFingerprint } from '../src/content/ui-semantics.js';

function fakeNode({ tagName = 'BUTTON', attrs = {}, text = '', parent = null } = {}) {
  return {
    tagName,
    textContent: text,
    parentElement: parent,
    getAttribute(name) { return attrs[name] ?? null; }
  };
}

test('safe calibration fingerprint exports only structural enums and never raw private DOM values', () => {
  const shell = fakeNode({ tagName: 'SECTION', attrs: { role: 'region', 'aria-label': 'Secret Project Alpha' } });
  const dialog = fakeNode({ tagName: 'DIV', attrs: { role: 'dialog', title: 'Private customer dialog' }, parent: shell });
  const node = fakeNode({
    tagName: 'BUTTON',
    text: 'Upload secret-session-001.patch for Secret Project Alpha',
    attrs: {
      role: 'button',
      type: 'button',
      'data-testid': 'upload-secret-user-12345678901234567890',
      name: 'ewan@example.com',
      'aria-label': 'Upload private-tax-2026.zip',
      title: 'https://secret.invalid/path?token=hidden',
      placeholder: 'TOP-SECRET prompt',
      value: 'SECRET-VALUE',
      href: 'https://secret.invalid/download/private.patch?token=hidden'
    },
    parent: dialog
  });

  const result = buildSafeCalibrationFingerprint(node);
  assert.deepEqual(Object.keys(result).sort(), [
    'ancestor_roles', 'name_category', 'role', 'semantic_hint', 'tag', 'test_id_category', 'type'
  ].sort());
  assert.equal(result.tag, 'button');
  assert.equal(result.role, 'button');
  assert.equal(result.type, 'button');
  assert.equal(result.semantic_hint, 'attach');
  assert.deepEqual(result.ancestor_roles, ['dialog', 'region']);
  assert.ok(['attach', 'present_unknown'].includes(result.test_id_category));
  assert.equal(result.name_category, 'present_unknown');

  const serialized = JSON.stringify(result).toLowerCase();
  for (const secret of ['secret', 'private', 'ewan', 'example.com', 'token', '.patch', '.zip', 'top-secret', 'secret.invalid']) {
    assert.equal(serialized.includes(secret), false, `fingerprint leaked ${secret}`);
  }
});

test('safe calibration fingerprint maps unknown roles/types/tags to bounded structural categories', () => {
  const parent3 = fakeNode({ tagName: 'CUSTOM-ROOT', attrs: { role: 'made-up-role' } });
  const parent2 = fakeNode({ tagName: 'NAV', parent: parent3 });
  const parent1 = fakeNode({ tagName: 'DIV', attrs: { role: 'menu' }, parent: parent2 });
  const node = fakeNode({ tagName: 'CUSTOM-WIDGET', attrs: { role: 'secret-role', type: 'secret-type' }, parent: parent1 });
  const result = buildSafeCalibrationFingerprint(node);
  assert.equal(result.tag, 'other');
  assert.equal(result.role, 'other');
  assert.equal(result.type, 'other');
  assert.deepEqual(result.ancestor_roles, ['menu', 'nav', 'other']);
  assert.equal(result.semantic_hint, 'unknown');
});
