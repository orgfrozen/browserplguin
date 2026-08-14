# Selector Calibration Delta Design

## Goal

Turn privacy-safe live calibration fingerprints into fixed structural delta codes that can guide a later selector patch without generating or mutating selectors automatically.

## Scope

- Add a versioned structural contract for the six live-calibration review surfaces.
- Compare at most three sanitized fingerprints per surface with its fixed contract.
- Emit only stable enum delta codes and bounded counts.
- Embed the delta report in the existing validation handoff bundle.
- Do not modify selector registry, DOM probes, Task execution, Popup controls, storage, or ChatGPT state.
- Do not mark any live calibration TODO complete.

## Contract model

Each surface contract is expressed only with safe structural enums already supported by calibration fingerprints. A contract may allow multiple tags/roles/types because ChatGPT controls may have equivalent semantic containers.

Surfaces:

- `resource_input`: tag `input`, type `file`.
- `project_create`: button/menuitem-like actionable control, semantic hint `new_project` when available.
- `project_settings`: button/menuitem-like actionable control, semantic hint `project_settings` or menu ancestry when available.
- `project_delete`: button/menuitem-like actionable control, semantic hint `delete` or menu ancestry when available.
- `patch_candidates`: button/link-like actionable control, semantic hint `patch_download` when available.
- `context_limit`: alert/status/dialog/region-like structural container, semantic hint `context_limit` when available.

The contract is diagnostic, not an executable selector.

## Delta codes

Only these codes may be emitted:

- `NO_FINGERPRINT_EVIDENCE`
- `NO_STRUCTURAL_CANDIDATE`
- `MULTIPLE_STRUCTURAL_MATCHES`
- `TAG_MISMATCH`
- `ROLE_MISMATCH`
- `TYPE_MISMATCH`
- `MACHINE_ID_CATEGORY_CHANGED`
- `SEMANTIC_HINT_MISMATCH`
- `ANCESTOR_CONTEXT_CHANGED`

A surface is `compatible` only when at least one candidate satisfies every required structural clause. Multiple matching candidates remain review-worthy because the selector may be ambiguous.

## Privacy

The delta module accepts only sanitized fingerprint objects and sanitizes again before comparison. Output contains only surface IDs, contract version, result enums, bounded counts, delta enum codes, and sanitized fingerprints already present in the handoff. It never emits selector strings, text, labels, URLs, attributes, DOM HTML, filenames, prompt content, tokens, or raw errors.

## Data flow

`Calibration Matrix -> Evidence Ledger -> Coverage -> Validation Handoff -> Selector Calibration Delta`

The existing handoff remains the single export artifact.

## Failure behavior

Malformed or hostile fingerprint data is reduced by the existing sanitizer. Unknown surface input is ignored. Missing evidence never becomes compatible.
