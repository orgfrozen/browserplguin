# Context Limit Terminal Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ChatGPT Context Limit a first-class idempotent Task API terminal status and expose the compact result in the Popup.

**Architecture:** Add a `CONTEXT_LIMIT` terminal action and `/tasks/{task_id}/context-limit` client method while preserving the existing cleanup/TERMINAL_PENDING ordering. Keep legacy persisted `FAIL + terminal_status=context_limit` recovery exact. Reuse the privacy-safe runner status projection for Popup display.

**Tech Stack:** Manifest V3 extension, JavaScript ES modules, Node `node:test`.

## Global Constraints

- Preserve `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Never create a second Project/Session after Context Limit.
- Delete the temporary Project before any terminal API call.
- Persist exact terminal payload before the terminal request; retry exact payload after crashes.
- Keep protocol version `1` and existing lease/idempotency rules.
- Do not expose Prompt, project constraints, API token, lease token, or error message body in status UI.
- Do not `git commit`, `git push`, or modify `.patch-session.json`.

---

### Task 1: Add the dedicated Task API operation

**Files:**
- Modify: `src/background/task-api.js`
- Modify: `src/background/mock-task-api.js`
- Test: `tests/http-task-api.test.js`

**Interfaces:**
- Produces: `TaskApi.contextLimitTask(taskId, result)` and `HttpTaskApi.contextLimitTask(taskId, result)`.
- Produces: mock Task status `context_limit` with event type `CONTEXT_LIMIT`.

- [x] **Step 1: Write failing tests** for the `/context-limit` endpoint, lease header, stable idempotency key, lease clear-on-success, and mock status/event.
- [x] **Step 2: Run those tests and confirm they fail because the operation does not exist / mock still reports failed.**
- [x] **Step 3: Implement the minimal API methods using the existing terminal `#taskWrite` path.**
- [x] **Step 4: Run the focused tests and confirm they pass.**

### Task 2: Route Context Limit through a durable terminal action

**Files:**
- Modify: `src/background/task-runner.js`
- Test: `tests/task-runner.test.js`
- Test: `tests/mock-integration.test.js`

**Interfaces:**
- Produces: new durable `terminal_action=CONTEXT_LIMIT` for newly detected Context Limit.
- Consumes: `taskApi.contextLimitTask(taskId, payload)`.
- Preserves: legacy `terminal_action=FAIL` recovery behavior exactly.

- [x] **Step 1: Write failing tests** proving normal-round and initialization Context Limit use the new server status, terminal failures checkpoint `CONTEXT_LIMIT`, recovery retries it, and legacy FAIL checkpoint still retries FAIL.
- [x] **Step 2: Run focused tests and confirm the expected failures.**
- [x] **Step 3: Add minimal `#contextLimit` routing and extend `#sendTerminal/#finishRecoveredCleanup` for `CONTEXT_LIMIT`.**
- [x] **Step 4: Re-run focused tests and keep all existing cleanup/recovery tests green.**

### Task 3: Expose compact Context Limit state in the Popup

**Files:**
- Modify: `src/shared/runner-status.js`
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Test: `tests/runner-status.test.js`
- Test: `tests/ui-files.test.js`

**Interfaces:**
- Produces: `activeExecution.terminal_status` derived only from durable terminal reason/action.
- Renders: `lastRun` through the existing compact result shape.

- [x] **Step 1: Write failing tests** for active `terminal_status=context_limit` and Popup `Last Run` rendering.
- [x] **Step 2: Run focused tests and confirm failures.**
- [x] **Step 3: Implement the minimal status projection and UI row.**
- [x] **Step 4: Run focused tests and verify privacy assertions still pass.**

### Task 4: Protocol/docs/version and Patch verification

**Files:**
- Modify: `TASK_PROTOCOL.md`
- Modify: `STATE_MACHINE.md`
- Modify: `README.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

- [x] **Step 1: Document `/context-limit`, durable `CONTEXT_LIMIT`, legacy recovery compatibility, and Popup presentation; mark M10 Context Limit status/UI complete.**
- [x] **Step 2: Bump version to `0.18.0`.**
- [x] **Step 3: Run full `npm test`, JS syntax, JSON parsing, and `git diff --check`.**
- [x] **Step 4: Generate Patch 015 with `SEQUENCE=15`, `PARENT_SEQUENCE=14`, then apply source→001…014→015 from scratch and repeat verification.**
