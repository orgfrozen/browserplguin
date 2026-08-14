# Remote E2E Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a no-side-effect remote E2E prerequisite checker and expose it in Options while keeping remote mode disabled.

**Architecture:** A focused background module evaluates settings, optional origin permission, manifest permissions, and a live Native Helper readiness result. Service Worker exposes check/get commands. Options renders only the privacy-safe summary and blocker codes.

**Tech Stack:** Chrome Extension MV3, JavaScript ES modules, node:test.

## Global Constraints

- Preserve `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Do not claim Tasks, read files, or upload artifacts during preflight.
- Do not persist Task API URL/token, Extension ID, local path, or native error text in preflight state.
- Keep Options `remote` disabled until a real remote E2E is completed.
- Do not modify `.patch-session.json`.
- Do not commit or push.

---

### Task 1: Preflight evaluator

**Files:**
- Create: `src/background/remote-e2e-preflight.js`
- Test: `tests/remote-e2e-preflight.test.js`

**Interfaces:**
- Consumes settings, Chrome permissions adapter, manifest, NativePatchFileReader, storage.
- Produces `runRemoteE2ePreflight()` and `getRemoteE2ePreflight()`.

- [x] Write failing tests for ready state, invalid URL, missing origin permission, missing nativeMessaging, helper unavailable, insufficient capabilities, and privacy-safe persistence.
- [x] Run tests and confirm they fail because the module does not exist.
- [x] Implement the minimal evaluator.
- [x] Run focused tests and confirm pass.

### Task 2: Service Worker and Options wiring

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/ui/options.html`
- Modify: `src/ui/options.js`
- Test: `tests/service-worker-wiring.test.js`
- Test: `tests/ui-files.test.js`

**Interfaces:**
- Produces `CHECK_REMOTE_E2E_PREFLIGHT` and `GET_REMOTE_E2E_PREFLIGHT` runtime commands.

- [x] Write failing wiring/UI tests.
- [x] Run focused tests and confirm expected failure.
- [x] Wire the runtime commands and render readiness/blockers in Options.
- [x] Keep the `remote` option disabled.
- [x] Run focused tests and confirm pass.

### Task 3: Version/docs/verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PATCH_DOWNLOAD.md`
- Modify: `TODO.md`

- [x] Bump version to `0.19.0`.
- [x] Document the no-side-effect preflight and remaining real remote E2E gate.
- [x] Run full tests, JS syntax, JSON parsing, and `git diff --check`.
- [x] Generate Patch 016 and replay source + 001–015 + 016 from scratch.
