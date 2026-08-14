#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNativeHost } from './install-service.mjs';

function usage() {
  return `Usage:\n  node native-host/install-native-host.mjs --extension-id <32-char-id> [--browser chrome|chromium|chrome-for-testing] [--downloads-dir /absolute/path]\n`;
}

function parseArgs(args) {
  const options = { browser: 'chrome', downloadsDir: path.join(os.homedir(), 'Downloads') };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--extension-id') options.extensionId = args[++index];
    else if (arg === '--browser') options.browser = args[++index];
    else if (arg === '--downloads-dir') options.downloadsDir = args[++index];
    else throw new TypeError(`Unknown argument: ${arg}`);
  }
  if (!options.extensionId) throw new TypeError('--extension-id is required');
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    const result = await installNativeHost({
      ...options,
      platform: process.platform,
      homeDir: os.homedir(),
      nodePath: process.execPath,
      sourceDir: path.dirname(fileURLToPath(import.meta.url))
    });
    process.stdout.write([
      `Installed ${result.host_name} for ${result.browser}.`,
      `Extension ID: ${result.extension_id}`,
      `Manifest: ${result.manifest_path}`,
      `Launcher: ${result.launcher_path}`,
      `Downloads root: ${result.downloads_root}`,
      'Reload the extension, open Options, then click “检测 Native Helper”.',
      ''
    ].join('\n'));
  }
} catch (error) {
  process.stderr.write(`${error.message}\n${usage()}`);
  process.exitCode = 1;
}
