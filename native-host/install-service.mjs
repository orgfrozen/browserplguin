import fs from 'node:fs/promises';
import path from 'node:path';

export const NATIVE_HOST_NAME = 'com.browserplguin.patch_reader';
const EXTENSION_ID = /^[a-p]{32}$/;
const BROWSERS = new Set(['chrome', 'chromium', 'chrome-for-testing']);

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  return value;
}

export function validateExtensionId(extensionId) {
  if (typeof extensionId !== 'string' || !EXTENSION_ID.test(extensionId)) {
    throw new TypeError('Chrome extension id must be exactly 32 lowercase characters in the a-p range');
  }
  return extensionId;
}

export function resolveNativeManifestDirectory({ platform, browser, homeDir }) {
  requireAbsolute(homeDir, 'homeDir');
  if (!BROWSERS.has(browser)) throw new TypeError(`Unsupported browser: ${browser}`);
  if (platform === 'darwin') {
    const suffix = browser === 'chrome'
      ? ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts']
      : browser === 'chrome-for-testing'
        ? ['Library', 'Application Support', 'Google', 'ChromeForTesting', 'NativeMessagingHosts']
        : ['Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'];
    return path.join(homeDir, ...suffix);
  }
  if (platform === 'linux') {
    const suffix = browser === 'chrome'
      ? ['.config', 'google-chrome', 'NativeMessagingHosts']
      : browser === 'chrome-for-testing'
        ? ['.config', 'google-chrome-for-testing', 'NativeMessagingHosts']
        : ['.config', 'chromium', 'NativeMessagingHosts'];
    return path.join(homeDir, ...suffix);
  }
  throw new TypeError(`Unsupported platform for Native Host installer: ${platform}`);
}

export function resolveInstallDirectory({ platform, homeDir }) {
  requireAbsolute(homeDir, 'homeDir');
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', 'browserplguin', 'native-host');
  if (platform === 'linux') return path.join(homeDir, '.local', 'share', 'browserplguin', 'native-host');
  throw new TypeError(`Unsupported platform for Native Host installer: ${platform}`);
}

export function buildHostManifest({ extensionId, launcherPath }) {
  validateExtensionId(extensionId);
  requireAbsolute(launcherPath, 'launcherPath');
  return {
    name: NATIVE_HOST_NAME,
    description: 'Browserplguin Patch file reader',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function canonicalDirectory(value, label) {
  requireAbsolute(value, label);
  const real = await fs.realpath(value).catch(() => { throw new TypeError(`${label} does not exist`); });
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new TypeError(`${label} must be a directory`);
  return real;
}

export async function installNativeHost({
  extensionId,
  browser = 'chrome',
  downloadsDir,
  platform,
  homeDir,
  nodePath,
  sourceDir
}) {
  validateExtensionId(extensionId);
  if (!BROWSERS.has(browser)) throw new TypeError(`Unsupported browser: ${browser}`);
  requireAbsolute(homeDir, 'homeDir');
  requireAbsolute(nodePath, 'nodePath');
  requireAbsolute(sourceDir, 'sourceDir');
  const downloadsRoot = await canonicalDirectory(downloadsDir, 'downloadsDir');
  const sourceRoot = await canonicalDirectory(sourceDir, 'sourceDir');
  const installDir = resolveInstallDirectory({ platform, homeDir });
  const manifestDir = resolveNativeManifestDirectory({ platform, browser, homeDir });
  await fs.mkdir(installDir, { recursive: true });
  await fs.mkdir(manifestDir, { recursive: true });

  for (const file of ['patch-file-reader.mjs', 'patch-file-service.mjs']) {
    await fs.copyFile(path.join(sourceRoot, file), path.join(installDir, file));
    await fs.chmod(path.join(installDir, file), 0o644);
  }

  const launcherPath = path.join(installDir, 'launch-patch-reader.sh');
  const launcher = [
    '#!/bin/sh',
    `export CHATGPT_TASK_RUNNER_DOWNLOADS_DIR=${shellQuote(downloadsRoot)}`,
    `exec ${shellQuote(nodePath)} ${shellQuote(path.join(installDir, 'patch-file-reader.mjs'))} "$@"`,
    ''
  ].join('\n');
  await fs.writeFile(launcherPath, launcher, { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(launcherPath, 0o755);

  const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  const manifest = buildHostManifest({ extensionId, launcherPath });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });

  return {
    host_name: NATIVE_HOST_NAME,
    extension_id: extensionId,
    browser,
    downloads_root: downloadsRoot,
    install_dir: installDir,
    launcher_path: launcherPath,
    manifest_path: manifestPath
  };
}
