# Privacy-Safe Error DOM Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing each behavior. No git commit/push is performed in this Patch Sync workflow.

**Goal:** Attach a privacy-safe DOM compatibility snapshot to failed ChatGPT automation commands so live selector calibration can diagnose UI drift without exposing conversation or task content.

**Architecture:** Keep the existing manual `CHATGPT_UI_DIAGNOSTICS` command unchanged. Add a stricter error-diagnostics builder in the content layer that summarizes page access state, selector profile, sanitized URL/title categories, visible control fingerprints, and counts. Content-script failures return this snapshot under `error.diagnostics`; background/runtime code does not persist raw DOM or screenshots.

**Tech Stack:** Manifest V3 extension, JavaScript ES modules, Node built-in test runner.

## Global Constraints

- Use the uploaded source ZIP plus Patch 001-009 as the exact parent state.
- Do not change Task execution semantics, selector matching order, or existing manual Inspect UI behavior.
- Do not capture screenshots in this patch.
- Do not collect conversation text, task prompts, project constraints, project names, attachment names, tokens, URL query strings, URL hashes, or arbitrary document title text.
- Unknown/ambiguous UI behavior remains fail-closed.

---

### Task 1: Privacy-safe diagnostic snapshot

**Files:**
- Modify: `src/content/ui-semantics.js`
- Create: `tests/error-dom-diagnostics.test.js`

**Interfaces:**
- Produce: `collectErrorDomDiagnostics(root, { location, title, accessState, selectorProfile, limit })`.
- Output only sanitized page metadata, aggregate counts, and bounded control fingerprints.

- [x] Write failing tests for URL query/hash stripping, title categorization, free-text exclusion, safe control fingerprints, and deterministic limits.
- [x] Run the focused test and confirm RED.
- [x] Implement the minimal privacy-safe collector.
- [x] Run the focused test and confirm GREEN.

### Task 2: Attach diagnostics only to failed automation commands

**Files:**
- Modify: `src/content/content-script.js`
- Modify: `tests/ui-diagnostics-integration.test.js`

**Interfaces:**
- Automation failures return `{ ok:false, error:{ code, message, diagnostics } }`.
- `CHATGPT_UI_DIAGNOSTICS` and `CHATGPT_ACCESS_STATE` keep existing success behavior.

- [x] Write failing tests proving selector/login failures include safe diagnostics and secrets are absent.
- [x] Run focused tests and confirm RED.
- [x] Implement content-script error attachment without changing successful command responses.
- [x] Run focused tests and confirm GREEN.

### Task 3: Documentation/version synchronization

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`

- [x] Document the privacy boundary and explicitly state screenshots are not captured.
- [x] Mark the M13 privacy-safe error DOM diagnostics item complete while leaving compatibility telemetry incomplete.
- [x] Bump version to `0.13.0`.
- [x] Run the complete verification suite and Patch Sync replay checks.
