# Context Limit Terminal Status Design

## Goal

Represent ChatGPT context exhaustion as a first-class terminal Task status in the real Task API and in the extension UI, instead of treating it as an ordinary failed Task whose payload merely happens to contain `terminal_status=context_limit`.

## Architecture

Add a dedicated `contextLimitTask(taskId, result)` Task API operation. The HTTP client sends the exact terminal payload to `POST /tasks/{task_id}/context-limit` with the same lease and canonical idempotency contract as complete/fail/release. The mock API records Task status `context_limit` and a `CONTEXT_LIMIT` event.

`TaskRunner` uses durable `terminal_action=CONTEXT_LIMIT` for newly detected chat/context exhaustion. Cleanup ordering does not change: the one temporary Project must be deleted before the terminal request is sent. `TERMINAL_PENDING` persists the exact payload so a lost response can be retried idempotently.

Crash recovery remains backward compatible with v0.17 and older durable checkpoints: an already-persisted `terminal_action=FAIL` carrying `terminal_status=context_limit` is retried through the original fail endpoint rather than rewritten to the new endpoint. If only `terminal_reason=CHAT_LENGTH_LIMIT` exists and no action was persisted, recovery chooses the new `CONTEXT_LIMIT` action.

## UI

`GET_RUNNER_STATUS` continues to expose only compact, privacy-safe metadata. The Popup adds a `Last Run` row using the existing compact last-run object. A completed Context Limit therefore appears as `context_limit · <task_id> · CHAT_LENGTH_LIMIT`. Active cleanup/terminal-pending state continues to expose `terminal_reason` and `terminal_action` without Prompt or error-message bodies.

## Error and lock behavior

- Context Limit is terminal but non-successful.
- The server lease is cleared only after `/context-limit` succeeds.
- Network/server failure leaves `TERMINAL_PENDING` locked with the exact payload.
- Cleanup failure remains `CLEANUP` and no terminal endpoint is called.
- No second Project, Session, or recovery Prompt is created for a Context Limit Task.

## Compatibility

The protocol remains `X-Task-Protocol-Version: 1`; this Patch adds one endpoint/action without changing existing complete/fail/release payloads. Legacy persisted FAIL checkpoints are explicitly supported.

## Testing

Tests must prove the dedicated endpoint/header/idempotency behavior, normal and initialization-time Context Limit routing, terminal retry/recovery, legacy FAIL recovery compatibility, mock server status, status-view privacy, and Popup Last Run rendering.
