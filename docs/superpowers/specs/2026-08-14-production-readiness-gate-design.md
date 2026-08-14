# Production Readiness Gate Design

## Goal

Aggregate the existing live-calibration, Resource E2E, Remote E2E, remote production-mode, and live remote preflight evidence into one privacy-safe release-review gate. The gate must never create evidence, modify settings, claim a Task, or mark TODO items complete.

## Readiness requirements

A report is `ready_for_release_review=true` only when all required conditions are true:

1. Calibration coverage reports all six required selector surfaces covered and none needs review.
2. Resource E2E Evidence has at least one passed run.
3. Remote E2E Evidence has at least one passed run.
4. Remote Production is currently enabled (`patchTransferMode=remote`, `remoteProductionMode=true`, test mode false).
5. A fresh, side-effect-free Remote E2E preflight is ready at report time.

The optional screenshot/redaction TODO is not a release gate.

## Stable blockers

The gate returns only these top-level blocker codes:

- `CALIBRATION_INCOMPLETE`
- `CALIBRATION_NEEDS_REVIEW`
- `RESOURCE_E2E_REQUIRED`
- `REMOTE_E2E_REQUIRED`
- `REMOTE_PRODUCTION_REQUIRED`
- `REMOTE_PREFLIGHT_BLOCKED`

Remote preflight may additionally expose its existing fixed blocker-code array inside the safe remote-preflight projection.

## Privacy-safe report

The report is a whitelist projection containing only:

- generated timestamp;
- readiness boolean/status;
- fixed blocker codes;
- calibration required/covered/missing/review counts;
- Resource E2E total/passed counts;
- Remote E2E total/passed counts;
- production-remote enabled boolean;
- remote-preflight ready boolean and fixed blocker codes.

It must not copy recent runs, DOM evidence, Task/Project/Session identifiers, URLs, filenames, paths, prompt/response text, Patch bytes, tokens, lease data, or raw error messages.

## Integration

`GET_RELEASE_READINESS` builds fresh calibration coverage from the local ledger, reads both E2E evidence ledgers, reads current settings/production state, runs the existing live Remote E2E preflight, and returns the safe report.

Popup displays the readiness summary and five requirement rows, and offers a `Download safe release report` action using the already-safe report object.

## Non-goals

- No automatic TODO mutation.
- No automatic production promotion.
- No Task claim or ChatGPT action.
- No screenshots.
- No server upload of readiness/evidence.
