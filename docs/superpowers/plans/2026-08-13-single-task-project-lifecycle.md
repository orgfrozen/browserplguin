# Single Task Project Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each claimed Task own one temporary ChatGPT Project/Session from creation through cleanup, with no Task-local workspace continuation.

**Architecture:** TaskRunner creates one Task-owned Project, persists that Project identity, executes all model rounds there, and routes every terminal condition through Finalize/Cleanup before changing the server Task state. Context Limit is a terminal failure reason rather than a request to create another workspace.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node.js test runner.

## Global Constraints

- One Task = one temporary Project = one Session.
- Normal execution always creates a new Project.
- `task_patch_count` is Task-wide and is the only Patch-count runtime field.
- `patch_goal.minimum` remains optional.
- Context Limit ends the Task.
- Cleanup must finish before complete/fail/release.
- Cleanup failure keeps the Task locked.

---

### Task 1: Single workspace execution state

**Files:** `src/shared/execution-state.js`, `tests/execution-state.test.js`

- [x] Store a single `task_project` record.
- [x] Remove Project history array.
- [x] Remove Session/Project round counters.
- [x] Remove Session Patch counter.
- [x] Preserve Patch dedupe and Task counters.

### Task 2: Fresh Project per claim

**Files:** `src/background/task-runner.js`, `src/background/mock-page-driver.js`, `tests/task-runner.test.js`

- [x] Call `createTaskProject()` once for each normal Task claim.
- [x] Persist returned Project/Session identity.
- [x] Do not route normal execution through historical Project lookup.

### Task 3: Context Limit terminal behavior

**Files:** `src/background/task-runner.js`, `src/background/browser-page-driver.js`, `src/content/content-script.js`, tests.

- [x] Surface `contextLimit` from ChatGPT UI state.
- [x] Stop the current Task immediately when detected.
- [x] Preserve completed Task Patch/round counts.
- [x] Do not create another Project/Session.
- [x] Report `CHAT_LENGTH_LIMIT` after cleanup.

### Task 4: Finalize and cleanup ordering

**Files:** `src/background/task-runner.js`, `src/shared/execution-state.js`, tests.

- [x] Enter `FINALIZING` before cleanup.
- [x] Enter `CLEANUP` before Project deletion.
- [x] Delete the single Task Project before terminal server API.
- [x] Keep state durable and Task locked when deletion fails.

### Task 5: Live ChatGPT DOM implementation

**Files:** content/background ChatGPT adapters.

- [ ] Calibrate Project create selector.
- [ ] Calibrate Project Instructions selector.
- [ ] Implement task resource upload.
- [ ] Calibrate Project delete selector with exact identity verification.
- [ ] Validate Context Limit detection on live UI.

### Task 6: Crash recovery

**Files:** TaskStore, RuntimeController, BrowserPageDriver, tests.

- [ ] Verify server lock still belongs to this runner.
- [ ] Reopen only the single persisted `task_project`.
- [ ] Resume RUNNING or CLEANUP depending on durable phase.
- [ ] Never create a second Project while recovering the same Task.
