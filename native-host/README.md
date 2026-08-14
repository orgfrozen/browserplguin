# Native Patch File Reader

`patch-file-reader.mjs` is the native side of remote Patch transfer. It is intentionally read-only and supports `READ_PATCH_FILE` plus a side-effect-free `PING` readiness request.

Security boundary:

- the requested path must be absolute and end in `.patch`;
- the canonical target must remain inside the configured Downloads root;
- the final file may not be a symlink and must be a regular file;
- default maximum size is 32 MiB;
- no directory listing, write, delete, shell execution, arbitrary URL access, or secret lookup exists;
- responses contain Patch bytes, byte size, SHA-256, request id, chunk index/count, and error code only; the local path is never echoed.

The host uses Chrome Native Messaging framing and streams `PATCH_FILE_BEGIN`, one or more `PATCH_FILE_CHUNK`, then `PATCH_FILE_END`. Raw chunks are sized so each host-to-Chrome JSON message stays below the Native Messaging single-message limit.

The Downloads root defaults to `~/Downloads`. `CHATGPT_TASK_RUNNER_DOWNLOADS_DIR` may override it when Chrome uses a custom download directory.

## Install / register

The v0.17.0 installer supports user-level Google Chrome, Chromium, and Chrome for Testing registration on macOS/Linux. Copy the exact current extension ID from the extension Options page, then run from the repository root:

```bash
node native-host/install-native-host.mjs --extension-id <32-char-extension-id> --browser chrome
```

For a custom Chrome Downloads directory:

```bash
node native-host/install-native-host.mjs \
  --extension-id <32-char-extension-id> \
  --browser chrome \
  --downloads-dir "/absolute/path/to/Downloads"
```

The installer copies the host into a stable user data directory, pins the launcher to the absolute Node executable used by the installer, pins the canonical Downloads root, and writes a Native Messaging host manifest whose `allowed_origins` contains exactly `chrome-extension://<ID>/`. Wildcards are rejected by design.

After installation, reload the extension and click **检测 Native Helper** in Options. Readiness uses `PING/PONG` and never reads a Patch path. A successful readiness check does not enable remote transfer; live remote E2E remains required before the remote option is opened.

Windows registry/launcher support is not implemented in this milestone.
