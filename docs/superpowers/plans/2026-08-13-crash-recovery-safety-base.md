# Crash Recovery Safety Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the active Task lease and snapshot, verify the lease before recovery, restore only the exact recorded Task Project for RUNNING state, and allow CLEANUP-only recovery without replaying Task prompts.

**Architecture:** Extend existing durable `activeExecution` state instead of adding a second recovery store. `HttpTaskApi` can restore a validated persisted lease, `HeartbeatManager` persists lease rotations through a callback, and `TaskRunner.recoverOnce()` fail-closes before any destructive action unless a heartbeat proves the lock is still valid. RUNNING recovery prepares the exact Project/Chat only; CLEANUP recovery may finish deletion and the recorded terminal API.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node built-in test runner.

## Global Constraints

- Preserve `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Do not create a second Project or Session during recovery.
- Do not resend a Task prompt in this Patch.
- Do not perform destructive recovery actions before lease validation succeeds.
- Exact persisted Project identity is required; fuzzy matching is forbidden.
- `.patch-session.json` must not be changed.

---

### Task 1: Durable task and lease checkpoint

**Files:**
- Modify: `src/shared/execution-state.js`
- Modify: `src/background/task-store.js`
- Modify: `src/background/task-api.js`
- Modify: `src/background/heartbeat-manager.js`
- Test: `tests/execution-state.test.js`
- Test: `tests/task-store.test.js`
- Test: `tests/http-task-api.test.js`
- Test: `tests/heartbeat-manager.test.js`

**Interfaces:**
- Produces: `state.task_snapshot`, `state.lease`, `TaskStore.updateLease(taskId, lease)`, `HttpTaskApi.restoreLease(taskId, lease)`, `HeartbeatManager({ onLeaseUpdated })`.

- [x] Write failing tests for task/lease persistence and rotated lease callbacks.
- [x] Run focused tests and verify they fail for missing behavior.
- [x] Implement the minimal durable checkpoint APIs.
- [x] Run focused tests and verify they pass.

### Task 2: Fail-closed recovery entrypoint

**Files:**
- Modify: `src/background/task-runner.js`
- Test: `tests/task-runner.test.js`

**Interfaces:**
- Produces: `TaskRunner.recoverOnce()` returning `no_recovery`, `recovered_running`, `cleanup_pending`, `completed`, `context_limit`, `released`, or `recovery_blocked`.

- [x] Write failing tests proving lease validation happens before Project open/delete.
- [x] Write failing tests proving RUNNING recovery opens only persisted Project and sends no prompt.
- [x] Write failing tests proving CLEANUP recovery retries cleanup and terminal API.
- [x] Implement the minimal recovery path.
- [x] Run focused tests and verify they pass.

### Task 3: Real runtime wiring and docs

**Files:**
- Modify: `src/background/runtime-controller.js`
- Modify: `src/background/service-worker.js`
- Modify: `tests/runtime-controller.test.js`
- Modify: `tests/service-worker-wiring.test.js`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `STATE_MACHINE.md`
- Modify: `TASK_PROTOCOL.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `RuntimeController.recoverReal()` and `RECOVER_REAL_TASK` command; real runner shares the same `TaskStore` with heartbeat lease persistence.

- [x] Add failing runtime/wiring tests.
- [x] Implement the minimal runtime wiring.
- [x] Update docs and version to `0.7.0`.
- [x] Run full verification.
