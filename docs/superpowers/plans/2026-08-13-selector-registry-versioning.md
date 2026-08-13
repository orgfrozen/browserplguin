# Selector Registry Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing this plan. Patch Sync owns commit/push; do not run git commit or git push.

**Goal:** Introduce a versioned ChatGPT selector profile registry without changing the current semantic matching behavior, and expose the active profile in privacy-safe diagnostics/status.

**Architecture:** Add one shared registry with a single active profile, `chatgpt-semantic-v1`, containing the selectors and multilingual semantic patterns currently embedded across content modules. Existing modules read from the active profile, so live calibration can later add or switch profiles without rewriting driver logic. Unknown profile IDs fail closed with `UI_SELECTOR_INCOMPATIBLE`. Diagnostics expose only profile id/version, never selector internals or page conversation text.

**Tech Stack:** Chrome Extension Manifest V3, browser ES modules, Node.js built-in test runner.

## Global Constraints

- Use the uploaded `browserplguin--ps-20260813-164230-616f0d--source.zip` plus Patch 001-008 as the only parent state.
- Preserve the existing architecture, technology stack, matching order, and fail-closed behavior.
- Do not add dependencies.
- Do not modify `.patch-session.json`.
- Do not run git commit, git push, or git clone.
- Patch 009 must use `SEQUENCE=9` and `PARENT_SEQUENCE=8`.

---

### Task 1: Add the versioned selector profile registry

**Files:**
- Create: `src/shared/selector-registry.js`
- Test: `tests/selector-registry.test.js`

**Interfaces:**
- Produces: `ACTIVE_SELECTOR_PROFILE_ID`, `getSelectorProfile(id)`, `getActiveSelectorProfile()`, `getActiveSelectorProfileMetadata()`.
- Failure: unknown profile IDs throw `RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE)`.

- [x] Write tests proving the default profile id/version are stable, selector/pattern ordering matches the current behavior, returned profile data is immutable, and unknown profile IDs fail closed.
- [x] Run `node --test tests/selector-registry.test.js` and confirm RED because the registry does not exist.
- [x] Implement the single `chatgpt-semantic-v1` profile with the current selector strings and multilingual regex patterns.
- [x] Re-run `node --test tests/selector-registry.test.js` and confirm GREEN.

### Task 2: Route current content automation through the active profile

**Files:**
- Modify: `src/content/selectors.js`
- Modify: `src/content/project-manager.js`
- Modify: `src/content/composer.js`
- Modify: `src/content/page-access-guard.js`
- Test: `tests/selector-profile-wiring.test.js`
- Existing regression tests: `tests/project-manager-actions.test.js`, `tests/composer.test.js`, `tests/page-access-guard.test.js`, `tests/model-state-observer.test.js`

**Interfaces:**
- Consumes: `getActiveSelectorProfile()`.
- Behavior: current selector/pattern order and multilingual matching remain unchanged.

- [x] Write a wiring test that proves the four modules consume the registry rather than defining independent selector/pattern lists.
- [x] Run the wiring/regression tests and confirm RED only for the new registry wiring expectation.
- [x] Replace local selector/pattern constants with references from the active profile, keeping module behavior unchanged.
- [x] Re-run the wiring/regression tests and confirm GREEN.

### Task 3: Expose privacy-safe selector profile metadata

**Files:**
- Modify: `src/content/content-script.js`
- Modify: `src/background/ui-diagnostics.js`
- Modify: `src/shared/runner-status.js`
- Modify: `tests/ui-diagnostics-integration.test.js`
- Modify: `tests/runner-status.test.js`

**Interfaces:**
- `CHATGPT_UI_DIAGNOSTICS` returns `{ selectorProfile: { id, version }, controls: [...] }`.
- `GET_RUNNER_STATUS` includes `selector_profile: { id, version }` at top level.
- Neither API returns selector patterns, conversation text, Task prompts, API tokens, or lease tokens.

- [x] Update tests first to require profile metadata while preserving the privacy assertions.
- [x] Run the focused tests and confirm RED.
- [x] Wrap content diagnostics with profile metadata, adapt background diagnostics to the new shape, and add profile metadata to the runner status projection.
- [x] Re-run focused tests and confirm GREEN.

### Task 4: Synchronize docs/version and verify Patch 009

**Files:**
- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`

**Interfaces:**
- Version becomes `0.12.0`.
- M13 selector registry/versioning item is marked complete; live calibration and privacy-safe error diagnostics/telemetry remain pending.

- [x] Update documentation to describe `chatgpt-semantic-v1`, fail-closed unknown profiles, and metadata-only observability.
- [x] Run `npm test`.
- [x] Run `node --check` for every JavaScript file and parse every JSON file.
- [x] Run `git diff --check` against the exact Patch 008 parent state.
- [x] Confirm `.patch-session.json` is byte-identical and absent from the diff.
- [x] Generate Patch 009 with required Patch Sync metadata, then verify it on a fresh `source.zip -> 001 -> ... -> 008 -> 009` replay.
