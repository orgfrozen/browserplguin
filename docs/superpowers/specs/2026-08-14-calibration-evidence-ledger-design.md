# Calibration Evidence Ledger Design

## Goal

Persist privacy-safe evidence from each Live Calibration Matrix run so real ChatGPT UI calibration can accumulate trustworthy local proof across page states without storing page text or secrets.

## Scope

Patch 020 adds only local evidence recording and presentation. It does not click or mutate ChatGPT UI, does not claim Tasks, does not change selectors, does not upload telemetry, and does not mark any live-calibration TODO complete.

## Data model

The ledger is stored in `chrome.storage.local` under `calibrationEvidenceLedger` with schema version 1.

Each recorded run stores only:

- timestamp;
- selector profile `{ id, version }` after strict validation;
- page category from a fixed enum;
- access status from a fixed enum;
- fixed calibration surface ids;
- per-surface status from `pass / unavailable / incompatible`.

The ledger also keeps per-surface aggregate counts and the latest status/page category. Recent runs are bounded to 20 entries.

The ledger never stores matrix `evidence` objects, DOM text, Project names, Prompt text, URLs, query/hash, filenames, API tokens, lease tokens, Extension IDs, local paths, or arbitrary error strings.

## Recording flow

`RUN_CHATGPT_CALIBRATION` continues to run the existing read-only matrix. After a successful matrix response, Background records the sanitized result in the ledger and returns the matrix unchanged to Popup.

A ledger write failure must not replace or invalidate the matrix result; calibration remains usable even if local evidence persistence fails.

## Read / clear flow

Background exposes:

- `GET_CALIBRATION_EVIDENCE` — returns the privacy-safe aggregate and bounded recent runs.
- `CLEAR_CALIBRATION_EVIDENCE` — clears only the ledger key.

Popup shows total recorded runs and one compact row per fixed surface: latest status plus pass/run counts. A clear button explicitly deletes local calibration evidence.

## Safety and failure handling

- Unknown surface ids are ignored.
- Unknown statuses are normalized to `incompatible` for known surfaces.
- Unknown page/access values become fixed `other/UNKNOWN` values.
- Selector profile metadata is strictly validated and otherwise becomes `{ id: "unknown", version: null }`.
- Concurrent writes are serialized.
- Recent run storage is bounded to 20 entries.
- No remote upload is introduced.

## Testing

Tests must prove aggregation, bounded history, concurrency-safe updates, free-text stripping, service-worker wiring, automatic recording after matrix execution, clear behavior, and Popup evidence rendering.
