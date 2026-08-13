# Popup Active Task Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a privacy-safe, structured active Task summary in the extension Popup without exposing prompts, constraints, API tokens, or lease tokens.

**Architecture:** Add a pure shared status projector that extracts only operational fields from durable runtime state. RuntimeController uses that projector for `GET_RUNNER_STATUS`; Popup renders the projected fields into fixed status cards and retains manual refresh/run/diagnostics actions.

**Tech Stack:** Chrome Extension Manifest V3, browser JavaScript ES modules/background modules, classic Popup script, Node built-in test runner.

## Global Constraints

- Preserve `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Do not change Task execution, recovery, Patch transfer, or Task API semantics.
- Do not expose `task_prompt`, `project_constraints`, resource URLs, API tokens, or lease tokens in Popup status.
- Fail closed: absent state renders as idle/`-`; no inferred values.

---

### Task 1: Privacy-safe runtime status projection

**Files:**
- Create: `src/shared/runner-status.js`
- Modify: `src/background/runtime-controller.js`
- Test: `tests/runner-status.test.js`
- Test: `tests/runtime-controller.test.js`

**Interfaces:**
- Produces: `buildRunnerStatusView({ running, activeExecution, lastRun, lastRecovery, settings }) -> statusView`
- RuntimeController `getStatus()` returns the projected `statusView`.

- [ ] Write failing tests proving operational fields are retained while sensitive fields are absent.
- [ ] Run targeted tests and verify RED.
- [ ] Implement the minimal projector and wire RuntimeController.
- [ ] Run targeted tests and verify GREEN.

### Task 2: Structured Popup rendering

**Files:**
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Test: `tests/ui-files.test.js`

**Interfaces:**
- Consumes: `GET_RUNNER_STATUS` projected response.
- Produces: visible fields for mode, runner, Task, phase, round, Patch count, patch goal, Project, session, in-flight stage, lease TTL, last recovery/error.

- [ ] Write failing UI file tests for required structured fields and non-raw rendering.
- [ ] Run targeted tests and verify RED.
- [ ] Implement minimal structured render and preserve existing actions.
- [ ] Run targeted tests and verify GREEN.

### Task 3: Documentation/version sync and verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

- [ ] Mark M13 Popup observability complete and document privacy boundary.
- [ ] Bump version to `0.10.0`.
- [ ] Run full tests, JS syntax checks, JSON parse checks, and `git diff --check`.
