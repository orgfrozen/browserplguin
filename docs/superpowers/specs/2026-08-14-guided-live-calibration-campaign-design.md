# Guided Live Calibration Campaign Design

## Goal

Turn the existing privacy-safe calibration evidence into a deterministic, read-only manual validation campaign for the six ChatGPT selector surfaces that still require live calibration.

## Scope

The campaign covers exactly these surfaces, in workflow-oriented order:

1. `project_create`
2. `project_settings`
3. `resource_input`
4. `patch_candidates`
5. `context_limit`
6. `project_delete`

It does not cover Resource E2E or Remote E2E execution; those already have dedicated evidence recorders and readiness gates.

## Non-goals

- No automatic ChatGPT clicks, navigation, menu opening, Project creation/deletion, prompt sending, or file upload.
- No new selector logic and no selector mutation.
- No new persistent campaign state; the campaign is derived from the existing `CalibrationEvidenceLedger`.
- No screenshots, OCR, DOM text, Project names, URLs, filenames, Prompt content, or free-form error text.
- Campaign completion does not edit `TODO.md`, promote remote mode, or claim a Task.

## Campaign state

Each stage is a fixed projection with:

- `id`: one of the six fixed surface ids.
- `instruction_code`: fixed enum describing what the user should manually expose in ChatGPT.
- `expected_page_categories`: fixed enum array.
- `status`: `pending`, `needs_review`, or `observed`.
- `pass_count`, `total_runs`, `latest_status`, `latest_page_category`.
- `fingerprint_count`: count only; the detailed safe fingerprints remain in the existing handoff/coverage report.

Status rules:

- `needs_review` if the latest calibration status is `incompatible`, regardless of historical pass count.
- `observed` if `pass_count > 0` and latest status is not `incompatible`.
- otherwise `pending`.

The current target is the first stage in the fixed order whose status is not `observed`. A `needs_review` stage blocks advancing past it.

## Instruction codes

- `SHOW_PROJECT_CREATE_CONTROL`
- `OPEN_PROJECT_SETTINGS_CONTROL`
- `SHOW_RESOURCE_INPUT_CONTROL`
- `SHOW_ASSISTANT_PATCH_CONTROL`
- `SHOW_CONTEXT_LIMIT_STATE`
- `OPEN_PROJECT_DELETE_CONTROL`

These are stable machine enums. Human-readable UI copy is local static text in Popup and is not persisted.

## Read-only capture flow

`Capture current state` reuses `RUN_CHATGPT_CALIBRATION`:

1. Read current ChatGPT DOM via the existing calibration matrix.
2. Persist the already-sanitized calibration evidence.
3. Rebuild campaign state from the updated ledger.
4. Refresh coverage/readiness UI.

The capture command does not click or mutate ChatGPT.

## Privacy and safety

The campaign builder accepts hostile ledger input but only projects fixed ids/enums/counts/timestamps. It does not return detailed fingerprints, free-form strings, recent runs, selector text, or stored arbitrary fields. Unknown status/page values are reduced to safe null/default values.

## Version

This change targets extension version `0.32.0`.
