# Login / Challenge Page Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Stop all destructive or task-advancing ChatGPT automation when the open browser is logged out or showing an access/security challenge.

**Architecture:** Add a content-side page access classifier that only inspects top-level URL/title and compact UI control semantics. Wire it through `ChatGptAdapter` so content commands fail with `LOGIN_OR_CHALLENGE_REQUIRED`, while diagnostics/access-state remain available. Extend `TabManager` to recognize an open `auth.openai.com` login tab when no runnable `chatgpt.com` tab exists.

**Tech Stack:** Chrome Extension Manifest V3, ES modules, Node built-in test runner.

## Global Constraints

- Keep the existing MV3 architecture and semantic/fail-closed DOM style.
- Do not inspect or return conversation body text for access detection.
- Do not add permissions or dependencies.
- `.patch-session.json` must remain unchanged and excluded from the Patch diff.
- No git commit/push from the webpage LLM workflow.

---

### Task 1: Page access classifier

**Files:**
- Create: `src/content/page-access-guard.js`
- Test: `tests/page-access-guard.test.js`

**Interfaces:**
- Produces: `classifyChatGptPageAccess({ root, location, title })` and `assertChatGptPageAccessible(...)`.

- [x] Write failing tests for READY, logged-out, and challenge states.
- [x] Run the targeted test and confirm missing implementation failure.
- [x] Implement minimal privacy-safe semantic classification.
- [x] Run targeted tests until green.

### Task 2: Adapter/content command enforcement

**Files:**
- Modify: `src/content/chatgpt-adapter.js`
- Modify: `src/content/content-script.js`
- Test: `tests/chatgpt-adapter.test.js`
- Test: `tests/ui-diagnostics-integration.test.js`

**Interfaces:**
- Produces: `ChatGptAdapter.assertPageAccessible()` and `getPageAccessState()`.

- [x] Write failing tests that automation is blocked while diagnostics/access-state remain available.
- [x] Run tests and confirm expected failures.
- [x] Add guard wiring before ChatGPT automation commands.
- [x] Run targeted tests until green.

### Task 3: Auth redirect tab detection and docs

**Files:**
- Modify: `src/background/tab-manager.js`
- Create: `tests/tab-manager.test.js`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `STATE_MACHINE.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `manifest.json`

**Interfaces:**
- `TabManager.findChatGptTab()` throws `LOGIN_OR_CHALLENGE_REQUIRED` if auth login is the only relevant OpenAI tab.

- [x] Write failing auth-tab test.
- [x] Implement auth tab recognition without adding permissions.
- [x] Update docs/TODO and bump version to 0.11.0.
- [x] Run full tests, JS syntax checks, JSON validation, and `git diff --check`.
