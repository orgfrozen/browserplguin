# Privacy-safe Selector Calibration Fingerprint Design

## Goal

Make real ChatGPT selector calibration actionable without screenshots, DOM dumps, prompt text, project names, URLs, or other free text by attaching bounded structural fingerprints to existing calibration evidence and the single validation handoff bundle.

## Scope

Patch 028 adds read-only structural fingerprints only. It does not change selectors, click controls, create/delete projects, upload files, claim tasks, change Task API behavior, enable screenshots, or mark any live-calibration TODO complete.

## Architecture

1. `src/content/ui-semantics.js` exposes a privacy-safe fingerprint primitive that projects DOM nodes onto a strict structural allowlist.
2. `src/content/calibration-matrix.js` attaches bounded fingerprints to calibration checks. Exact matched candidates are preferred; when a surface is unavailable, a bounded same-class candidate sample may be included so the next selector patch has structural evidence.
3. `src/background/calibration-evidence-ledger.js` stores only the latest safe fingerprint set per surface alongside existing aggregate counts. Recent raw DOM is never stored.
4. `src/shared/calibration-coverage.js` carries only sanitized latest fingerprints for the six review surfaces.
5. `src/shared/validation-handoff.js` re-sanitizes fingerprints before putting them in the existing single validation handoff bundle.

## Fingerprint Allowlist

A fingerprint may contain only:

- `tag`: normalized HTML tag from a fixed safe set or `other`.
- `role`: normalized machine role if short/simple; otherwise `[redacted]`.
- `type`: normalized input/button type if short/simple; otherwise `[redacted]`.
- `test_id_category`: fixed semantic category derived from `data-testid`, or `present_unknown` / `absent`; the raw attribute is never exported.
- `name_category`: fixed semantic category derived from `name`, or `present_unknown` / `absent`; the raw attribute is never exported.
- `semantic_hint`: fixed enum such as `new_project`, `project_settings`, `delete`, `menu`, `attach`, `send`, `stop`, `context_limit`, `patch_download`, or `unknown`.
- `ancestor_roles`: at most three normalized ancestor role/tag categories.

The matrix stores at most three fingerprints per surface.

## Explicitly Forbidden

Fingerprints must never include raw or hashed:

- `textContent`, inner text, assistant/user message text.
- `aria-label`, `title`, or `placeholder` values.
- `value` or input content.
- `href`, hostname, path, query, fragment, blob URL, or download URL.
- project/task/session names or IDs.
- resource/Patch/attachment filenames.
- local filesystem paths.
- API/lease tokens, receipts, or raw error messages.
- CSS selectors, XPath, outerHTML, innerHTML, classes, style, dataset dumps, screenshots, OCR, or image data.

## Surface Mapping

The fingerprint tooling is most important for the six live-review surfaces:

- `context_limit`
- `patch_candidates`
- `project_create`
- `project_settings`
- `resource_input`
- `project_delete`

Auxiliary surfaces may also carry fingerprints when useful, but they do not change release coverage requirements.

## Fail-closed Rules

- Unknown/malformed machine attributes become `[redacted]` or `null`.
- Unknown semantic text becomes `unknown`; the raw text is not retained.
- No more than three fingerprints are retained per surface.
- The ledger and handoff each independently re-sanitize the structure; callers cannot inject arbitrary keys or strings.
- Fingerprinting failure must not cause live calibration itself to fail.

## Testing

Tests must prove:

- secrets in text/aria/title/placeholder/value/href never appear in fingerprints;
- long/random machine attributes are redacted;
- fingerprint count is bounded;
- calibration matrix remains read-only;
- evidence ledger persists only the allowlist and drops hostile injected keys;
- validation handoff re-sanitizes hostile stored fingerprints;
- all existing tests remain green.

## Roadmap semantics

Patch 028 marks only the calibration-fingerprint tooling complete. All eight live ChatGPT/Resource/Remote E2E TODO items remain open until real evidence is collected.
