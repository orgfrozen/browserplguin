# Remote E2E Test Mode Design

## Goal

Allow the first real remote Patch end-to-end run without promoting remote transfer to a generally supported production option.

## Design

Remote transfer remains a gated test capability. The only supported transition from local to remote is an explicit `ENABLE_REMOTE_E2E_TEST_MODE` command. That command reruns the existing live Remote E2E Preflight and enables test mode only when every prerequisite is currently ready. Disabling test mode atomically returns the transfer mode to local.

`RUN_REAL_ONCE` must not trust a previously stored preflight. When `patchTransferMode=remote`, RuntimeController invokes a pre-claim guard before constructing/running TaskRunner. The guard requires `remoteE2eTestMode=true` and reruns the live preflight. A blocked preflight stops before Task claim or any ChatGPT UI action.

Normal `SAVE_SETTINGS` is never an alternate remote enable path. Any ordinary settings save clears `remoteE2eTestMode` and forces `patchTransferMode=local`, so changes to mode/API configuration require an explicit fresh preflight + re-enable cycle.

## Privacy and safety

The test-mode result may expose only stable status/blocker codes and transfer mode. It must not return or persist Task API tokens, API URLs, Extension IDs, local file paths, Native Messaging error text, Patch bytes, or Task content.

## UI

Options keeps the regular `remote` select option disabled. A separate Remote E2E Test Mode control shows enabled/disabled state and explicit enable/disable buttons. Enabling reruns preflight. The Popup runner status may show the safe transfer mode/test-mode booleans.

## Non-goals

- Do not mark real remote E2E complete.
- Do not permanently enable the normal remote option.
- Do not claim a Task as part of enablement.
- Do not read or upload a Patch as part of enablement.
- Do not change recovery semantics for already-active Tasks.
