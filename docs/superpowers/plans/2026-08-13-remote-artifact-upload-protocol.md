# Remote Artifact Upload Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the remote Patch upload protocol/transport foundation while keeping local transfer unchanged and keeping remote UI disabled until a file-reading helper can supply Patch bytes.

**Architecture:** `HttpTaskApi` gains a lease-scoped idempotent `/tasks/{task_id}/artifacts/upload` JSON write. A new `RemoteArtifactTransport` validates base64 Patch bytes, retries only transient failures with the same payload/idempotency key, validates the remote receipt, and never returns file content in the receipt. `ArtifactTransferManager` strips content bytes before the metadata artifact is persisted/reported. Service worker wires the transport for remote mode, but Options continues to disable remote until Native Helper/file reading exists.

**Tech Stack:** Manifest V3, modern JavaScript ES modules, Node built-in test runner, existing Task API lease/idempotency protocol.

## Global Constraints

- Use the uploaded source ZIP plus Patch 001–011 as the only parent state.
- Do not modify `.patch-session.json`.
- Do not run git clone/commit/push.
- Do not add dependencies.
- Keep `patchTransferMode=local` behavior unchanged.
- Remote mode must fail closed when Patch bytes are unavailable.
- Do not persist/report `content_base64` or raw Patch bytes after upload.
- Keep the remote option disabled in Options until Native Helper/file reading is implemented.

---

### Task 1: Lease-scoped remote upload API

**Files:**
- Modify: `src/background/task-api.js`
- Test: `tests/http-task-api.test.js`

**Interfaces:**
- Consumes: the existing claimed/restored task lease.
- Produces: `HttpTaskApi.uploadArtifactContent(taskId, payload)` using `POST /tasks/{task_id}/artifacts/upload` with lease and stable idempotency headers.

- [x] Add a failing test proving upload uses the lease token, protocol header, and stable idempotency key for identical content payloads.
- [x] Run the targeted test and confirm it fails because `uploadArtifactContent` is missing.
- [x] Implement `TaskApi.uploadArtifactContent()` and `HttpTaskApi.uploadArtifactContent()` via the existing canonical task-write path.
- [x] Run `tests/http-task-api.test.js` and confirm green.

### Task 2: Remote transport validation, retry, receipt

**Files:**
- Create: `src/background/remote-artifact-transport.js`
- Test: `tests/remote-artifact-transport.test.js`
- Modify: `src/shared/errors.js` only if an existing error code is insufficient.

**Interfaces:**
- Consumes: artifact fields `task_id`, `session_id`, `filename`, `patch_key`, `content_base64`, optional `content_type` and `size_bytes`; `taskApi.uploadArtifactContent()`.
- Produces: privacy-safe remote receipt `{ artifact_id, filename, size_bytes, sha256?, remote_url? }`.

- [x] Add failing tests for valid upload, missing/invalid base64, size mismatch, transient retry, non-transient no-retry, and receipt validation.
- [x] Run the new test file and confirm failures are feature-related.
- [x] Implement strict validation, default 32 MiB maximum, bounded retry/backoff, and receipt validation.
- [x] Run the new test file and confirm green.

### Task 3: Transfer manager content stripping and runtime wiring

**Files:**
- Modify: `src/background/artifact-transfer-manager.js`
- Modify: `src/background/service-worker.js`
- Test: `tests/artifact-transfer-manager.test.js`
- Test: `tests/service-worker-wiring.test.js`

**Interfaces:**
- Consumes: `RemoteArtifactTransport`.
- Produces: remote transfer result whose `artifact` metadata never contains `content_base64/content_bytes`, while `receipt` records remote storage identity.

- [x] Add failing tests proving remote transfer strips file content and remote mode without bytes fails closed.
- [x] Add a wiring test proving real runner constructs/injects `RemoteArtifactTransport` only for remote mode.
- [x] Implement the minimum manager/service-worker wiring.
- [x] Run targeted tests and confirm green.

### Task 4: Documentation, TODO, version and verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `TASK_PROTOCOL.md`
- Modify: `PATCH_DOWNLOAD.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

**Interfaces:**
- Produces version `0.15.0`; marks remote upload protocol/retry/idempotency complete while Native Helper/local file reading remains open.

- [x] Document the upload endpoint/payload/receipt and privacy boundary.
- [ ] Mark M11 remote protocol/upload/retry complete, leaving Native Helper/file-read integration open.
- [x] Update package/lock/manifest to `0.15.0`.
- [x] Run full `npm test`, all JS syntax checks, JSON parsing, and `git diff --check`.
- [x] Generate Patch 012 with required metadata and verify `.patch-session.json` is absent.
- [x] Rebuild a fresh source + 001–011 parent, `git apply --check` 012, apply 012, and rerun full verification.
