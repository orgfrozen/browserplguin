# Selector Calibration Fingerprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry privacy-safe structural DOM fingerprints through Calibration Matrix → Evidence Ledger → Validation Handoff so a real Chrome handoff is actionable for selector fixes without DOM text or screenshots.

**Architecture:** Reuse the existing calibration pipeline and add no new remote or automation behavior. A content-side structural sanitizer produces bounded fingerprints; the ledger and handoff each re-sanitize before persistence/export.

**Tech Stack:** Chrome MV3 JavaScript, Node `node:test`, existing selector/calibration modules.

## Global Constraints

- Patch sequence is 028 with parent 027.
- No commit, push, or clone.
- `.patch-session.json` is read-only and must not appear in the Patch diff.
- No raw text, aria/title/placeholder values, URL, file names, identifiers, tokens, DOM HTML, screenshots, OCR, or image bytes in fingerprints.
- Maximum three fingerprints per surface.
- Existing 8 live-environment TODO items must remain unchecked.

---

### Task 1: Safe structural fingerprint primitive

**Files:**
- Modify: `src/content/ui-semantics.js`
- Test: `tests/selector-calibration-fingerprint.test.js`

**Produces:** `buildSafeCalibrationFingerprint(node)` and bounded helper(s) returning allowlisted structural fields only.

- [x] Write tests with secrets in text, aria-label, title, placeholder, value, href, machine IDs/names, and ancestor nodes; assert only fixed categories are exported, never raw machine attributes.
- [x] Run the focused test and confirm RED because the fingerprint API does not exist.
- [x] Implement minimal structural sanitization and fixed semantic hints.
- [x] Run focused tests and confirm GREEN.

### Task 2: Attach fingerprints to Calibration Matrix

**Files:**
- Modify: `src/content/calibration-matrix.js`
- Modify: `tests/calibration-matrix.test.js`
- Test: `tests/selector-calibration-fingerprint.test.js`

**Consumes:** Task 1 fingerprint primitive.
**Produces:** `check.evidence.fingerprints` with at most three safe structures.

- [x] Add RED tests for incompatible candidate fingerprints, unavailable same-class samples, bounded output, and no clicks.
- [x] Run focused tests and confirm RED.
- [x] Add minimal fingerprint attachment to relevant probes without changing status semantics.
- [x] Run focused tests and confirm GREEN.

### Task 3: Persist only latest safe fingerprints

**Files:**
- Modify: `src/background/calibration-evidence-ledger.js`
- Modify: `tests/calibration-evidence-ledger.test.js`

**Consumes:** Matrix evidence fingerprints.
**Produces:** per-surface `latest_fingerprints` sanitized and bounded to three.

- [x] Add RED tests with hostile extra keys/free text in matrix fingerprints.
- [x] Run focused test and confirm RED.
- [x] Re-sanitize fingerprints in ledger persistence.
- [x] Run focused tests and confirm GREEN.

### Task 4: Carry fingerprints through coverage and the single validation handoff

**Files:**
- Modify: `src/shared/calibration-coverage.js`
- Modify: `tests/calibration-coverage.test.js`
- Modify: `src/shared/validation-handoff.js`
- Modify: `tests/validation-handoff.test.js`

**Consumes:** Ledger per-surface `latest_fingerprints`.
**Produces:** handoff `calibration.surfaces[id].fingerprints` with the same strict allowlist.

- [x] Add RED hostile-storage tests proving arbitrary keys/free strings cannot escape through the handoff.
- [x] Run focused tests and confirm RED.
- [x] Add independent handoff sanitizer and bounded projection.
- [x] Run focused tests and confirm GREEN.

### Task 5: Version/docs/roadmap and full verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `src/manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-08-13-chatgpt-browser-extension-design.md`

- [x] Bump version to 0.31.0 everywhere.
- [x] Mark only the safe selector-calibration fingerprint tooling complete; keep all 8 live-environment TODO items open.
- [x] Run full tests, JS/MJS syntax checks, JSON parsing, privacy scan, version checks, and `.patch-session.json` hash check.
- [x] Generate Patch 028 against exact parent `source + 001…027` and run `git diff --check`.
- [x] Fresh replay `source → 001…027 → 028`, rerun the full verification, and record final SHA-256.
