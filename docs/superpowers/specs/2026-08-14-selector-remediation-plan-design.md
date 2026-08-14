# Selector Remediation Plan Design

## Goal

Convert the privacy-safe Selector Calibration Delta report into a deterministic, non-executable remediation plan that identifies what kind of selector logic must be reviewed and which existing code contract owns that logic.

## Scope

The plan covers the six live calibration surfaces: `context_limit`, `patch_candidates`, `project_create`, `project_settings`, `resource_input`, and `project_delete`.

It consumes only the already-sanitized `selector_calibration_delta` object. It does not inspect DOM, fingerprints, raw text, URLs, storage, or browser state.

## Safety boundary

The plan MUST NOT generate CSS selectors, XPath, regular expressions, DOM text, attributes, or executable patches. It MUST NOT modify `selector-registry.js`, `selectors.js`, ChatGPT DOM, Task state, readiness, or validation next action.

Outputs are limited to fixed enums:

- remediation status
- remediation action codes
- edit target identifiers that map to existing code-owned selector/pattern contracts

Unknown delta codes or hostile free-form fields are ignored.

## Remediation actions

- `COLLECT_MORE_EVIDENCE`
- `REVIEW_SURFACE_CONTRACT`
- `RETUNE_TAG_FILTER`
- `RETUNE_ROLE_FILTER`
- `RETUNE_TYPE_FILTER`
- `RETUNE_MACHINE_ID_FILTER`
- `RETUNE_SEMANTIC_HINT`
- `RETUNE_ANCESTOR_CONTEXT`
- `ADD_DISAMBIGUATION_CONTEXT`

## Surface edit targets

The identifiers are stable code-contract references, not executable selectors.

- `context_limit`
  - `conversation_manager.context_limit_detection`
  - `calibration_matrix.context_limit_scope`
- `patch_candidates`
  - `artifact_observer.patch_candidate_detection`
  - `calibration_matrix.patch_candidate_scope`
- `project_create`
  - `selector_profile.patterns.project.newProject`
  - `selector_profile.selectors.semanticButtons`
- `project_settings`
  - `selector_profile.patterns.project.projectSettings`
  - `selector_profile.patterns.project.projectMenu`
  - `selector_profile.patterns.project.more`
  - `selector_profile.selectors.semanticButtons`
- `resource_input`
  - `selector_profile.selectors.fileInputs`
- `project_delete`
  - `selector_profile.patterns.project.deleteProject`
  - `selector_profile.patterns.project.confirmDelete`
  - `selector_profile.patterns.project.projectMenu`
  - `selector_profile.patterns.project.more`
  - `selector_profile.selectors.projectAnchors`
  - `selector_profile.selectors.semanticButtons`

## Mapping rules

- `NO_FINGERPRINT_EVIDENCE` -> `COLLECT_MORE_EVIDENCE`
- `NO_STRUCTURAL_CANDIDATE` -> `REVIEW_SURFACE_CONTRACT`
- `MULTIPLE_STRUCTURAL_MATCHES` -> `ADD_DISAMBIGUATION_CONTEXT`
- `TAG_MISMATCH` -> `RETUNE_TAG_FILTER`
- `ROLE_MISMATCH` -> `RETUNE_ROLE_FILTER`
- `TYPE_MISMATCH` -> `RETUNE_TYPE_FILTER`
- `MACHINE_ID_CATEGORY_CHANGED` -> `RETUNE_MACHINE_ID_FILTER`
- `SEMANTIC_HINT_MISMATCH` -> `RETUNE_SEMANTIC_HINT`
- `ANCESTOR_CONTEXT_CHANGED` -> `RETUNE_ANCESTOR_CONTEXT`

A surface with no delta codes is `no_change`. Missing evidence is `collect_evidence`. Any structural incompatibility or ambiguity is `review_required`. Compatible soft deltas are `actionable`.

## Integration

`buildValidationHandoffBundle()` embeds the plan as `selector_remediation_plan` using the same `generated_at` timestamp as the handoff and delta report. Release readiness and `next_action` are unchanged.
