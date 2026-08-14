# Remote E2E Preflight Design

## Goal

Provide a side-effect-free readiness gate for the first real remote Patch end-to-end run without claiming Tasks, reading Patch files, uploading artifacts, or enabling remote mode.

## Scope

The preflight checks only environment prerequisites that can be verified safely at runtime:

- settings mode is `real`;
- Task API base URL is valid HTTP(S);
- the extension currently has optional host permission for that Task API origin;
- the installed extension manifest includes `nativeMessaging`;
- the Native Helper answers a live readiness PING;
- helper capabilities include `read_patch_file`, chunked responses, and at least 32 MiB Patch support.

The result is privacy-safe. It contains stable blocker codes and booleans, not Task API URLs/tokens, Extension IDs, native error text, local paths, or DOM data.

## Non-goals

- No Task claim.
- No Patch file read.
- No remote upload.
- No server health probe with side effects.
- No automatic settings mutation.
- No enabling the `remote` Options choice before a real remote E2E is completed.

## Result contract

`runRemoteE2ePreflight()` returns:

- `ready_for_remote_e2e`: boolean;
- `status`: `ready` or `blocked`;
- `checks`: privacy-safe booleans/status values;
- `blockers`: stable blocker-code strings;
- `checked_at`: ISO timestamp.

The same privacy-safe result may be persisted in `chrome.storage.local` for Options display.
