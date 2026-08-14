# Resource E2E Evidence Recorder Design

## Goal

Record privacy-safe local proof for a real Task resource initialization without changing Task execution semantics or pretending that live ChatGPT calibration has already passed.

## Scope

The recorder applies only to real Tasks that actually enter the `task.resource` initialization path. A non-resource Task produces no resource E2E evidence. Recovery does not infer unseen pre-restart initialization stages.

A `passed` record requires the same uninterrupted runner invocation to witness all of these successful boundaries:

1. resource initialization started;
2. `ResourceLoader.load()` completed, which implies the exact-origin permission gate and resource download/validation succeeded;
3. `CHATGPT_ATTACH_RESOURCE` returned, which implies the composer attachment readiness wait completed;
4. the initialization prompt returned a non-Context-Limit response;
5. `initialization_completed=true` was durably saved and `TASK_INITIALIZED` was reported successfully.

The evidence recorder is non-authoritative: observer or storage failures must never change Task success/failure.

## Evidence states

`result` is one of `passed`, `failed`, or `incomplete`.

`failure_stage` is one of:

- `permission`
- `download`
- `attachment`
- `initialization_prompt`
- `initialization_persist`
- `recovery`
- `none`

The tracker derives the stage from witnessed milestones and a bounded error-code classification. It never stores the original error message.

## Data model and privacy

The ledger stores only:

- timestamp;
- result/failure-stage enums;
- five stage booleans (`started`, `downloaded`, `attached`, `response_ready`, `initialization_completed`);
- bounded runner-status enum.

It must not store Task ID, Project/Session names, resource URL/origin, filename, MIME type, file bytes/base64, Prompt/response text, API/lease tokens, DOM text, or raw error messages.

Recent runs are bounded to 20 while aggregate `total_runs`, `passed_runs`, and `failed_runs` remain cumulative. Clear removes only the resource evidence key.

## Integration

`BrowserPageDriver.initializeTask()` accepts optional hooks and calls `onResourceDownloaded` only after `ResourceLoader.load()` succeeds, and `onResourceAttached` only after `CHATGPT_ATTACH_RESOURCE` returns.

`TaskRunner` proxies those successful page hooks through its existing non-authoritative observer, emits `onResourceInitializationStarted` before initialization, `onResourceInitializationResponseReady` after a normal non-context-limit initialization response, and `onResourceInitializationCompleted` only after durable initialization state persistence plus successful `TASK_INITIALIZED` progress reporting.

The Service Worker creates one resource tracker per real runner invocation. It is always available for real mode but produces `null` evidence unless a resource initialization actually started. After the runner returns, it writes the sanitized result to the local ledger. Recovery does not synthesize a pass.

## UI

Popup adds a compact `Resource E2E Evidence` section with recorded runs, passed runs, latest result, and failure stage, plus a clear button. No resource identity or URL is shown.

## Acceptance

The feature is complete when unit/integration tests prove stage ordering, failure classification, observer isolation, bounded privacy-safe storage, Service Worker wiring/read/clear commands, Popup rendering, and full project regression. The existing real Chrome resource E2E TODO remains open until a live run produces actual evidence.
