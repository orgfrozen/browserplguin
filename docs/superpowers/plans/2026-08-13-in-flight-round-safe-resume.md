# In-Flight Round Safe Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Safely resume a RUNNING Task after Service Worker/browser interruption without guessing whether the current Prompt was already sent or duplicating a completed round.

**Architecture:** Persist one durable `in_flight_round` checkpoint on the existing single-Task/single-Project execution state. Browser DOM recovery cross-checks that checkpoint against the exact latest user message, latest message role, composer generation state, context-limit state, and latest assistant response before deciding whether to send, wait, reuse a completed response, or block recovery. Normal and recovered round processing share the same Patch/status completion path.

**Tech Stack:** Chrome Extension Manifest V3, ES modules, Node.js built-in test runner, existing TaskStore/TaskRunner/BrowserPageDriver/content adapter.

## Global Constraints

- Keep `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Do not migrate a Task to another Project when chat/context length is reached.
- Never resend a Prompt on recovery unless the current ChatGPT page proves that Prompt is not the latest user message and the composer is READY.
- Ambiguous DOM state fails closed with `TASK_RECOVERY_BLOCKED`.
- `task_round_count` counts fully persisted work rounds only.
- `.patch-session.json` must remain byte-for-byte unchanged and excluded from the Git diff.

---

### Task 1: Durable round checkpoint state

**Files:**
- Modify: `src/shared/execution-state.js`
- Test: `tests/execution-state.test.js`

**Interfaces:**
- Produces: `checkpointRoundIntent(state, prompt)`, `markRoundPromptSent(state)`, `markRoundResponseReady(state, assistantText)`, `completeRound(state, { status, fallbackCount })`.

- [x] Write failing tests for intent/sent/response-ready/completed transitions and initialization completion.
- [x] Run targeted tests and confirm RED.
- [x] Implement the minimal immutable state transitions.
- [x] Run targeted tests and confirm GREEN.

### Task 2: Page fact snapshot and recoverable round driver

**Files:**
- Modify: `src/content/conversation-manager.js`
- Modify: `src/content/chatgpt-adapter.js`
- Modify: `src/content/content-script.js`
- Modify: `src/background/browser-page-driver.js`
- Test: `tests/browser-page-driver.test.js`

**Interfaces:**
- Produces content command: `CHATGPT_ROUND_SNAPSHOT`.
- Produces driver method: `recoverRound({ task, state, checkpoint, hooks })`.
- Extends `runRound({ ..., hooks })` with `onPromptSent()` and `onResponseReady(text)` callbacks.

- [x] Write failing tests for normal hook order, recovering an unsent intent, continuing an already-generating Prompt without resending, reusing a completed response, and blocking ambiguous/mismatched pages.
- [x] Run targeted tests and confirm RED.
- [x] Implement exact latest-user/latest-role snapshot and fail-closed recovery decisions.
- [x] Run targeted tests and confirm GREEN.

### Task 3: Shared normal/recovered Task loop

**Files:**
- Modify: `src/background/task-runner.js`
- Test: `tests/task-runner.test.js`

**Interfaces:**
- Consumes TaskStore checkpoints and `BrowserPageDriver.recoverRound()`.
- Produces automatic `recoverOnce()` continuation only when durable/page evidence is sufficient.

- [x] Write failing tests covering crash before send, crash while generating, crash after response before persistence, crash between fully completed rounds, and ambiguous state blocking.
- [x] Run targeted tests and confirm RED.
- [x] Refactor the existing loop minimally so normal and recovery paths share Patch/status processing.
- [x] Ensure round count is incremented only in the same durable save that clears the checkpoint.
- [x] Run targeted and full tests.

### Task 4: Documentation and release verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `STATE_MACHINE.md`
- Modify: `TASK_PROTOCOL.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `manifest.json`

- [x] Document the durable round stages and fail-closed recovery rules.
- [x] Mark the two remaining M12 items complete only if the implementation/tests cover them.
- [x] Bump version to `0.9.0`.
- [x] Run `npm test`, JS syntax checks, JSON parse checks, `git diff --check`, Patch apply replay, and verify `.patch-session.json` is unchanged.
