# Remote E2E Evidence Design

## Goal

Record privacy-safe local evidence when a real Remote E2E test-mode Task actually demonstrates the remote Patch chain end to end, without changing Task success semantics or prematurely enabling production remote mode.

## Scope

This feature applies only when both `remoteE2eTestMode=true` and `patchTransferMode=remote` for a real runner. Mock runs and normal local runs never create Remote E2E evidence.

A run counts as `passed` only when one uninterrupted execution witnesses all of the following in order-independent aggregate terms:

1. At least one Patch transfer completed in `remote` mode.
2. At least one corresponding artifact metadata report succeeded.
3. Task-owned Project cleanup completed.
4. The final terminal API succeeded with action `COMPLETE`.

A recovered run that did not witness the earlier remote transfer/report in the same in-memory evidence tracker cannot be promoted to `passed`; it is recorded conservatively as incomplete/failed evidence.

## Architecture

`TaskRunner` gains an optional observer with narrowly-scoped lifecycle callbacks. The observer is non-authoritative: callback failures are swallowed and never alter Task behavior. A real remote test-mode runner receives an in-memory `RemoteE2eRunTracker`; other runners use no observer.

The tracker records only booleans/counts and stable enums during execution. After `runOnce()` or `recoverOnce()` returns (or throws), the Service Worker finalizes the tracker and writes one sanitized record through `RemoteE2eEvidenceLedger` in `chrome.storage.local`.

## Evidence Model

Persisted summary:

- `version`
- `total_runs`
- `passed_runs`
- `failed_runs`
- `last_run`
- bounded `recent_runs` (maximum 20)

Each run record contains only:

- `at`
- `result`: `passed | failed | incomplete`
- `failure_stage`: one of `remote_transfer | artifact_report | cleanup | terminal | task_result | recovery | none`
- `remote_transfer_count`
- `artifact_report_count`
- `cleanup_completed`
- `terminal_action`: fixed enum or `null`
- `terminal_status`: fixed enum or `null`
- `runner_status`: fixed enum or `unknown`

It must not persist task IDs, Project/session names, URLs, tokens, local paths, filenames, Patch bytes, receipts, server payloads, free-form error text, or Native Messaging error text.

## Observer Events

`TaskRunner` may emit the following best-effort observer methods:

- `onRemoteTransfer()` after `ArtifactTransferManager.transfer()` returns mode `remote`.
- `onArtifactReported()` only after `taskApi.reportArtifact()` succeeds for a remote artifact.
- `onCleanupCompleted()` after cleanup returns success.
- `onTerminalSucceeded({ action, status })` only after the terminal API succeeds.

Observer errors are ignored.

## Pass / Failure Classification

`passed` requires:

- tracker enabled,
- `remote_transfer_count >= 1`,
- `artifact_report_count >= 1`,
- `cleanup_completed === true`,
- `terminal_action === COMPLETE`,
- final runner status `completed`.

Otherwise classify conservatively by the first missing required stage. A recovery invocation cannot pass unless it itself witnessed every required stage.

## UI

Popup adds a compact `Remote E2E Evidence` section showing total runs, passed runs, latest result, latest failure stage and stage counts. It also exposes a clear action that removes only Remote E2E evidence.

The regular remote option remains disabled. Evidence does not automatically change settings or complete `TODO.md`.

## Testing

Tests cover tracker classification, sanitization/bounds, observer ordering, observer failure isolation, real-run wiring, Popup display/clear, and the invariant that local/mock runs do not create evidence.
