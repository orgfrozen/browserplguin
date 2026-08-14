# Calibration Evidence Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and render privacy-safe local evidence for every Live Calibration Matrix run without changing ChatGPT automation behavior.

**Architecture:** Add a bounded `CalibrationEvidenceLedger` over the existing storage adapter. `runLiveCalibration()` records only a sanitized projection after the read-only matrix succeeds. Service Worker exposes read/clear commands, and Popup renders compact coverage counts.

**Tech Stack:** Manifest V3 JavaScript, `chrome.storage.local`, Node built-in test runner.

## Global Constraints

- Unique baseline is `browserplguin--ps-20260813-164230-616f0d--source.zip` plus Patches 001–019.
- Patch metadata must be `SEQUENCE=20`, `PARENT_SEQUENCE=19`.
- Do not commit or push.
- Do not store matrix `evidence` fields or arbitrary page/user text.
- Do not mark any real ChatGPT calibration TODO complete.
- Do not upload evidence remotely.

---

### Task 1: Privacy-safe evidence ledger

**Files:**
- Create: `src/background/calibration-evidence-ledger.js`
- Create: `tests/calibration-evidence-ledger.test.js`

**Interfaces:**
- Produces: `CalibrationEvidenceLedger({ storage, now, maxRecentRuns })`
- Produces: `record(matrix)`, `getSummary()`, `clear()`

- [x] Write failing tests for safe projection, aggregate counts, bounded history, and clearing.
- [x] Run the tests and confirm RED because the ledger does not exist.
- [x] Implement the minimal bounded ledger with serialized writes.
- [x] Run the focused tests and confirm GREEN.

### Task 2: Record evidence after live calibration

**Files:**
- Modify: `src/background/live-calibration.js`
- Modify: `src/background/service-worker.js`
- Modify: `tests/live-calibration-integration.test.js`
- Modify: `tests/live-calibration-service-worker.test.js`

**Interfaces:**
- `runLiveCalibration(tabManager, evidenceLedger)` records after matrix success.
- Runtime messages: `GET_CALIBRATION_EVIDENCE`, `CLEAR_CALIBRATION_EVIDENCE`.

- [x] Write failing integration/wiring tests.
- [x] Run focused tests and confirm RED.
- [x] Wire recording/read/clear without changing matrix output.
- [x] Run focused tests and confirm GREEN.

### Task 3: Popup coverage view

**Files:**
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `tests/ui-files.test.js`

**Interfaces:**
- Popup renders total runs and fixed surface latest/pass counts.
- Popup explicitly clears local evidence via `CLEAR_CALIBRATION_EVIDENCE`.

- [x] Write failing UI structure tests.
- [x] Run focused tests and confirm RED.
- [x] Add compact evidence grid and clear action.
- [x] Run focused tests and confirm GREEN.

### Task 4: Version, docs, and verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`

- [x] Bump package/lock/manifest to `0.23.0`.
- [x] Document local evidence ledger and privacy boundary.
- [x] Add a completed tooling TODO without changing live-calibration TODO checkboxes.
- [x] Run full tests, JS/MJS syntax checks, JSON parsing, diff checks, secret/path scans, and session-hash check.
- [x] Generate Patch 020 against exact parent state 001–019.
- [x] Reapply source → 001…019 → 020 in a clean directory and rerun all verification.
