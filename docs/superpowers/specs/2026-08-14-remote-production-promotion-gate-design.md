# Remote Production Promotion Gate Design

## Goal

Permit production remote Patch transfer only after this browser profile has recorded at least one successful real Remote E2E evidence run and the current live remote preflight still passes.

## State model

Remote transfer has three explicit states:

- local: `patchTransferMode=local`, both remote flags false.
- E2E test: `patchTransferMode=remote`, `remoteE2eTestMode=true`, `remoteProductionMode=false`.
- production remote: `patchTransferMode=remote`, `remoteE2eTestMode=false`, `remoteProductionMode=true`.

The two remote flags are mutually exclusive. Ordinary `SAVE_SETTINGS` always returns to local so configuration changes cannot retain stale remote authorization.

## Promotion requirements

Promotion is an explicit Options action. It succeeds only when:

1. the local Remote E2E Evidence Ledger reports `passed_runs >= 1`;
2. a fresh live Remote E2E preflight reports `ready_for_remote_e2e=true`.

No Task is claimed by promotion. The response exposes only fixed booleans/counts/blocker codes and never Task API URLs, tokens, Extension IDs, local paths, Patch data, or native-host raw errors.

## Pre-claim production guard

Every `RUN_REAL_ONCE` with production remote selected rechecks, before Task claim:

- production/test flags are not conflicting;
- the Evidence Ledger still has at least one passed run;
- a fresh live preflight is still ready.

Clearing evidence therefore blocks future production remote claims immediately. Existing active executions remain recoverable: recovery does not run the promotion gate because changing settings/evidence must not strand a claimed Task.

## UI

Options shows a Remote Production section with eligibility, passed-evidence count, promote, and return-to-local controls. The ordinary remote select remains disabled by default and is enabled only while production remote is currently active. Popup exposes only a boolean production-mode state.

## Non-goals

- Do not claim that real Remote E2E has already passed.
- Do not automatically promote after evidence appears.
- Do not change remote upload, Native Helper, recovery, or Task terminal semantics.
- Do not upload evidence remotely.
