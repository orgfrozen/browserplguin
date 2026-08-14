# Production Readiness Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a privacy-safe release-review gate that aggregates existing real-environment evidence without creating evidence or changing runtime state.

**Architecture:** Add a pure shared `buildReleaseReadiness()` projection, wire it through a read-only Service Worker command using existing ledgers/settings/live preflight, and render/download it in Popup. Keep all business execution paths unchanged.

**Tech Stack:** MV3 Chrome extension, JavaScript ES modules, Node built-in test runner.

## Global Constraints

- Patch Sync sequence is 025 with parent 024.
- Do not edit `.patch-session.json`.
- Do not commit or push.
- Report must be whitelist-only and must not expose free text, identifiers, URLs, file metadata, prompts, tokens, lease data, or recent raw runs.
- `ready_for_release_review` never means TODO items are automatically complete.

---

### Task 1: Pure release-readiness projection

**Files:**
- Create: `src/shared/release-readiness.js`
- Create: `tests/release-readiness.test.js`

**Interfaces:**
- Consumes: calibration coverage report, Resource/Remote E2E summaries, production status, remote preflight.
- Produces: `buildReleaseReadiness(input, options)` returning the fixed safe report.

- [x] Write failing tests for blockers, all-ready state, and privacy-safe whitelist projection.
- [x] Run focused tests and confirm RED because module is missing.
- [x] Implement the minimal fixed-enum/count projection.
- [x] Re-run focused tests and confirm GREEN.

### Task 2: Read-only Service Worker integration

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `tests/service-worker-wiring.test.js`

**Interfaces:**
- Consumes: existing calibration/resource/remote ledgers, settings, production status, live preflight.
- Produces: `GET_RELEASE_READINESS` message response.

- [x] Add failing wiring assertions for the import, command, fresh live preflight, and safe builder.
- [x] Run focused tests and confirm RED.
- [x] Implement the read-only command without changing Task execution paths.
- [x] Re-run focused tests and confirm GREEN.

### Task 3: Popup readiness summary and safe report download

**Files:**
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `tests/ui-files.test.js`

**Interfaces:**
- Consumes: `GET_RELEASE_READINESS`.
- Produces: fixed status rows and `release-readiness-<timestamp>.json` download.

- [x] Add failing UI-file assertions for summary rows and safe download action.
- [x] Run focused tests and confirm RED.
- [x] Implement minimal render/refresh/download wiring.
- [x] Re-run focused tests and confirm GREEN.

### Task 4: Version/docs and full verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `manifest.json`
- Modify: `README.md`, `ARCHITECTURE.md`, `CHATGPT_AUTOMATION.md`, `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`

- [x] Bump version to 0.28.0.
- [x] Mark only Production Readiness Gate complete; leave all nine real-environment/optional TODO items open.
- [x] Search for an actual project `VERIFY_COMMAND`; if none exists, record that honestly.
- [x] Run full tests, JS/MJS syntax checks, JSON parsing, version checks, privacy scans, TODO checks, and `.patch-session.json` hash check.
- [x] Generate Patch 025 against exact parent `source + 001..024`, verify `git diff --check`, forbidden paths, and credentials.
- [x] Replay final Patch 025 from scratch and repeat full verification.
