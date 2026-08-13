# Single-Project Task Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the runner so one claimed Task owns exactly one temporary ChatGPT Project and one Session, and ChatGPT context-length exhaustion terminates the Task instead of migrating it.

**Architecture:** `TaskRunner` creates one Task workspace, runs any number of rounds inside it, finalizes artifacts, deletes that workspace, and only then completes/fails/releases the server Task. `CONTEXT_LIMIT` is a terminal non-success result reported with accumulated Patch/round counts. Crash recovery may later reopen the single persisted Task workspace, but normal execution never searches for or migrates into another Project.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Node.js built-in test runner.

## Global Constraints

- One Task = one temporary ChatGPT Project = one Session.
- A Task may contain many model rounds and many Patch artifacts.
- `task_patch_count` is always tracked; `patch_goal.minimum` is optional and only constrains Tasks that provide it.
- ChatGPT context/chat length limit terminates the current Task; never create a second Project automatically.
- Before any terminal server transition, finish Patch handling and delete the Task-owned Project.
- Cleanup failure keeps the Task locked with durable `CLEANUP` state.
- Real ChatGPT create/delete selectors remain fail-closed until calibrated.

---

### Task 1: Simplify execution state to one workspace

**Files:**
- Modify: `src/shared/execution-state.js`
- Test: `tests/execution-state.test.js`

**Interfaces:**
- Produces: `createExecutionState(task)`, `recordCreatedWorkspace(state, { projectName, sessionId })`, `recordRound(state)`, `recordCompletedPatch(state, patchKey, aliases)`, `markWorkspaceDeleted(state)`.

- [x] Replace Session/Project migration counters with Task-only `task_round_count` and `task_patch_count`.
- [x] Replace `task_projects[]` with one nullable `task_project` record.
- [x] Preserve Patch-key dedupe behavior.
- [x] Run `node --test tests/execution-state.test.js`.

### Task 2: Make context limit terminal in TaskRunner

**Files:**
- Modify: `src/background/task-runner.js`
- Test: `tests/task-runner.test.js`

**Interfaces:**
- Consumes: `page.runRound()` result field `contextLimit`.
- Produces: runner result `{ status: 'context_limit', state }` for length exhaustion.

- [x] Add a failing test proving a context limit never calls any migration method and creates only one Project.
- [x] Add a failing test proving Patch/round counts accumulated before the limit are included in the terminal failure payload.
- [x] Refactor terminal handling so success, context limit, protocol errors, and unexpected terminal errors all pass through finalization/cleanup before server transition.
- [x] Keep cleanup failure locked and durable.
- [x] Run `node --test tests/task-runner.test.js`.

### Task 3: Remove migration from page drivers and mocks

**Files:**
- Modify: `src/background/browser-page-driver.js`
- Modify: `src/background/mock-page-driver.js`
- Modify: `src/content/content-script.js`
- Test: `tests/browser-page-driver.test.js`
- Test: `tests/mock-page-driver.test.js`
- Test: `tests/mock-integration.test.js`
- Modify: `mock/tasks.json`

**Interfaces:**
- `runRound()` returns `{ contextLimit: true, assistantText: '', patches: [] }` when the UI detects the chat/context limit.
- `MockPageDriver.deleteTaskProject()` supports cleanup in integration tests.

- [x] Rename hard-limit signaling to context-limit semantics.
- [x] Delete `migrateTask()` from real and mock drivers.
- [x] Replace forced-migration mock with a context-limit terminal scenario.
- [x] Verify single-Project Mock Tasks clean up successfully.

### Task 4: Align Project instructions and all docs

**Files:**
- Modify: `src/shared/project-naming.js`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `STATE_MACHINE.md`
- Modify: `TASK_PROTOCOL.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `PATCH_DOWNLOAD.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `docs/superpowers/plans/2026-08-13-chatgpt-web-task-runner-initialization.md`
- Rename/Modify: `docs/superpowers/plans/2026-08-13-ephemeral-task-project-lifecycle.md` → `docs/superpowers/plans/2026-08-13-single-task-project-lifecycle.md`

- [x] Remove all cross-Session migration, soft rotation, second-Project, and Session-local counter guidance.
- [x] State explicitly that server-side continuation, if desired, is a new Task.
- [x] Document terminal ordering: `FINALIZING → CLEANUP → COMPLETE/FAIL/RELEASE`.
- [x] Rewrite TODO milestones around single-Project execution and context-limit termination.

### Task 5: Full verification and packaging

**Files:**
- Verify entire repository.
- Create: `/mnt/data/chatgpt-web-task-runner-single-project.zip`

- [x] Run `npm test` and require zero failures.
- [x] Run JS syntax checks over every `src/**/*.js` and `tests/**/*.js` file.
- [x] Validate `manifest.json` parses as JSON.
- [x] Search active docs/code for forbidden migration terminology and inspect any remaining historical/intentional occurrence.
- [x] Build ZIP without `.git`, logs, downloads, Patch files, or worktree metadata.
