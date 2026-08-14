# Diagnostic Screenshot Safety Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an executable screenshot privacy policy while keeping screenshot collection impossible in v0.30.0.

**Architecture:** A pure shared policy module owns the allowlists and fail-closed request evaluation. Service Worker exposes only the fixed policy snapshot; Options renders the policy status. No capture API is introduced.

**Tech Stack:** Chrome Extension MV3, JavaScript ES modules in shared/background, existing node:test suite.

## Global Constraints

- Keep screenshot capture disabled (`capture_enabled=false`).
- Do not add `captureVisibleTab`, canvas/image encoding, OCR, screenshot persistence, screenshot export, or upload.
- Do not persist consent in this patch.
- Do not expose free text or arbitrary caller input in policy/evaluation results.
- Do not modify `.patch-session.json`.
- Do not commit or push.

---

### Task 1: Pure Screenshot Safety Policy

**Files:**
- Create: `src/shared/diagnostic-screenshot-policy.js`
- Create: `tests/diagnostic-screenshot-policy.test.js`

**Interfaces:**
- Produces: `buildDiagnosticScreenshotPolicy()` and `evaluateDiagnosticScreenshotRequest(input)`.

- [x] Write failing tests for fixed v1 policy, allowed semantic regions, and forbidden full-page/OCR/text/upload behavior.
- [x] Run the focused test and verify RED because the module does not exist.
- [x] Implement the minimal fixed policy and fail-closed evaluator.
- [x] Verify evaluator never echoes arbitrary input and `capture_allowed` remains false.
- [x] Run focused tests and verify GREEN.

### Task 2: Background and Options Visibility

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/ui/options.html`
- Modify: `src/ui/options.js`
- Modify: `tests/service-worker-wiring.test.js`
- Modify: `tests/ui-files.test.js`

**Interfaces:**
- Produces: runtime message `GET_DIAGNOSTIC_SCREENSHOT_POLICY`.

- [x] Write failing wiring/UI tests for the read-only policy endpoint and Options status.
- [x] Verify RED before production edits.
- [x] Wire the pure policy snapshot through Service Worker and render it in Options.
- [x] Verify no screenshot/capture API appears in runtime source.
- [ ] Run focused tests and verify GREEN.

### Task 3: Version, Documentation, and Patch Verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `manifest.json`
- Modify: `README.md`, `ARCHITECTURE.md`, `CHATGPT_AUTOMATION.md`, `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`

- [x] Set version to `0.30.0`.
- [x] Mark the prior "must first design opt-in + redaction" screenshot-strategy TODO complete while explicitly keeping screenshot capture disabled/not implemented.
- [x] Run full tests, JS/MJS syntax checks, JSON parsing, privacy/capture-API scans, and `.patch-session.json` hash verification.
- [x] Generate Patch 027 against exact parent `source + 001…026`.
- [x] Replay the final Patch from scratch and repeat full verification.
