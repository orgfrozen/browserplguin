# Calibration Coverage Gate and Safe Handoff Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing each task. Do not commit/push in this Patch Sync session.

**Goal:** Add a privacy-safe coverage gate for the six remaining ChatGPT selector-calibration TODOs and a downloadable sanitized JSON handoff report.

**Architecture:** Add a pure shared projection that converts the existing sanitized Calibration Evidence Ledger summary into a fixed six-surface coverage report. Background exposes the projection through one runtime command. Popup renders the report and downloads the same sanitized object as JSON without requesting new permissions.

**Tech Stack:** Manifest V3 JavaScript modules, Node `node:test`, Chrome runtime messaging, Popup DOM/Blob APIs.

## Global Constraints

- Source baseline remains the uploaded source ZIP plus Patch 001–020 in order.
- Patch sequence is 021 with parent 020.
- Do not modify `.patch-session.json`.
- Do not commit or push.
- Do not auto-complete live calibration TODOs.
- Report must contain no DOM/free text/URL/Prompt/Project/file/token/path data.

---

### Task 1: Coverage projection

**Files:**
- Create: `src/shared/calibration-coverage.js`
- Create: `tests/calibration-coverage.test.js`

**Interfaces:**
- Produces: `buildCalibrationCoverage(summary, { now? })`
- Produces: `CALIBRATION_REVIEW_SURFACES`

- [x] Write failing tests for missing pass, unavailable-only, historical pass + unavailable, latest incompatible, all-covered ready state, and privacy filtering.
- [x] Run targeted tests and confirm RED because module is missing.
- [x] Implement the minimal fixed-surface projection with fail-closed normalization.
- [x] Run targeted tests and confirm GREEN.

### Task 2: Background command

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `tests/live-calibration-service-worker.test.js`

**Interfaces:**
- Consumes: `CalibrationEvidenceLedger.getSummary()`
- Produces runtime command: `GET_CALIBRATION_COVERAGE`

- [x] Add failing wiring assertions for the import and runtime command.
- [x] Run targeted test and confirm RED.
- [x] Add the pure coverage projection call to the Service Worker command switch.
- [x] Run targeted test and confirm GREEN.

### Task 3: Popup coverage and safe report download

**Files:**
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `tests/ui-files.test.js`

**Interfaces:**
- Consumes runtime command `GET_CALIBRATION_COVERAGE`
- Produces fixed coverage rows and local JSON Blob download

- [x] Add failing static UI tests for coverage summary/rows/button and Blob JSON export.
- [x] Run targeted test and confirm RED.
- [x] Implement coverage rendering, refresh, and sanitized report download.
- [x] Run targeted test and confirm GREEN.

### Task 4: Docs/version and verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

- [x] Update version to `0.24.0` and document the coverage gate/report without marking real calibration/E2E TODOs complete.
- [x] Run `npm test` and require zero failures.
- [x] Run `node --check` for every JS/MJS file and parse project JSON files.
- [x] Confirm no project `VERIFY_COMMAND` exists or run it if present.
- [x] Confirm `.patch-session.json` hash is unchanged and excluded from diff.
- [x] Generate Patch 021 from exact parent source + 001–020.
- [x] Fresh replay source → 001…020 → 021 and rerun the full verification suite.
