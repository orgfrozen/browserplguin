# Resource E2E Evidence Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing each task. Patch Sync rules prohibit `git commit` and `git push` in this session.

**Goal:** Add privacy-safe evidence proving whether a real Task resource reached ChatGPT attachment readiness and durable initialization completion.

**Architecture:** Add a standalone tracker/ledger, expose successful resource milestones through BrowserPageDriver → TaskRunner observer hooks, and let the real Service Worker persist best-effort evidence after each invocation. Popup reads only the sanitized summary.

**Tech Stack:** Chrome MV3 extension, JavaScript ES modules, Node built-in test runner, `chrome.storage.local`.

## Global Constraints

- Do not change Task execution authority: evidence observers are best-effort only.
- Do not store Task/Project/Session IDs, resource URLs/origins, filenames, bytes/base64, Prompt/response text, tokens, DOM text, or raw error messages.
- Do not infer a successful resource initialization from recovery state that was not witnessed in the current invocation.
- Keep the real Chrome resource E2E TODO open until live evidence exists.
- Do not commit or push.

---

### Task 1: Resource evidence tracker and ledger

**Files:**
- Create: `src/background/resource-e2e-evidence.js`
- Create: `tests/resource-e2e-evidence.test.js`

**Interfaces:**
- `new ResourceE2eRunTracker()`
- `onResourceInitializationStarted()`
- `onResourceDownloaded()`
- `onResourceAttached()`
- `onResourceInitializationResponseReady()`
- `onResourceInitializationCompleted()`
- `finish({ runnerStatus, errorCode, recovered })`
- `new ResourceE2eEvidenceLedger({ storage })`
- `record(run)`, `getSummary()`, `clear()`

- [x] **Step 1: Write failing tracker/ledger tests**

Cover a complete pass, permission/download/attachment/prompt/persist failure classification, recovery fail-closed behavior, non-resource `null`, bounded recent history, and forbidden-field stripping.

- [x] **Step 2: Run the new test and verify RED**

Run: `node --test tests/resource-e2e-evidence.test.js`

Expected: module-not-found or missing-interface failure caused only by the new feature not existing.

- [x] **Step 3: Implement the minimal tracker/ledger**

Use fixed enum sets and whitelist projection. `passed` requires all five witnessed stage booleans. If no `started` event was seen, `finish()` returns `null`.

- [x] **Step 4: Re-run and verify GREEN**

Run: `node --test tests/resource-e2e-evidence.test.js`

Expected: all resource evidence tests pass.

### Task 2: Expose successful resource milestones without changing Task semantics

**Files:**
- Modify: `src/background/browser-page-driver.js`
- Modify: `src/background/task-runner.js`
- Modify: `tests/browser-page-driver.test.js`
- Modify: `tests/task-runner.test.js`

**Interfaces:**
- `BrowserPageDriver.initializeTask({ task, hooks })`
- hooks: `onResourceDownloaded`, `onResourceAttached`
- Task observer methods mirror the five tracker methods from Task 1.

- [x] **Step 1: Add failing stage-order and observer-isolation tests**

Require download hook after `ResourceLoader.load`, attach hook after `CHATGPT_ATTACH_RESOURCE`, and TaskRunner completion observer only after durable save plus `TASK_INITIALIZED` reporting. Observer throws must not affect the Task.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/browser-page-driver.test.js tests/task-runner.test.js`

Expected: assertions fail because the new resource hooks are not emitted.

- [x] **Step 3: Add minimal hooks**

Call only successful milestones. For Context Limit, do not emit response-ready/completed. Existing resource control flow and errors remain unchanged.

- [x] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test tests/browser-page-driver.test.js tests/task-runner.test.js`

Expected: all focused tests pass.

### Task 3: Persist real-run evidence and expose Popup summary

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `tests/service-worker-wiring.test.js`
- Modify: `tests/ui-files.test.js`

**Interfaces:**
- Runtime messages: `GET_RESOURCE_E2E_EVIDENCE`, `CLEAR_RESOURCE_E2E_EVIDENCE`
- Popup fields: recorded runs, passed runs, latest result, failure stage.

- [x] **Step 1: Add failing wiring/UI tests**

Require Service Worker tracker/ledger creation and read/clear commands; require Popup summary/clear controls and forbid resource identity fields.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/service-worker-wiring.test.js tests/ui-files.test.js`

Expected: resource evidence wiring/UI assertions fail.

- [x] **Step 3: Implement minimal Service Worker and Popup wiring**

Compose the resource tracker with the existing remote observer by forwarding fixed methods. Record evidence best-effort after the invocation. Recovery never fabricates a pass.

- [x] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test tests/service-worker-wiring.test.js tests/ui-files.test.js`

Expected: focused tests pass.

### Task 4: Version, docs, and Patch verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`

- [x] **Step 1: Bump version to `0.27.0` and synchronize docs/TODO**

Mark only `Resource E2E Evidence Recorder` complete. Keep live file-input calibration and real resource E2E unchecked.

- [x] **Step 2: Run full verification**

Run `npm test`, `node --check` for every JS/MJS file, parse project JSON, search for a project-provided `VERIFY_COMMAND`, verify `.patch-session.json` hash, verify no forbidden paths/secrets, and verify the live resource E2E TODO remains unchecked.

- [x] **Step 3: Generate Patch 024 from exact parent**

Use metadata `SEQUENCE=24`, `PARENT_SEQUENCE=23`, then standard binary-capable Git diff against `source + 001..023`.

- [x] **Step 4: Replay the final Patch from scratch**

Rebuild `source → 001..023 → git apply --check 024 → apply 024` and rerun the complete verification suite before reporting completion.
