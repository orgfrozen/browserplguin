# Production Task API Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real-mode Task API client lease-aware, TTL-aware, protocol-versioned, and idempotent without implementing the server.

**Architecture:** `HttpTaskApi` owns the current per-Task lease returned by claim and attaches it to Task-scoped requests. `HeartbeatManager` schedules one non-overlapping heartbeat at a time from the latest server TTL. TaskRunner and the existing Task/Page architecture remain unchanged.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node built-in test runner.

## Global Constraints

- Keep `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Do not add server code or unrelated UI refactors.
- Keep existing TaskRunner terminal ordering: Finalize → Cleanup → terminal API.
- Real Task API protocol version is `1`.
- HTTP claim returns `204` or `{ task, lease }`.
- Task scoped calls require `X-Task-Lease-Token`.
- Progress/artifact/terminal writes require stable idempotency keys.

---

### Task 1: Lease-aware HTTP Task API

**Files:**
- Modify: `src/background/task-api.js`
- Test: `tests/http-task-api.test.js`

**Interfaces:**
- Consumes: existing `TaskApi` method names.
- Produces: `HttpTaskApi.getLease(taskId)` plus the same existing public API methods.

- [x] Add failing tests for claim envelopes, invalid lease metadata, lease headers, heartbeat lease rotation, and `204` idle claims.
- [x] Add injectable fetch, validate/store lease metadata, and attach lease headers to Task-scoped requests.
- [x] Add protocol version `1` header to every request.
- [x] Add canonical-payload deterministic idempotency keys for progress/artifact/terminal writes.
- [x] Clear lease only after successful complete/fail/release.

### Task 2: Lease-TTL heartbeat scheduling

**Files:**
- Modify: `src/background/heartbeat-manager.js`
- Test: `tests/heartbeat-manager.test.js`

**Interfaces:**
- Consumes: `taskApi.getLease(taskId)` and `taskApi.heartbeatTask(taskId)`.
- Produces: the existing `start(taskId)` / `stop()` interface.

- [x] Add failing tests for TTL-derived scheduling.
- [x] Replace overlapping fixed interval behavior with one-shot rescheduling.
- [x] Re-read lease metadata after each heartbeat so token/TTL rotation affects the next schedule.

### Task 3: Protocol documentation and release metadata

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `TASK_PROTOCOL.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: implemented Task API wire contract.
- Produces: documented protocol and version `0.5.0`.

- [x] Document claim/lease/heartbeat/idempotency behavior.
- [x] Mark M10 client-side protocol items complete while leaving server context-limit UI pending.
- [x] Bump package/manifest version to `0.5.0`.
