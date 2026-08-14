# Validation Handoff Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Export one privacy-safe validation handoff bundle with a deterministic next action from the extension's existing real-environment evidence.

**Architecture:** Add a pure shared whitelist projector, compose it from fresh background summaries, then expose one Popup download button. Do not change task execution, evidence collection, promotion, recovery, or TODO completion semantics.

**Tech Stack:** Chrome MV3 JavaScript modules, `chrome.storage.local`, existing background/service-worker message routing, Node test runner.

## Global Constraints

- Patch Sync sequence is 026 with parent 025; no commit/push.
- `.patch-session.json` must remain byte-identical and absent from the diff.
- The handoff is read-only and local-download only.
- Unknown/free-text input must never be copied into the bundle.
- All nine real-environment/optional TODO items remain unchecked.

---

### Task 1: Pure handoff projector

**Files:**
- Create: `src/shared/validation-handoff.js`
- Create: `tests/validation-handoff.test.js`

**Interfaces:**
- Produces: `VALIDATION_NEXT_ACTIONS` and `buildValidationHandoffBundle(inputs, options)`.

- [x] Write failing tests for action precedence, release-ready output, and hostile-field/blocker filtering.
- [x] Run the focused test and confirm RED because the module does not exist.
- [x] Implement the minimum whitelist projector and deterministic action selection.
- [x] Run the focused test and confirm GREEN.

### Task 2: Fresh background aggregation

**Files:**
- Modify: `src/background/service-worker.js`
- Modify/Create tests covering the service-worker message contract.

**Interfaces:**
- Produces: `GET_VALIDATION_HANDOFF_BUNDLE` response built from fresh calibration/resource/remote/production/live-preflight/readiness inputs.

- [x] Write failing service-worker wiring tests requiring fresh live preflight and the new message case.
- [x] Run the focused tests and confirm RED.
- [x] Add minimal aggregation/wiring without changing runtime execution paths.
- [x] Run the focused tests and confirm GREEN.

### Task 3: Popup safe download

**Files:**
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify/Create UI smoke tests.

- [x] Write failing UI tests for the handoff button and message/download wiring.
- [x] Run focused tests and confirm RED.
- [x] Add one local JSON download action beside Production Readiness.
- [x] Run focused tests and confirm GREEN.

### Task 4: Version, roadmap, and final verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `manifest.json`
- Modify: `README.md`, `ARCHITECTURE.md`, `CHATGPT_AUTOMATION.md`, `TODO.md`, master design spec

- [x] Bump version to `0.29.0` and document Validation Handoff Bundle as completed tooling while keeping the nine real-environment/optional TODOs open.
- [x] Run full `npm test`, JS/MJS syntax checks, JSON parsing, privacy/forbidden-path checks, and verify `.patch-session.json` hash.
- [x] Generate Patch 026 against exact `source + 001..025` parent state.
- [x] Replay final Patch 026 from scratch and repeat full verification.
