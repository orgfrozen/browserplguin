# Selector Calibration Delta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a privacy-safe structural delta report for live selector calibration and embed it in the existing validation handoff.

**Architecture:** A new pure shared module owns fixed v1 contracts and compares sanitized fingerprints to them. `validation-handoff.js` calls the pure module after its existing calibration projection. No storage, background command, DOM mutation, or selector mutation is added.

**Tech Stack:** JavaScript ES modules, Node test runner, existing calibration fingerprint sanitizer.

## Global Constraints

- Preserve Patch Sync session and sequence rules; do not commit or push.
- Do not modify `.patch-session.json`.
- Do not auto-generate or mutate selectors.
- Do not add new storage keys or ChatGPT page actions.
- Do not mark live environment TODOs complete.
- Delta output must contain only fixed enums, bounded counts, and already-sanitized fingerprints.

---

### Task 1: Pure selector delta contracts

**Files:**
- Create: `src/shared/selector-calibration-delta.js`
- Create: `tests/selector-calibration-delta.test.js`

**Interfaces:**
- Consumes: `sanitizeCalibrationFingerprints(values)`.
- Produces: `buildSelectorCalibrationDelta(calibration)` and fixed v1 contract metadata.

- [x] Write failing tests for compatible, mismatched, ambiguous, missing, and hostile fingerprints.
- [x] Run targeted tests and confirm RED because the module is absent.
- [x] Implement fixed contracts and delta enum projection.
- [x] Run targeted tests and confirm GREEN.

### Task 2: Validation handoff integration

**Files:**
- Modify: `src/shared/validation-handoff.js`
- Modify: `tests/validation-handoff.test.js`

**Interfaces:**
- Consumes: safe calibration projection already built by `buildValidationHandoffBundle()`.
- Produces: `selector_calibration_delta` in the existing handoff bundle.

- [x] Add failing tests requiring delta output and hostile-input re-sanitization.
- [x] Run targeted tests and confirm RED.
- [x] Embed pure delta output without changing `next_action` or release-readiness semantics.
- [x] Run targeted tests and confirm GREEN.

### Task 3: Version and documentation sync

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `src/manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-browser-extension-full-automation-design.md`

- [x] Bump version to 0.33.0.
- [x] Document Selector Calibration Delta as completed tooling while leaving all eight live TODOs open.
- [x] Run full tests, JS/MJS syntax checks, JSON parsing, privacy scans, TODO count, and session hash verification.

### Task 4: Patch Sync packaging

- [x] Build exact parent from source + 001..029 and generate candidate sequence 030 / parent 029.
- [x] Replay candidate from source + 001..029 and run the full verification suite.
- [x] Mark plan complete, regenerate formal Patch 030, and replay/verify the formal patch from scratch.
