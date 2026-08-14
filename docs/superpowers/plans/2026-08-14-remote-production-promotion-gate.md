# Remote Production Promotion Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate production remote transfer behind recorded real E2E success evidence plus a fresh live preflight, with a pre-claim recheck on every new real Task.

**Architecture:** Add a focused `remote-production-mode.js` policy module. Service Worker reads the existing Remote E2E Evidence Ledger and invokes the policy for explicit promotion and pre-claim validation. Existing E2E test mode remains separate and recovery bypasses the new-claim gate.

**Tech Stack:** Chrome MV3, JavaScript ES modules, `node:test`, `chrome.storage.local`, existing Remote E2E preflight/evidence components.

## Global Constraints

- Patch sequence is 023 with parent 022.
- No git commit, push, or clone.
- `.patch-session.json` must remain byte-identical and absent from the Patch diff.
- No real E2E TODO may be marked complete without real Chrome evidence.
- No remote promotion may occur automatically.

### Task 1: Promotion policy

**Files:**
- Create: `src/background/remote-production-mode.js`
- Create: `tests/remote-production-mode.test.js`

- [x] RED: test evidence requirement, fresh preflight, mutually exclusive flags, demotion, and pre-claim guard.
- [x] GREEN: implement the minimum fixed-field policy functions.
- [x] Verify focused tests.

### Task 2: Service Worker and settings integration

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/background/remote-e2e-test-mode.js`
- Modify: `src/shared/runner-status.js`
- Modify: `tests/service-worker-wiring.test.js`
- Modify: `tests/remote-e2e-test-mode.test.js`
- Modify: `tests/runner-status.test.js`

- [x] RED: require production commands, production pre-claim guard, test/production mutual exclusion, and safe runner status.
- [x] GREEN: wire evidence + live preflight without gating recovery.
- [x] Verify focused tests.

### Task 3: Options/Popup controls

**Files:**
- Modify: `src/ui/options.html`
- Modify: `src/ui/options.js`
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `tests/ui-files.test.js`

- [x] RED: require explicit promote/demote controls and production status.
- [x] GREEN: render only safe fixed fields and dynamically unlock the remote select only when production mode is active.
- [x] Verify focused tests.

### Task 4: Version/docs/full verification/Patch

**Files:**
- Modify version metadata and roadmap docs.

- [x] Upgrade to 0.26.0 and document the promotion gate without marking real E2E complete.
- [x] Run full tests, syntax/JSON checks, diff/session/secret checks.
- [x] Generate Patch 023 from exact `source + 001..022` parent.
- [x] Replay final Patch from scratch and verify again.
