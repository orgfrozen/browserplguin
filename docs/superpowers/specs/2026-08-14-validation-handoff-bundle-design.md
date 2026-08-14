# Validation Handoff Bundle Design

## Goal

Create one privacy-safe JSON handoff that summarizes the real-browser validation evidence already collected by the extension, so a later review can diagnose remaining production blockers without exporting several separate reports or exposing page/task/file data.

## Scope

The bundle is read-only. It must not click ChatGPT, claim a task, mutate transfer mode, promote remote production, clear evidence, upload evidence, or mark TODO items complete.

## Inputs

The background layer must calculate inputs fresh when requested:

- calibration coverage report for the six required selector surfaces;
- Resource E2E evidence summary;
- Remote E2E evidence summary;
- remote production mode summary;
- live Remote E2E preflight result;
- the same safe fields used by production release readiness; the bundle recomputes readiness/blockers instead of trusting a copied ready flag.

## Output contract

The bundle has a version, generated timestamp, one fixed `next_action` enum, release-ready boolean/status, and whitelist-projected summaries of the inputs above. It may include fixed surface IDs, fixed result/status enums, non-negative counters, booleans, selector profile id/version, page-category enum, and allowlisted blocker codes.

It must never include recent raw runs, DOM/chat text, Project/Task/Session IDs, resource/API URLs, filenames, local paths, prompts/responses, Patch bytes/base64, receipts, tokens, lease values, extension ID, raw error strings, or unknown injected fields/blockers.

## Next-action precedence

Use one deterministic action so the operator has a single next step:

1. `CALIBRATE_UI` when required UI coverage is incomplete or needs review.
2. `RUN_RESOURCE_E2E` when Resource E2E has no passing evidence.
3. `FIX_REMOTE_PREFLIGHT` when live remote preflight is blocked, because both Remote E2E and production promotion depend on a ready environment.
4. `RUN_REMOTE_E2E` when preflight is ready but Remote E2E has no passing evidence.
5. `PROMOTE_REMOTE` when remote has passed but production mode is not enabled.
6. `RELEASE_REVIEW` when all release-readiness requirements are satisfied.

## UI

Popup gets one `Download validation handoff` button near Production Readiness. It requests a fresh bundle from the service worker and downloads JSON locally. No automatic upload or clipboard write.

## Testing

TDD must cover hostile/extra input fields, unknown blockers, next-action precedence, fresh preflight wiring, and Popup download wiring. Existing release/readiness behavior must remain unchanged.
