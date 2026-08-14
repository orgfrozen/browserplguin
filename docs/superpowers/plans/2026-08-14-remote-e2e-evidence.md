# Remote E2E Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Record privacy-safe local proof when a real Remote E2E test-mode Task witnesses remote upload, artifact report, cleanup, and successful COMPLETE terminal in one uninterrupted run.

**Architecture:** Add an optional best-effort TaskRunner lifecycle observer, an in-memory remote E2E run tracker, and a bounded local evidence ledger. Service Worker injects/finalizes the tracker only for real remote test mode and Popup renders/clears the sanitized summary. Evidence never affects Task success and never enables production remote mode.

**Tech Stack:** Chrome MV3, JavaScript ES modules, `chrome.storage.local`, Node built-in test runner.

## Global Constraints

- Unique source baseline remains `browserplguin--ps-20260813-164230-616f0d--source.zip` plus patches 001 through 021.
- Patch 022 metadata must use `SEQUENCE=22` and `PARENT_SEQUENCE=21`.
- Do not commit, push, or modify `.patch-session.json`.
- Do not enable the regular remote Options item.
- Do not mark the real Remote E2E TODO complete because this environment cannot execute the live chain.
- Evidence must not store identifiers, URLs, tokens, local paths, filenames, Patch bytes, receipts, raw payloads, or free-form error text.
- Evidence recording failures must never change Task execution outcome.

---

### Task 1: Remote E2E tracker and ledger

**Files:**
- Create: `src/background/remote-e2e-evidence.js`
- Create: `tests/remote-e2e-evidence.test.js`

**Interfaces:**
- Produces: `RemoteE2eEvidenceLedger`, `RemoteE2eRunTracker`.
- `RemoteE2eRunTracker` methods: `onRemoteTransfer()`, `onArtifactReported()`, `onCleanupCompleted()`, `onTerminalSucceeded({ action, status })`, `finish({ runnerStatus, recovered })`.

- [x] Write failing tests for pass classification, missing-stage classification, recovery fail-closed behavior, sanitization, bounded history, and clear.
- [x] Run `node --test tests/remote-e2e-evidence.test.js` and confirm RED because the module does not exist.
- [x] Implement the minimum fixed-enum tracker/ledger.
- [x] Re-run the focused test and confirm GREEN.

### Task 2: TaskRunner observer hooks

**Files:**
- Modify: `src/background/task-runner.js`
- Modify: `tests/task-runner.test.js`

**Interfaces:**
- Consumes optional constructor argument `observer`.
- Emits only best-effort lifecycle callbacks; observer errors are swallowed.

- [x] Add failing tests proving remote transfer, artifact report, cleanup and terminal callbacks fire only after each stage succeeds, and observer failures do not fail the Task.
- [x] Run focused TaskRunner tests and confirm RED.
- [x] Implement a private best-effort observer helper and the four lifecycle notifications.
- [x] Re-run focused tests and confirm GREEN.

### Task 3: Service Worker real-run evidence wiring

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `tests/service-worker-wiring.test.js`
- Create: `tests/remote-e2e-service-worker.test.js`

**Interfaces:**
- Real remote test-mode runner receives a fresh tracker.
- `executeRunner()` finalizes and records one evidence run after result/throw.
- Adds message commands `GET_REMOTE_E2E_EVIDENCE` and `CLEAR_REMOTE_E2E_EVIDENCE`.

- [x] Add failing tests for test-mode-only wiring, success/failure recording, storage failure isolation, and message handlers.
- [x] Run focused tests and confirm RED.
- [x] Wire the tracker/ledger without touching mock/local behavior.
- [x] Re-run focused tests and confirm GREEN.

### Task 4: Popup evidence summary

**Files:**
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `tests/ui-smoke.test.js`

**Interfaces:**
- Popup reads `GET_REMOTE_E2E_EVIDENCE` on refresh.
- Popup clears only this ledger through `CLEAR_REMOTE_E2E_EVIDENCE`.

- [x] Add failing UI smoke assertions for total/passed/latest/failure-stage display and clear control.
- [x] Run focused UI tests and confirm RED.
- [x] Implement the compact evidence section.
- [x] Re-run focused UI tests and confirm GREEN.

### Task 5: Version and documentation sync

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`

- [x] Bump version to `0.25.0`.
- [x] Document Remote E2E evidence semantics and privacy boundary.
- [x] Add a completed tooling item for the evidence recorder while leaving the real Remote E2E TODO unchecked.

### Task 6: Verification and Patch generation

- [x] Search for project-defined `VERIFY_COMMAND`; if none exists, record that fact.
- [x] Run `npm test` and require zero failures.
- [x] Run `node --check` for every JS/MJS file in `src`, `tests`, and `native-host`.
- [x] Parse project JSON files and verify all version surfaces are `0.25.0`.
- [x] Verify evidence output contains only fixed safe fields and regular remote remains disabled.
- [x] Verify `.patch-session.json` SHA-256 remains `8c6618b4d39008748e946a8c05666ecfd041854af1314b5489881e905e2aa975`.
- [x] Build exact parent state from source + 001..021 and run `git diff --check`.
- [x] Generate Patch 022 with exact metadata, no forbidden paths/secrets/session file.
- [x] Rebuild from source + 001..021, run `git apply --check` and apply final 022, then repeat the full verification suite.
