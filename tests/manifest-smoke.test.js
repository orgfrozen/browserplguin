import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('manifest points at classic content bootstrap and module service worker', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.content_scripts[0].js, ['src/content/content-bootstrap.js']);
  assert.ok(manifest.web_accessible_resources.some(entry => entry.resources.some(resource => resource === 'src/content/content-script.js' || resource === 'src/content/*.js')));
});
