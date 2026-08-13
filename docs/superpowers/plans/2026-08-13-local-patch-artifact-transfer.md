# Local Patch Artifact Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make local Patch transfer an explicit durable step between Chrome download completion and Task Patch counting/reporting.

**Architecture:** `ChromePatchProcessor` continues to own browser download correlation and returns the final Chrome download artifact. `ArtifactTransferManager` converts that completed artifact into a local transfer receipt. `TaskRunner` transfers before counting, persists the new Patch count before reporting the artifact, and real mode injects the configured transfer manager.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Chrome downloads API, Node built-in test runner.

## Global Constraints

- Keep `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Do not implement Native Helper or remote upload in this Patch.
- A Patch is counted only after Chrome download completion and local transfer validation.
- Report the final Chrome download metadata: download id, filename, local path, source URL, Patch key, session id, and Task id.
- Keep Task cleanup ordering unchanged.
- Do not modify `.patch-session.json`.

---

### Task 1: Local transfer receipt

**Files:**
- Modify: `src/background/artifact-transfer-manager.js`
- Create: `tests/artifact-transfer-manager.test.js`

**Interfaces:**
- Consumes: completed Patch artifact returned by `ChromePatchProcessor.process()`.
- Produces: `ArtifactTransferManager.transfer(artifact)` returning `{ mode: 'local', artifact, receipt }`.

- [x] Add a failing test requiring local mode to reject incomplete Chrome download metadata and emit a receipt containing final download metadata.
- [x] Implement local validation and the local transfer receipt without moving or re-reading the browser file.
- [x] Keep remote mode fail-closed when no remote transport is configured.

### Task 2: Transfer-before-count TaskRunner ordering

**Files:**
- Modify: `src/background/task-runner.js`
- Modify: `tests/task-runner.test.js`

**Interfaces:**
- Consumes: injected `artifactTransfer.transfer(artifact)`.
- Produces: artifact API payload enriched with `transfer_mode` and `transfer_receipt`.

- [x] Add a failing test proving transfer happens before Task Patch count/reporting.
- [x] Add a failing test proving transfer failure does not increment `task_patch_count` or report the artifact.
- [x] Persist execution state immediately after a newly transferred Patch is counted, before artifact API reporting.

### Task 3: Real-mode wiring and documentation

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `TASK_PROTOCOL.md`
- Modify: `PATCH_DOWNLOAD.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: existing `patchTransferMode` setting.
- Produces: real-mode `ArtifactTransferManager` wiring and version `0.6.0`.

- [x] Wire `ArtifactTransferManager` into real TaskRunner construction.
- [x] Document first-version local directory policy as the browser's configured Downloads destination while reporting Chrome's final absolute path metadata.
- [x] Mark M11 local metadata reporting complete while keeping remote upload work open.
- [x] Bump package/manifest version to `0.6.0`.
