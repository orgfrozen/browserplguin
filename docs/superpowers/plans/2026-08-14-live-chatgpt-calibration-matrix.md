# Live ChatGPT Calibration Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only live ChatGPT UI calibration matrix that identifies which semantic automation surfaces are currently observable, unavailable in the current page state, or structurally incompatible without performing clicks or exposing conversation content.

**Architecture:** A pure content-side collector reads the active selector profile and current DOM and returns only enumerated statuses and counts. A new content-script command exposes the matrix without the normal page-access guard so login/challenge pages can still be diagnosed. Background forwards the result from the current ChatGPT tab, while Popup renders a fixed calibration checklist.

**Tech Stack:** Chrome Extension MV3, ES modules, Node built-in test runner.

## Global Constraints

- Use the uploaded source ZIP plus Patch 001-017 as the only parent state.
- Do not create/delete Projects, send prompts, upload resources, click Patch controls, or mutate ChatGPT UI during calibration.
- Do not return chat text, Project names, Prompt text, attachment names, URL query/hash, API/lease tokens, or raw DOM text.
- Keep the active selector profile behavior unchanged.
- Do not modify `.patch-session.json`.
- Do not commit or push.

---

### Task 1: Read-only calibration collector

**Files:**
- Create: `src/content/calibration-matrix.js`
- Test: `tests/calibration-matrix.test.js`

**Interfaces:**
- Produces: `collectCalibrationMatrix(root, { location, title }) -> { selector_profile, page, summary, checks }`

- [x] Write failing tests for pass/unavailable/incompatible classification and privacy boundaries.
- [x] Run the targeted tests and confirm failures are caused by the missing collector.
- [x] Implement the collector with no DOM mutation/click calls.
- [x] Re-run targeted tests.

### Task 2: Content/background command wiring

**Files:**
- Modify: `src/content/content-script.js`
- Create: `src/background/live-calibration.js`
- Modify: `src/background/service-worker.js`
- Test: `tests/live-calibration-integration.test.js`

**Interfaces:**
- Content command: `CHATGPT_CALIBRATION_MATRIX`
- Runtime command: `RUN_CHATGPT_CALIBRATION`

- [x] Write failing integration tests, including login/challenge availability.
- [x] Add the content command as a diagnostics-safe command exempt from the automation access guard.
- [x] Add background forwarding through the existing ChatGPT tab manager.
- [x] Re-run integration tests.

### Task 3: Popup matrix UI

**Files:**
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `tests/ui-files.test.js`

- [x] Write failing UI structure tests for the calibration action and fixed result rows.
- [x] Add a `Run UI Calibration` button and render fixed rows for the supported checks.
- [x] Ensure raw DOM/calibration payload is not dumped into the status panel.
- [x] Re-run UI tests.

### Task 4: Documentation, version and final verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `TODO.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

- [x] Document the read-only live calibration workflow and privacy boundary.
- [x] Mark the calibration probe/tooling complete without marking any real ChatGPT calibration TODO as complete.
- [x] Bump extension/package version consistently.
- [x] Run full tests, JS syntax, JSON parsing and `git diff --check`.
- [x] Generate Patch 018 with `SEQUENCE=18` / `PARENT_SEQUENCE=17`.
- [x] Re-apply source + 001-017 + 018 in a fresh directory and repeat verification.
