# Diagnostic Screenshot Safety Policy Design

## Goal

Define an executable privacy contract for any future diagnostic screenshot feature without enabling screenshot capture in this version.

## Safety Boundary

Screenshot capture remains disabled. No code in this change calls `chrome.tabs.captureVisibleTab`, canvas/image encoders, OCR, or network upload APIs.

A future implementation may only proceed after explicit user opt-in and must pass the policy gate below:

- Only `UI_SELECTOR_INCOMPATIBLE` is eligible; login/challenge errors are not.
- Access state must be `READY` and page category must be `chat`.
- Full-page capture is forbidden.
- Arbitrary/free-coordinate capture is forbidden.
- Only predetermined semantic control-region categories may be requested.
- Redaction is mandatory before persistence/export; only an opaque solid-mask strategy is allowed by policy v1.
- OCR, text extraction, DOM text injection, raw aria/title/placeholder capture, and automated upload are forbidden.
- Policy v1 does not store consent and does not implement capture; `capture_enabled` is always `false`.

## Interfaces

`src/shared/diagnostic-screenshot-policy.js` exposes a fixed policy document and a request evaluator. The evaluator returns only fixed enums/booleans and never echoes caller input.

The background exposes `GET_DIAGNOSTIC_SCREENSHOT_POLICY`. Options renders the safe policy state so operators can see that screenshots remain disabled and what a future implementation would have to satisfy.

## Privacy

The policy response contains no Task, Project, Session, URL, file, Prompt, conversation, DOM text, selector detail, token, path, screenshot bytes, or arbitrary caller-provided string.

## Non-goals

- No screenshot capture.
- No consent toggle.
- No screenshot storage/export/upload.
- No OCR or redaction engine implementation.
- No change to current DOM diagnostics or telemetry behavior.
