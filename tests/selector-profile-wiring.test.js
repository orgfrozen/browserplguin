import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = [
  'src/content/selectors.js',
  'src/content/project-manager.js',
  'src/content/composer.js',
  'src/content/page-access-guard.js'
];

test('content selector consumers read the active selector profile instead of defining duplicate selector sets', async () => {
  const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(file, 'utf8')])));
  for (const [file, source] of Object.entries(sources)) {
    assert.match(source, /getActiveSelectorProfile/, `${file} must read selector registry`);
  }
  assert.doesNotMatch(sources['src/content/project-manager.js'], /const\s+NEW_PROJECT_PATTERNS\s*=/);
  assert.doesNotMatch(sources['src/content/composer.js'], /const\s+SEND_PATTERNS\s*=/);
  assert.doesNotMatch(sources['src/content/page-access-guard.js'], /const\s+LOGIN_PATH_PATTERNS\s*=/);
});
