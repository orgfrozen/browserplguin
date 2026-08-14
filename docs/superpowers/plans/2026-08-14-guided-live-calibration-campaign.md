# Guided Live Calibration Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic read-only campaign that guides the user through the six remaining live ChatGPT selector calibrations using the existing calibration evidence ledger.

**Architecture:** A new pure shared module derives campaign stages from sanitized ledger summary data. Service Worker exposes the derived state without creating new storage. Popup displays the current target/progress and captures the current DOM only through the existing read-only live calibration command.

**Tech Stack:** Chrome Extension Manifest V3, ES modules, Node `node:test`, existing calibration evidence/coverage pipeline.

## Global Constraints

- Unique baseline is `browserplguin--ps-20260813-164230-616f0d--source.zip` plus Patch 001–028.
- Do not commit, push, clone, or mutate `.patch-session.json`.
- No automatic ChatGPT page mutations.
- No new persistent campaign state.
- No free-form DOM/chat/Project/URL/file/Prompt data in campaign output.
- Keep the eight real-environment TODO items open.
- Target version is `0.32.0`.

---

### Task 1: Pure campaign derivation

**Files:**
- Create: `src/shared/calibration-campaign.js`
- Create: `tests/calibration-campaign.test.js`

**Interfaces:**
- Produces: `CALIBRATION_CAMPAIGN_STAGES` and `buildCalibrationCampaign(summary, options?)`.

- [x] Write tests proving fixed stage order, status derivation, current-target blocking, completion, and hostile-input privacy projection.
- [x] Run `node --test tests/calibration-campaign.test.js` and confirm RED because the module does not exist.
- [x] Implement the minimal pure builder using fixed ids/instruction enums/page-category allowlists and safe numeric/status projections.
- [x] Re-run the focused test and confirm GREEN.

### Task 2: Service Worker read-only campaign API

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `tests/live-calibration-service-worker.test.js`

**Interfaces:**
- Consumes: `CalibrationEvidenceLedger.getSummary()`.
- Produces: message `GET_CALIBRATION_CAMPAIGN` returning `buildCalibrationCampaign(...)`.

- [x] Add RED structural/integration assertions for import and message wiring.
- [x] Run focused Service Worker test and confirm expected RED.
- [x] Add only the pure read-only wiring; no new storage or browser actions.
- [x] Re-run focused test and confirm GREEN.

### Task 3: Popup guided campaign UI

**Files:**
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `tests/ui-files.test.js`

**Interfaces:**
- Consumes: `GET_CALIBRATION_CAMPAIGN` and existing `RUN_CHATGPT_CALIBRATION`.
- Produces: current target, progress, six stage statuses, and `captureCampaignState` user action.

- [x] Add RED UI assertions for campaign region, six fixed stage rows, target/progress fields, and capture button wiring.
- [x] Run the UI focused test and confirm expected RED.
- [x] Render fixed local instruction copy from `instruction_code`; never render arbitrary server/storage strings as instructions.
- [x] Make Capture call the existing calibration command and refresh evidence, coverage, campaign, and release readiness.
- [x] Re-run focused tests and confirm GREEN.

### Task 4: Version and roadmap sync

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `src/manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`

- [x] Bump all version declarations to `0.32.0`.
- [x] Document Guided Live Calibration Campaign as completed tooling.
- [x] Keep all eight real-environment TODO lines unchecked.

### Task 5: Full verification and Patch 029

- [x] Search for a project-defined executable `VERIFY_COMMAND`; if none exists, record that fact honestly.
- [x] Run `npm test` and require zero failures.
- [x] Run `node --check` across every JS/MJS source/test/native-host file.
- [x] Parse project JSON files and verify version consistency.
- [x] Verify campaign output has no arbitrary text/URL/file/Prompt/token fields and the capture path reuses read-only calibration only.
- [x] Verify `.patch-session.json` SHA-256 remains unchanged and it is absent from Git diff headers.
- [x] Build exact parent state from source + Patch 001–028, run `git diff --check`, and generate Patch 029 with required metadata.
- [x] Replay source + Patch 001–028 + candidate Patch 029 in a fresh directory and rerun full verification.
- [x] Mark the final plan items complete, regenerate formal Patch 029, and rerun the formal replay once more.
