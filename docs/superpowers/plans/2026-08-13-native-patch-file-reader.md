# Native Patch File Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed Native Messaging Patch file reader that supplies verified Patch bytes to the existing remote artifact transport without enabling remote mode yet.

**Architecture:** A Node.js native host reads only `.patch` files whose canonical real path is inside the configured Downloads root, rejects symlinks/non-files/oversized content, and returns base64, byte size, and SHA-256 over Chrome Native Messaging framing. The extension-side `NativePatchFileReader` uses a persistent `runtime.connectNative()` Port and reassembles bounded `BEGIN → CHUNK → END` messages so every host-to-Chrome message stays below the Native Messaging limit; it validates the stream before `ArtifactTransferManager(remote)` invokes `RemoteArtifactTransport`; Patch bytes remain stripped from durable/report metadata.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node.js built-ins only, Chrome Native Messaging, Node built-in test runner.

## Global Constraints

- Use the uploaded source ZIP plus Patch 001-012 as the only parent state.
- Do not commit, clone, push, add external dependencies, or modify `.patch-session.json`.
- Local artifact transfer behavior must remain unchanged.
- Options remote mode stays disabled until installation/registration and live E2E are implemented later.
- Native host accepts only `.patch` files under the configured Downloads root and returns no arbitrary directory listing or write capability.
- Default Patch byte ceiling remains 32 MiB.

---

### Task 1: Native host file service and framing

**Files:**
- Create: `native-host/patch-file-service.mjs`
- Create: `native-host/patch-file-reader.mjs`
- Test: `tests/native-patch-file-service.test.js`
- Test: `tests/native-patch-host-framing.test.js`

**Interfaces:**
- Produces: `readPatchFile(path, { downloadsRoot, maxBytes }) -> { bytes, size_bytes, sha256 }`.
- Produces: Native request `{ type: "READ_PATCH_FILE", request_id, path, max_bytes? }` and bounded response stream `PATCH_FILE_BEGIN → PATCH_FILE_CHUNK(index, content_base64) → PATCH_FILE_END`; failures use `PATCH_FILE_ERROR`.

- [x] **Step 1: Write failing tests** for canonical Downloads-root containment, `.patch` extension, regular-file/symlink rejection, max size, SHA-256, and native 4-byte little-endian framing.
- [x] **Step 2: Run focused tests and confirm they fail** because the host modules do not exist.
- [x] **Step 3: Implement the minimal host service and framing** using only `node:fs`, `node:path`, `node:os`, and `node:crypto`.
- [x] **Step 4: Run focused tests and confirm they pass**.

### Task 2: Extension NativePatchFileReader

**Files:**
- Create: `src/background/native-patch-file-reader.js`
- Modify: `src/shared/errors.js`
- Test: `tests/native-patch-file-reader.test.js`

**Interfaces:**
- Produces: `new NativePatchFileReader({ runtime, hostName, maxBytes, requestIdFactory }).read(artifact)`.
- Returns the input artifact enriched with `content_base64`, `size_bytes`, and `sha256` only in memory.

- [x] **Step 1: Write failing tests** for request construction, host unavailable/error handling, request-id mismatch, ordered chunk reassembly, canonical base64/size/SHA validation, and max-size enforcement.
- [x] **Step 2: Run focused tests and confirm they fail** because the reader does not exist.
- [x] **Step 3: Implement the minimal reader** using `chrome.runtime.connectNative` and fail-closed chunk-stream validation.
- [x] **Step 4: Run focused tests and confirm they pass**.

### Task 3: Remote transfer integration

**Files:**
- Modify: `src/background/artifact-transfer-manager.js`
- Modify: `src/background/service-worker.js`
- Modify: `manifest.json`
- Test: `tests/artifact-transfer-manager.test.js`
- Test: `tests/service-worker-wiring.test.js`

**Interfaces:**
- Consumes: `NativePatchFileReader.read(artifact)`.
- Existing `RemoteArtifactTransport.upload(artifactWithBytes)` remains unchanged.

- [x] **Step 1: Write failing tests** proving remote mode reads bytes before upload when the Chrome artifact contains only `local_path`, and local mode never calls the reader.
- [x] **Step 2: Run focused tests and confirm they fail** on the old constructor/wiring.
- [x] **Step 3: Implement minimal integration** and add `nativeMessaging` permission required by `connectNative`.
- [x] **Step 4: Run focused tests and confirm they pass**.

### Task 4: Documentation, version, and Patch 013 verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PATCH_DOWNLOAD.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

- [x] **Step 1: Update docs** to mark the Native file-reader code path implemented but installation/registration/live E2E still pending; remote option remains disabled.
- [x] **Step 2: Set package/lock/manifest version to `0.16.0`**.
- [x] **Step 3: Run `npm test`, JS syntax checks, JSON parsing, and `git diff --check`**.
- [x] **Step 4: Generate Patch 013** with required Patch Sync metadata and no `.patch-session.json` diff.
- [x] **Step 5: Rebuild a fresh source + 001-012 parent, apply-check/apply 013, and rerun the full verification**.
