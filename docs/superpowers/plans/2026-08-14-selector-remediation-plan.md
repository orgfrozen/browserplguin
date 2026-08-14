# Selector Remediation Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic privacy-safe remediation plan derived from Selector Calibration Delta and embed it in the existing validation handoff.

**Architecture:** A new pure shared module maps fixed delta codes to fixed remediation action codes and fixed existing-code edit targets. `validation-handoff.js` embeds the result without altering readiness or next-action semantics.

**Tech Stack:** JavaScript ES modules, Node `node:test`, existing shared validation-handoff pipeline.

## Global Constraints

- Base state is source ZIP plus Patches 001–030.
- Do not commit or push.
- Do not generate selectors, XPath, regex, DOM text, URLs, or executable patch instructions.
- Do not add storage, Service Worker commands, browser permissions, ChatGPT writes, or readiness blockers.
- `.patch-session.json` is read-only and must not enter the Patch diff.

---

### Task 1: Pure selector remediation mapper

**Files:**
- Create: `src/shared/selector-remediation-plan.js`
- Create: `tests/selector-remediation-plan.test.js`

**Interfaces:**
- Consumes: `selector_calibration_delta` v1.
- Produces: `buildSelectorRemediationPlan(delta, { now })` and fixed action enums.

- [x] Write failing tests for missing evidence, hard mismatch, soft change, ambiguity, no-change, hostile input, fixed edit targets, and no executable selector output.
- [x] Run focused tests and verify RED because the module does not exist.
- [x] Implement the minimal fixed-enum mapper.
- [x] Run focused tests and verify GREEN.

### Task 2: Validation handoff integration

**Files:**
- Modify: `src/shared/validation-handoff.js`
- Modify: `tests/validation-handoff.test.js`

**Interfaces:**
- Consumes: the already-built safe selector delta.
- Produces: `selector_remediation_plan` inside the existing handoff bundle.

- [x] Write a failing handoff test requiring the remediation plan while proving release readiness and `next_action` are unchanged.
- [x] Run focused tests and verify RED.
- [x] Embed the pure remediation plan with the handoff timestamp.
- [x] Run focused tests and verify GREEN.

### Task 3: Version, roadmap, and release verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-web-task-runner-design.md`

- [x] Bump version to 0.34.0 and mark only the Selector Remediation Plan tooling item complete; keep all eight real-environment TODOs open.
- [x] Run the full test suite, JS/MJS syntax checks, JSON parsing, privacy scans, TODO checks, and session hash check.
- [x] Generate candidate Patch 031 against exact parent source+001–030 and replay it from scratch.
- [x] Mark packaging/replay plan items complete, regenerate formal Patch 031, and replay the formal Patch from scratch.
