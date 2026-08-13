# Native Patch File Reader

`patch-file-reader.mjs` is the native side of remote Patch transfer. It is intentionally read-only and only supports the `READ_PATCH_FILE` request.

Security boundary:

- the requested path must be absolute and end in `.patch`;
- the canonical target must remain inside the configured Downloads root;
- the final file may not be a symlink and must be a regular file;
- default maximum size is 32 MiB;
- no directory listing, write, delete, shell execution, arbitrary URL access, or secret lookup exists;
- responses contain Patch bytes, byte size, SHA-256, request id, chunk index/count, and error code only; the local path is never echoed.

The host uses Chrome Native Messaging framing and streams `PATCH_FILE_BEGIN`, one or more `PATCH_FILE_CHUNK`, then `PATCH_FILE_END`. Raw chunks are sized so each host-to-Chrome JSON message stays below the Native Messaging single-message limit.

The Downloads root defaults to `~/Downloads`. `CHATGPT_TASK_RUNNER_DOWNLOADS_DIR` may override it when Chrome uses a custom download directory.

Host manifest installation/registration and end-to-end remote enablement are intentionally not part of v0.16.0.
