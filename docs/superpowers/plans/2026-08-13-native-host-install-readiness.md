# Native Host Install and Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic macOS/Linux user-level installer for the existing Patch Native Messaging host and a privacy-safe Helper readiness check, while keeping remote Patch transfer disabled until live E2E is completed.

**Architecture:** The installer copies the Node native-host files into a stable user data directory, generates an executable launcher pinned to the installer’s absolute Node binary and Downloads root, and writes a Chrome Native Messaging host manifest containing the exact extension origin. The existing native host gains a side-effect-free `PING → PONG` protocol; `NativePatchFileReader.checkReady()` validates that response, and the service worker exposes a stored privacy-safe readiness summary to Options without enabling remote mode.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node.js built-ins only, Chrome Native Messaging, Node built-in test runner.

## Global Constraints

- Use the uploaded source ZIP plus Patch 001-013 as the only parent state.
- Do not clone, commit, push, add external dependencies, or modify `.patch-session.json`.
- Preserve local transfer behavior and all existing remote upload/file-read semantics.
- Remote transfer remains disabled in Options and must not be enabled automatically by a successful readiness check.
- Native host manifest `allowed_origins` binds exactly one validated Chrome extension ID; no wildcard is allowed.
- macOS/Linux manifest registration uses user-level browser locations and an absolute executable launcher path.
- The readiness response contains only host/protocol/capability metadata; it must not read a file or expose local paths.

---

### Task 1: Host readiness protocol

**Files:**
- Modify: `native-host/patch-file-reader.mjs`
- Modify: `src/background/native-patch-file-reader.js`
- Modify: `src/shared/errors.js`
- Test: `tests/native-patch-file-reader.test.js`
- Test: `tests/native-patch-host-framing.test.js`

**Interfaces:**
- Native request: `{ type: "PING", request_id }`.
- Native response: `{ type: "PONG", request_id, host_name, protocol_version, capabilities }`.
- Extension API: `NativePatchFileReader.checkReady() -> { status, host_name, protocol_version, capabilities }`.

- [x] **Step 1: Write failing tests** for PING/PONG framing, exact request-id validation, protocol/host/capability validation, host unavailable/disconnect handling, and proof that readiness sends no file path.
- [x] **Step 2: Run focused tests and confirm they fail** because PING/PONG and `checkReady()` do not exist.
- [x] **Step 3: Implement the minimal host and extension readiness protocol** without changing `READ_PATCH_FILE` behavior.
- [x] **Step 4: Run focused tests and confirm they pass**.

### Task 2: macOS/Linux installer and manifest generation

**Files:**
- Create: `native-host/install-service.mjs`
- Create: `native-host/install-native-host.mjs`
- Test: `tests/native-host-install-service.test.js`

**Interfaces:**
- `installNativeHost({ extensionId, browser, downloadsDir, platform, homeDir, nodePath, sourceDir })`.
- CLI: `node native-host/install-native-host.mjs --extension-id <32-char-id> [--browser chrome|chromium|chrome-for-testing] [--downloads-dir /absolute/path]`.

- [x] **Step 1: Write failing tests** for Chrome extension ID validation, exact `allowed_origins`, absolute manifest `path`, stable install copy, executable launcher, Downloads-root export, and macOS/Linux Chrome/Chromium/CfT user manifest locations.
- [x] **Step 2: Run focused tests and confirm they fail** because installer modules do not exist.
- [x] **Step 3: Implement the minimal installer** with Node built-ins only; reject unsupported platforms/browsers and invalid/non-absolute Downloads roots.
- [x] **Step 4: Run focused tests and confirm they pass**.

### Task 3: Service-worker and Options readiness UX

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/ui/options.html`
- Modify: `src/ui/options.js`
- Test: `tests/service-worker-wiring.test.js`
- Test: `tests/ui-files.test.js`

**Interfaces:**
- Runtime message: `CHECK_NATIVE_HELPER` returns/stores privacy-safe readiness status.
- Runtime message: `GET_NATIVE_HELPER_STATUS` returns the last stored readiness summary.

- [x] **Step 1: Write failing tests** proving service-worker readiness commands exist, the stored summary omits native error/path details, Options shows the current extension ID and a Helper check action, and remote remains disabled.
- [x] **Step 2: Run focused tests and confirm they fail** on current service worker/Options.
- [x] **Step 3: Implement the minimal readiness command and Options UI**; readiness success must not alter `patchTransferMode`.
- [x] **Step 4: Run focused tests and confirm they pass**.

### Task 4: Documentation, version, and Patch 014 verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PATCH_DOWNLOAD.md`
- Modify: `TODO.md`
- Modify: `native-host/README.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

- [x] **Step 1: Document install commands, exact Extension ID binding, supported browsers/platforms, readiness flow, and the fact that remote stays disabled until live E2E.**
- [x] **Step 2: Mark M11 host manifest/install/readiness complete while leaving real remote E2E/enablement pending.**
- [x] **Step 3: Set package/lock/manifest version to `0.17.0`.**
- [x] **Step 4: Run `npm test`, JS/MJS syntax checks, JSON parsing, installer sandbox tests, and `git diff --check`.**
- [x] **Step 5: Generate Patch 014 with required Patch Sync metadata and no `.patch-session.json` diff.**
- [x] **Step 6: Rebuild a fresh source + 001-013 parent, apply-check/apply Patch 014, and rerun the full verification.**
