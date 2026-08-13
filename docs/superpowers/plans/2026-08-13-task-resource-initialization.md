# Task Resource Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add M8 resource initialization so a Task can download one `resource.url`, attach it to the temporary ChatGPT Project chat, wait for attachment readiness, run `initialization_prompt`, and only then begin the existing `task_prompt` loop.

**Architecture:** Keep TaskRunner orchestration independent from Chrome DOM mechanics. BrowserPageDriver owns the initialization sequence and uses an injected resource loader for cross-origin download/validation, then sends a serializable resource payload to the content script. Composer converts that payload to a browser `File`, injects it into the ChatGPT file input, and fails closed unless the attachment becomes visibly ready.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Chrome runtime/tabs/permissions APIs, Node built-in test runner.

## Global Constraints

- `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- Context Limit terminates the Task; no Project migration.
- Existing Patch download behavior remains unchanged.
- Resource initialization runs once, before the first normal Task round.
- Resource download/upload failures fail closed and preserve existing Finalize/Cleanup behavior.
- No new runtime dependency.

---

### Task 1: Validate resource task input

**Files:**
- Modify: `src/shared/task-schema.js`
- Modify: `tests/task-schema.test.js`

**Interfaces:**
- `resource` is optional.
- When present, `resource.url` must be a non-empty HTTP(S) URL.
- Optional `resource.filename` may override the response URL/header filename.

- [x] Add failing schema tests for invalid and valid `resource.url`.
- [x] Implement minimal validation/normalization.
- [x] Run focused tests.

### Task 2: Download and validate resource bytes

**Files:**
- Create: `src/background/resource-loader.js`
- Create: `tests/resource-loader.test.js`

**Interfaces:**
- `ResourceLoader.load(resource) -> { filename, mimeType, size, base64, sourceUrl }`.
- Reject non-2xx responses, empty payloads, invalid filenames, and configured oversize payloads with `RESOURCE_DOWNLOAD_FAILED`.

- [x] Add failing download/filename/size tests.
- [x] Implement fetch + metadata validation + base64 encoding.
- [x] Run focused tests.

### Task 3: Attach resource and wait for readiness

**Files:**
- Modify: `src/content/composer.js`
- Modify: `src/content/content-script.js`
- Modify: `tests/composer.test.js`

**Interfaces:**
- `Composer.attachResource(resource) -> { attached: true, filename }`.
- `CHATGPT_ATTACH_RESOURCE` content command delegates to the Composer.
- Only a unique file input associated with the composer may be used.
- Return only after the named attachment is visible and no longer uploading/processing.

- [x] Add failing attachment tests.
- [x] Implement base64 -> File, DataTransfer injection, change/input events, readiness polling.
- [x] Run focused tests.

### Task 4: Initialize before normal Task rounds

**Files:**
- Modify: `src/background/browser-page-driver.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/background/task-runner.js`
- Modify: `tests/browser-page-driver.test.js`
- Modify: `tests/task-runner.test.js`

**Interfaces:**
- `BrowserPageDriver.initializeTask({ task, state })` performs load -> attach -> initialization prompt round.
- TaskRunner calls `initializeTask` once after project creation and before first `task_prompt` round when `task.resource` exists.
- Initialization response is not counted as a Task work round or Patch-producing round.

- [x] Add failing ordering and error-propagation tests.
- [x] Implement driver/service-worker wiring and one-time TaskRunner initialization.
- [x] Run focused and regression tests.

### Task 5: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `TODO.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TASK_PROTOCOL.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

- [x] Mark M8 resource initialization implemented but live DOM calibration pending.
- [x] Bump version to `0.4.0`.
- [x] Run `npm test`, JS syntax checks, JSON parse checks, `git diff --check`.
- [x] Generate Patch Sync sequence 001 from the uploaded baseline index, excluding `.patch-session.json`.

## Verification record

- Baseline before changes: 75/75 tests passed.
- Final implementation tree: 86/86 tests passed.
- `node --check`: 57 JavaScript files.
- JSON parse: package, lockfile, manifest, mock tasks, and patch session metadata.
- `.patch-session.json` remained unchanged and is excluded from the Git diff.
