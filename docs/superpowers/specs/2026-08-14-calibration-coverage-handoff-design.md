# Calibration Coverage Gate and Safe Handoff Report Design

## Goal

Turn the existing privacy-safe Calibration Evidence Ledger into an explicit review gate for the six currently open ChatGPT selector calibration TODOs, and provide a safe JSON handoff report that can be downloaded from Popup and shared for follow-up calibration work.

## Scope

The gate covers only these open live-calibration surfaces:

- `context_limit`
- `patch_candidates`
- `project_create`
- `project_settings`
- `resource_input`
- `project_delete`

`access`, `composer`, `model_state`, and `latest_assistant` remain useful evidence but do not count toward closing the six open selector-calibration TODOs.

The gate does not complete or modify TODO.md at runtime, does not inspect the live DOM itself, and does not claim that resource E2E, remote E2E, or screenshot work is complete.

## Coverage Rules

For each required surface:

- `missing_pass`: there is no recorded `pass` evidence yet.
- `needs_review`: at least one pass exists, but the latest recorded status is `incompatible`.
- `covered`: at least one pass exists and the latest status is not `incompatible`.

A latest `unavailable` does not erase earlier pass evidence. It represents a page state where that temporary UI was not present.

`ready_for_review=true` only when all six required surfaces are `covered`. This means enough evidence exists for a human/agent to review the live-calibration TODOs; it does not automatically mark them complete.

## Safe Handoff Report

The report is derived only from the sanitized ledger summary and contains:

- schema version
- generated timestamp
- `ready_for_review`
- covered/required counts
- selector profile ids/versions already sanitized by the ledger
- each required surface's coverage state
- aggregate counts (`total_runs`, `pass_count`, `unavailable_count`, `incompatible_count`)
- latest status/page category/last-seen timestamp

The report must never include recent-run raw payloads, matrix evidence, DOM text, URLs, Project names, Prompts, file names, API/lease tokens, Extension ID, or local paths.

## Runtime/UI

Background exposes `GET_CALIBRATION_COVERAGE` and builds the report from `CalibrationEvidenceLedger.getSummary()`.

Popup displays:

- `covered N/6`
- `ready for review` or `evidence incomplete`
- a row for each required surface showing `covered / missing pass / needs review`
- `Download safe report` button that creates a local JSON Blob from the already sanitized report

Downloading the report is a Popup-local action and requires no extra extension permission.

## Failure Behavior

Malformed ledger fields are normalized fail-closed. Missing or malformed counts behave as zero. Unknown latest statuses do not create coverage. Export failure only affects the Popup action and does not mutate evidence.

## Testing

Tests cover:

- missing/unavailable-only evidence does not count as covered
- historical pass + latest unavailable remains covered
- latest incompatible overrides historical pass to needs-review
- all six covered enables ready-for-review
- report excludes non-required surfaces and unsafe fields/recent runs
- Service Worker command wiring
- Popup coverage rows and safe JSON Blob download action
- full regression suite remains green
