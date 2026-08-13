# Real ChatGPT DOM Automation Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace fail-closed placeholders for the real ChatGPT project lifecycle with safe semantic DOM automation for creating one temporary project, setting instructions, sending prompts, and deleting the owned project, while retaining explicit fail-closed behavior when the UI cannot be identified uniquely.

**Architecture:** Keep TaskRunner independent of DOM details. BrowserPageDriver coordinates tab/session/project identity and sends narrow commands to the content script. ProjectManager owns semantic UI interactions using a selector/label registry that favors stable attributes and accessible names over CSS classes. All destructive actions verify exact task-owned project identity and unique confirmation targets before clicking.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, Chrome tabs/runtime APIs, Node built-in test runner.

## Global Constraints

- `1 Task = 1 temporary ChatGPT Project = 1 Session`.
- A context-length limit terminates the current Task; no second Project or Session is created.
- Patch numbering is session-local and starts at `001`.
- `task_patch_count` is always observed; `patch_goal.minimum` is optional.
- Project creation/deletion must fail closed on ambiguous UI matches.
- Do not depend on generated CSS class names.
- Prefer stable attributes, accessible role/name, then visible text relations.
- Existing automatic Patch download behavior must remain unchanged.

---

### Task 1: Semantic UI registry and diagnostics

**Files:**
- Create: `src/content/ui-semantics.js`
- Create: `tests/ui-semantics.test.js`

**Interfaces:**
- Produces: `normalizeUiText(value)`, `elementSemanticText(element)`, `findUniqueSemantic(root, selector, patterns, options)`, `collectUiDiagnostics(root)`.
- Consumers: ProjectManager, Composer, content-script diagnostics.

- [x] Write tests proving English/Chinese/Japanese labels can be matched and ambiguous matches fail closed.
- [x] Run `node --test tests/ui-semantics.test.js` and confirm RED.
- [x] Implement semantic normalization, uniqueness checks, visibility checks, and compact diagnostics.
- [x] Run the focused test and confirm GREEN.

### Task 2: Create one temporary ChatGPT Project

**Files:**
- Modify: `src/content/project-manager.js`
- Modify: `src/content/chatgpt-adapter.js`
- Modify: `src/content/content-script.js`
- Modify: `src/background/browser-page-driver.js`
- Modify: `src/shared/project-naming.js`
- Create: `tests/project-manager-actions.test.js`
- Modify: `tests/browser-page-driver.test.js`

**Interfaces:**
- Produces: `ProjectManager.createProject({ projectName }) -> { name, href }`.
- Produces: `BrowserPageDriver.createTaskProject({ task, state }) -> { projectName, sessionId, tabId }`.

- [x] Write failing tests for unique New Project discovery, name input, Create confirmation, collision-safe name selection, and 12-character session ID generation.
- [x] Verify RED.
- [x] Implement wait/poll helpers and semantic create flow.
- [x] Implement BrowserPageDriver project/session generation and content commands.
- [x] Verify focused and regression tests GREEN.

### Task 3: Project Instructions and prompt readiness

**Files:**
- Modify: `src/content/project-manager.js`
- Modify: `src/content/content-script.js`
- Modify: `src/background/browser-page-driver.js`
- Modify: `src/content/composer.js`
- Modify: `tests/project-manager-actions.test.js`
- Modify: `tests/browser-page-driver.test.js`

**Interfaces:**
- Produces: `ProjectManager.setProjectInstructions(text)`.
- BrowserPageDriver creation sequence: create Project -> set generated instructions -> resolve primary chat.

- [x] Write failing tests for opening the unique project menu, selecting Project settings, replacing instructions text, saving, and verifying the modal closes/state persists.
- [x] Verify RED.
- [x] Implement semantic settings flow with fail-closed menu/dialog detection.
- [x] Wire generated `buildProjectInstructions()` text into BrowserPageDriver.
- [x] Verify GREEN.

### Task 4: Owned-project cleanup

**Files:**
- Modify: `src/content/project-manager.js`
- Modify: `src/content/content-script.js`
- Modify: `src/background/browser-page-driver.js`
- Modify: `tests/project-manager-actions.test.js`
- Modify: `tests/browser-page-driver.test.js`

**Interfaces:**
- Produces: `ProjectManager.deleteProject(projectName) -> { deleted: true, name }`.
- Produces: `BrowserPageDriver.deleteTaskProject({ project })`.

- [x] Write failing tests that deletion starts from an exact project identity, opens only its nearby menu, requires a unique Delete project action and unique confirmation, and verifies disappearance.
- [x] Verify RED.
- [x] Implement exact-owned-project cleanup.
- [x] Verify focused tests and TaskRunner cleanup regression tests GREEN.

### Task 5: Real-page diagnostics and documentation

**Files:**
- Modify: `src/content/content-script.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/ui/popup.html`
- Modify: `src/ui/popup.js`
- Modify: `README.md`
- Modify: `TODO.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Create: `tests/ui-diagnostics-integration.test.js`

**Interfaces:**
- Produces popup action `Inspect ChatGPT UI` that returns non-sensitive semantic element metadata (tag/role/aria/title/testid/name/type/placeholder/href), no message content.

- [x] Write failing test for diagnostics command plumbing and privacy filter.
- [x] Verify RED.
- [x] Implement content/background/popup diagnostics.
- [x] Update docs: M6/M7/M9 semantic automation implemented but requires live-page calibration; M8 resource URL upload remains next milestone.
- [x] Verify full suite.

### Task 6: Version, verification, and package

**Files:**
- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `docs/superpowers/plans/2026-08-13-real-chatgpt-dom-automation-phase1.md`

**Interfaces:**
- Produces release ZIP `chatgpt-web-task-runner-dom-phase1-v0.3.0.zip`.

- [x] Set version to `0.3.0`.
- [x] Run `npm test`.
- [x] Run syntax checks for every JS file and JSON parse checks.
- [x] Run `git diff --check` and inspect `git status`.
- [x] Commit implementation.
- [x] Build ZIP excluding `.git`, logs, downloads, and Patch artifacts; inspect ZIP contents.

## Verification note

Phase 1 semantic automation is implemented. `M8 resource.url -> upload -> initialization_prompt` intentionally remains the next milestone and was not claimed as complete by this plan. Live calibration against the user's current ChatGPT DOM is still required before production use.
