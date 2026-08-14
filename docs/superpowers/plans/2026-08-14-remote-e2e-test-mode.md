# Remote E2E Test Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, preflight-gated remote E2E test mode and revalidate it before every new real Task claim.

**Architecture:** A focused background module owns test-mode enable/disable and the pre-claim remote guard. RuntimeController accepts an optional `prepareRealRun` hook executed under the runner lock before TaskRunner construction. Service Worker wires the existing Remote E2E Preflight into both the explicit enable command and pre-claim guard. Ordinary settings saves always fall back to local.

**Tech Stack:** Chrome Extension MV3, JavaScript ES modules, node:test.

## Global Constraints

- Preserve `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Remote remains an E2E test capability, not a generally enabled production option.
- Enabling or preflighting must not claim Tasks, read Patch files, or upload artifacts.
- Every new remote `RUN_REAL_ONCE` reruns live preflight before claim.
- Normal settings saves clear test mode and force local transfer.
- Do not expose Task API token/URL, Extension ID, local path, Native error text, Patch bytes, or Task content in test-mode results.
- Do not modify `.patch-session.json`.
- Do not commit or push.

---

### Task 1: Test-mode state and safety contract

**Files:**
- Create: `src/background/remote-e2e-test-mode.js`
- Create: `tests/remote-e2e-test-mode.test.js`

**Interfaces:**
- Produces `enableRemoteE2eTestMode()`, `disableRemoteE2eTestMode()`, `assertRemoteE2eTestModeReady()`, and `buildSafeSettingsUpdate()`.

- [x] Write failing tests for enable-ready, enable-blocked, disable-to-local, direct settings-save bypass prevention, and pre-claim stale-preflight rejection.
- [x] Run focused tests and confirm failures are caused by missing feature code.
- [x] Implement the minimal test-mode state helpers and stable errors.
- [x] Run focused tests and confirm pass.

### Task 2: Pre-claim RuntimeController guard

**Files:**
- Modify: `src/background/runtime-controller.js`
- Modify: `tests/runtime-controller.test.js`

**Interfaces:**
- RuntimeController consumes optional `prepareRealRun(settings)` and calls it under the runner lock before `createRealRunner()`.

- [x] Write a failing test proving the guard runs before runner creation/Task claim path.
- [x] Write a failing test proving a blocked guard never creates a real runner.
- [x] Implement the minimal hook while leaving recovery unchanged.
- [x] Run focused tests and confirm pass.

### Task 3: Service Worker and Options wiring

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/shared/runner-status.js`
- Modify: `src/ui/options.html`
- Modify: `src/ui/options.js`
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `tests/service-worker-wiring.test.js`
- Modify: `tests/runner-status.test.js`
- Modify: `tests/ui-files.test.js`

**Interfaces:**
- Adds `ENABLE_REMOTE_E2E_TEST_MODE` / `DISABLE_REMOTE_E2E_TEST_MODE` runtime commands.
- Normal `SAVE_SETTINGS` calls `buildSafeSettingsUpdate()` and therefore exits test mode.
- Runner status exposes only `patch_transfer_mode` and `remote_e2e_test_mode`.

- [x] Write failing wiring/status/UI tests.
- [x] Wire commands, guarded settings save, and pre-claim live preflight.
- [x] Keep the regular remote select option disabled.
- [x] Render explicit test-mode controls/status in Options and safe state in Popup.
- [x] Run focused tests and confirm pass.

### Task 4: Version/docs/final verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PATCH_DOWNLOAD.md`
- Modify: `TODO.md`

- [x] Bump version to `0.20.0`.
- [x] Document test-mode gating and keep real remote E2E TODO incomplete.
- [x] Run full tests, JS/MJS syntax, JSON parsing, privacy/remote-option checks, and `git diff --check`.
- [x] Generate Patch 017 and replay source + 001–016 + 017 from scratch.
