import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  NATIVE_HOST_NAME,
  buildHostManifest,
  resolveNativeManifestDirectory,
  installNativeHost
} from '../native-host/install-service.mjs';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'browserplguin-install-'));
  const homeDir = path.join(base, 'home');
  const downloadsDir = path.join(homeDir, 'Downloads');
  await fs.mkdir(downloadsDir, { recursive: true });
  return { base, homeDir, downloadsDir };
}

test('native host manifest binds one exact validated extension origin and absolute launcher', () => {
  const launcherPath = '/tmp/browserplguin/native-host/launch-patch-reader.sh';
  const manifest = buildHostManifest({ extensionId: EXTENSION_ID, launcherPath });
  assert.deepEqual(manifest, {
    name: NATIVE_HOST_NAME,
    description: 'Browserplguin Patch file reader',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
  });
  assert.throws(() => buildHostManifest({ extensionId: 'bad-id', launcherPath }), /extension id/i);
  assert.throws(() => buildHostManifest({ extensionId: EXTENSION_ID, launcherPath: 'relative.sh' }), /absolute/i);
});

test('native manifest directory follows macOS and Linux user-level Chrome locations', () => {
  const homeDir = '/Users/example';
  assert.equal(
    resolveNativeManifestDirectory({ platform: 'darwin', browser: 'chrome', homeDir }),
    '/Users/example/Library/Application Support/Google/Chrome/NativeMessagingHosts'
  );
  assert.equal(
    resolveNativeManifestDirectory({ platform: 'darwin', browser: 'chrome-for-testing', homeDir }),
    '/Users/example/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts'
  );
  assert.equal(
    resolveNativeManifestDirectory({ platform: 'darwin', browser: 'chromium', homeDir }),
    '/Users/example/Library/Application Support/Chromium/NativeMessagingHosts'
  );
  assert.equal(
    resolveNativeManifestDirectory({ platform: 'linux', browser: 'chrome', homeDir: '/home/example' }),
    '/home/example/.config/google-chrome/NativeMessagingHosts'
  );
  assert.equal(
    resolveNativeManifestDirectory({ platform: 'linux', browser: 'chrome-for-testing', homeDir: '/home/example' }),
    '/home/example/.config/google-chrome-for-testing/NativeMessagingHosts'
  );
  assert.equal(
    resolveNativeManifestDirectory({ platform: 'linux', browser: 'chromium', homeDir: '/home/example' }),
    '/home/example/.config/chromium/NativeMessagingHosts'
  );
  assert.throws(() => resolveNativeManifestDirectory({ platform: 'win32', browser: 'chrome', homeDir }), /unsupported platform/i);
  assert.throws(() => resolveNativeManifestDirectory({ platform: 'linux', browser: 'edge', homeDir }), /unsupported browser/i);
});

test('installer copies host to stable user directory and writes executable absolute launcher plus manifest', async t => {
  const { base, homeDir, downloadsDir } = await fixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceDir = path.resolve(new URL('../native-host', import.meta.url).pathname);
  const nodePath = process.execPath;

  const result = await installNativeHost({
    extensionId: EXTENSION_ID,
    browser: 'chrome',
    downloadsDir,
    platform: 'linux',
    homeDir,
    nodePath,
    sourceDir
  });

  assert.equal(result.host_name, NATIVE_HOST_NAME);
  assert.equal(result.extension_id, EXTENSION_ID);
  assert.equal(result.browser, 'chrome');
  assert.equal(result.downloads_root, await fs.realpath(downloadsDir));
  assert.ok(path.isAbsolute(result.launcher_path));
  assert.ok(path.isAbsolute(result.manifest_path));
  const launcherStat = await fs.stat(result.launcher_path);
  assert.equal((launcherStat.mode & 0o111) !== 0, true);
  const launcher = await fs.readFile(result.launcher_path, 'utf8');
  assert.match(launcher, new RegExp(nodePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(launcher, /CHATGPT_TASK_RUNNER_DOWNLOADS_DIR=/);
  assert.match(launcher, /patch-file-reader\.mjs/);

  const manifest = JSON.parse(await fs.readFile(result.manifest_path, 'utf8'));
  assert.equal(manifest.path, result.launcher_path);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(await fs.readFile(path.join(path.dirname(result.launcher_path), 'patch-file-reader.mjs'), 'utf8').then(text => text.includes('READ_PATCH_FILE')), true);
  assert.equal(await fs.readFile(path.join(path.dirname(result.launcher_path), 'patch-file-service.mjs'), 'utf8').then(text => text.includes('readPatchFile')), true);
});

test('installer rejects invalid extension id and non-absolute or missing Downloads root', async t => {
  const { base, homeDir, downloadsDir } = await fixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceDir = path.resolve(new URL('../native-host', import.meta.url).pathname);
  const common = { browser: 'chrome', platform: 'linux', homeDir, nodePath: process.execPath, sourceDir };

  await assert.rejects(() => installNativeHost({ ...common, extensionId: 'bad', downloadsDir }), /extension id/i);
  await assert.rejects(() => installNativeHost({ ...common, extensionId: EXTENSION_ID, downloadsDir: 'Downloads' }), /absolute/i);
  await assert.rejects(() => installNativeHost({ ...common, extensionId: EXTENSION_ID, downloadsDir: path.join(homeDir, 'missing') }), /downloads/i);
});
