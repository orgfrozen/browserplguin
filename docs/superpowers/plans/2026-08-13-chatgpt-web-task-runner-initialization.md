# ChatGPT Web Task Runner Initialization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize a testable Chrome Extension architecture for server-driven ChatGPT Web Tasks with automatic Patch download.

**Architecture:** The extension separates server orchestration, durable Task state, page automation, and Patch download processing. The finalized Task contract is one Task-owned temporary Project/Session; model rounds and Patch artifacts are many-to-one under that Task.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node.js built-in test runner.

## Global Constraints

- One Task = one temporary ChatGPT Project = one Session.
- A Task may have many model rounds and many Patch artifacts.
- Always track `task_patch_count`; `patch_goal.minimum` is optional.
- Context Limit terminates the Task without Task-local continuation.
- Terminal server state occurs only after Project cleanup.
- Live destructive ChatGPT selectors fail closed until validated.

---

### Task 1: Extension and test skeleton

- [x] Manifest V3.
- [x] Module service worker.
- [x] Content bootstrap/script.
- [x] Popup/options skeleton.
- [x] Node test command.

### Task 2: Task schema and API abstraction

- [x] Validate Task identity/prompt fields.
- [x] Add optional `patch_goal.minimum`.
- [x] Mock Task API claim/lock/progress/artifact/terminal operations.
- [x] HTTP Task API interface.

### Task 3: Execution state

- [x] `task_round_count`.
- [x] `task_patch_count`.
- [x] `downloaded_patch_keys`.
- [x] one `task_project` with `project_name`, `session_id`, `status`.
- [x] terminal/cleanup state fields.

### Task 4: Model status and Task protocol

- [x] READY/GENERATING semantics.
- [x] Require generating transition before accepting ready completion.
- [x] Stable Assistant response read.
- [x] `<TASK_STATUS>` parser and action decision.
- [x] Context Limit signal.

### Task 5: Patch automatic download

- [x] Discover Patch controls from latest Assistant response.
- [x] Direct URL path.
- [x] Click-only path.
- [x] Download intent correlation.
- [x] Chrome completed-download requirement.
- [x] Current Session identity filtering.
- [x] Durable Patch dedupe/counting.

### Task 6: TaskRunner orchestration

- [x] Fresh Project interface per claim.
- [x] Multi-round Task loop.
- [x] Optional Patch-goal continuation.
- [x] Context Limit terminal path.
- [x] Finalize/Cleanup ordering.
- [x] Cleanup-pending lock preservation.
- [x] Mock integration scenarios.

### Task 7: Live Project initialization

- [ ] Create Project on current `chatgpt.com` UI.
- [ ] Set Project Instructions.
- [ ] Download Task resource.
- [ ] Upload Task resource.
- [ ] Send initialization prompt.
- [ ] Start Task prompt only after initialization finishes.

### Task 8: Live Project cleanup

- [ ] Delete exact Task-owned Project.
- [ ] Confirm deletion completed.
- [ ] Persist cleanup diagnostics on failure.

### Task 9: Production hardening

- [ ] Crash recovery of the single Task Project.
- [ ] Production Task API idempotency/lease details.
- [ ] Remote artifact upload.
- [ ] Selector compatibility/versioning.
- [ ] Login/challenge diagnostics.
