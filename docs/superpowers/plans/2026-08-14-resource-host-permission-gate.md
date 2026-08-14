# Resource Host Permission Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing each behavior. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate every Task resource download on explicit per-origin Chrome host permission and provide user-driven check/grant/revoke controls in Options.

**Architecture:** Add a focused `ResourceHostPermissionManager` used by `ResourceLoader` before `fetch`. Keep permission prompts in the Options page button handler because runtime host permission requests require a user gesture. Background execution only checks existing access and fails closed.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node test runner.

## Global Constraints

- Source baseline is the session source ZIP plus Patch 001–018 only.
- Do not commit or push.
- Do not change unrelated ChatGPT selector logic.
- Do not mark real resource upload E2E complete without a real Chrome run.
- Keep `.patch-session.json` unchanged and out of the diff.

---

### Task 1: Permission normalization and fail-closed checker

**Files:**
- Create: `src/background/resource-host-permission.js`
- Modify: `src/shared/errors.js`
- Test: `tests/resource-host-permission.test.js`

**Interfaces:**
- Produces `resourceOriginPattern(url)` returning an exact `http(s)://host/*` pattern.
- Produces `ResourceHostPermissionManager.assertGranted(url)`.

- [x] Write failing tests for exact-origin normalization, credential rejection, missing permissions, permission API errors, and successful grants.
- [x] Run the focused test and verify RED.
- [x] Implement the minimal manager and new `RESOURCE_HOST_PERMISSION_REQUIRED` error code.
- [x] Run the focused test and verify GREEN.

### Task 2: Enforce permission before resource fetch

**Files:**
- Modify: `src/background/resource-loader.js`
- Modify: `src/background/service-worker.js`
- Modify: `tests/resource-loader.test.js`
- Modify: `tests/service-worker-wiring.test.js`

**Interfaces:**
- `new ResourceLoader({ permissions, fetchImpl, maxBytes })` creates/uses the permission manager.
- `load(resource)` calls `assertGranted(resource.url)` before `fetchImpl`.

- [x] Add failing tests proving denied permission prevents fetch and allowed permission preserves existing resource behavior.
- [x] Run focused tests and verify RED.
- [x] Wire the manager into `ResourceLoader` and inject `chrome.permissions` in the real runner.
- [x] Run focused tests and verify GREEN.

### Task 3: Options user-gesture permission controls

**Files:**
- Modify: `src/ui/options.html`
- Modify: `src/ui/options.js`
- Modify: `tests/ui-files.test.js`

**Interfaces:**
- User enters a resource URL.
- Check/grant/revoke buttons operate on the normalized exact-origin pattern only.

- [x] Add failing UI-structure tests for input/status/buttons and `contains/request/remove` wiring.
- [x] Run focused test and verify RED.
- [x] Implement the minimal Options controls with no wildcard request and no persistence of full URLs.
- [x] Run focused test and verify GREEN.

### Task 4: Documentation, versioning, and verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `TASK_PROTOCOL.md`
- Modify: `TODO.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

- [x] Update docs to describe explicit Resource Host Access and keep real file-input/upload calibration pending.
- [x] Mark only the host-access implementation sub-item complete; keep actual resource E2E/live DOM calibration pending.
- [x] Bump package/lock/manifest to `0.22.0`.
- [x] Run full tests, JS/MJS syntax checks, JSON parse checks, `git diff --check`, session hash check, and privacy scans.
- [x] Generate Patch 019 with `SEQUENCE=19` / `PARENT_SEQUENCE=18` from the exact parent state.
- [x] Fresh-replay source → 001…018 → 019 and rerun the complete verification suite.
