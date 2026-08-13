# Service Worker Automatic Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Automatically trigger the existing safe real-task recovery policy whenever the MV3 service worker starts and finds a durable active execution.

**Architecture:** Keep recovery policy inside `RuntimeController`; the service worker only coordinates bootstrap ordering. Automatic recovery is allowed only when `activeExecution` exists and saved settings are in `real` mode. Bootstrap completes before runtime messages execute so manual Run/Recover commands cannot race startup recovery.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node.js built-in test runner.

## Global Constraints

- Keep `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Reuse the existing `recoverReal()` policy; do not add prompt replay or in-flight round recovery in this Patch.
- No git clone, commit, or push.
- `.patch-session.json` must remain unchanged and excluded from the diff.

---

### Task 1: Runtime automatic-recovery decision

**Files:**
- Modify: `src/background/runtime-controller.js`
- Test: `tests/runtime-controller.test.js`

**Interfaces:**
- Produces: `RuntimeController.recoverRealIfNeeded()`.

- [x] Add failing tests for no active execution, mock mode, and real mode with active execution.
- [x] Run targeted tests and confirm RED.
- [x] Implement `recoverRealIfNeeded()` using the existing `recoverReal()` method.
- [x] Run targeted tests and confirm GREEN.

### Task 2: Service-worker bootstrap ordering

**Files:**
- Modify: `src/background/service-worker.js`
- Test: `tests/service-worker-bootstrap.test.js`

**Interfaces:**
- Service-worker startup calls `ensureSettings()` then `controller.recoverRealIfNeeded()`.
- Runtime messages await bootstrap completion before dispatch.

- [x] Add a failing source-level smoke test for automatic bootstrap and message serialization.
- [x] Run targeted test and confirm RED.
- [x] Implement startup bootstrap with fail-closed error logging.
- [x] Run targeted test and confirm GREEN.

### Task 3: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `STATE_MACHINE.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] Mark only the M12 service-worker auto-detection item complete; leave in-flight checkpoint and automatic safe continuation open.
- [x] Bump version to `0.8.0`.
- [x] Run full tests, JS syntax checks, JSON validation, and `git diff --check`.
