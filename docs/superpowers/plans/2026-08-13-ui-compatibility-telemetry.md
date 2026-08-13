# UI Compatibility Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe local UI compatibility telemetry for real ChatGPT automation failures without storing DOM text or sending telemetry remotely.

**Architecture:** Add a small background `UiCompatibilityTelemetry` aggregator backed by `chrome.storage.local`. `BrowserPageDriver` records only compatibility-relevant content-command failures using already-sanitized diagnostics metadata. `GET_RUNNER_STATUS` exposes a compact summary for Popup display; raw diagnostics/control fingerprints are never persisted.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node `node:test`, `chrome.storage.local` adapter.

## Global Constraints

- Keep the uploaded source ZIP plus Patch 001-010 as the only parent state.
- Do not modify `.patch-session.json`.
- No remote telemetry upload in this Patch.
- Do not persist chat text, Prompt, Project name, file name, URL query/hash, token, selector details, or diagnostics controls.
- Preserve existing Task execution behavior and selector semantics.

---

### Task 1: Privacy-safe telemetry aggregator

**Files:**
- Create: `src/background/ui-compatibility-telemetry.js`
- Create: `tests/ui-compatibility-telemetry.test.js`

**Interfaces:**
- Consumes: storage adapter with `get(key)` / `set(key, value)`.
- Produces: `UiCompatibilityTelemetry.record({ operation, error })` and `getSummary()`.

- [x] Write failing tests for safe aggregation, bucket increment, bounded bucket count, and secret stripping.
- [x] Run focused tests and confirm failure because the module does not exist.
- [x] Implement minimal sanitized aggregation using selector profile id/version, operation, error code, access status, page category, count, and timestamp only.
- [x] Run focused tests and confirm pass.

### Task 2: Record real UI compatibility failures

**Files:**
- Modify: `src/background/browser-page-driver.js`
- Modify: `src/background/service-worker.js`
- Modify: `tests/browser-page-driver.test.js`
- Modify: `tests/service-worker-wiring.test.js`

**Interfaces:**
- Consumes: optional `compatibilityTelemetry` injected into `BrowserPageDriver`.
- Produces: one local telemetry record before rethrowing compatibility-relevant content-command errors.

- [x] Write failing tests proving UI selector/login failures are recorded once and unrelated errors are ignored.
- [x] Run focused tests and confirm failure.
- [x] Inject telemetry in real service-worker wiring and record from the existing `#send()` error path.
- [x] Run focused tests and confirm pass.

### Task 3: Safe status/Popup summary

**Files:**
- Modify: `src/shared/runner-status.js`
- Modify: `src/background/runtime-controller.js`
- Modify: `src/ui/popup.js`
- Modify: `src/ui/popup.html`
- Modify: `tests/runner-status.test.js`
- Modify: `tests/ui-files.test.js`

**Interfaces:**
- Consumes: persisted `uiCompatibilityTelemetry` aggregate.
- Produces: `ui_compatibility` status containing total count and compact last event only.

- [x] Write failing tests for the privacy-safe status projection and structured Popup fields.
- [x] Run focused tests and confirm failure.
- [x] Add summary projection and Popup rendering without raw JSON/DOM data.
- [x] Run focused tests and confirm pass.

### Task 4: Documentation, version, verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

**Interfaces:**
- Produces version `0.14.0` and marks local UI compatibility telemetry complete while keeping screenshots/live calibration/remote telemetry out of scope.

- [x] Update docs/TODO/version.
- [x] Run `npm test`, JS syntax checks, JSON parsing, and `git diff --check`.
- [x] Generate Patch 011 from exact Patch-010 parent state with required Patch Sync metadata.
- [x] Rebuild from source ZIP, apply 001-010, `git apply --check` 011, apply 011, and rerun all verification.
