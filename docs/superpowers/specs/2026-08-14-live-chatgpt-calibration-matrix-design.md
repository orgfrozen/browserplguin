# Live ChatGPT Calibration Matrix Design

## Goal

Provide a read-only, privacy-safe calibration tool for the real ChatGPT UI so current selector compatibility can be assessed without creating/deleting Projects, sending prompts, uploading files, or clicking Patch controls.

## Scope

The matrix evaluates ten current-page surfaces:

- access
- composer
- model state
- latest assistant
- Patch candidates
- Context Limit
- Project create entry
- Project settings entry/current settings action
- Project delete row/action
- resource file input

Each surface returns exactly one status: `pass`, `unavailable`, or `incompatible`.

`unavailable` means the current page state does not expose the temporary UI needed for that check. It does not mean the selector is broken. `incompatible` is reserved for structural ambiguity or a collector error that prevents a safe unique interpretation.

## Privacy boundary

The result may contain selector profile id/version, page category, access-status enum, safe state/stage enums and candidate counts. It must not contain chat text, Project names, Prompt text, attachment/file names, URLs/query/hash, API/lease tokens, raw aria/title/placeholder values, or selector-registry contents.

## Side-effect boundary

The calibration command performs no clicks, form edits, Project mutations, prompt sends, file uploads, Patch downloads, Task claims, API writes or settings writes. It remains callable on login/challenge pages so access incompatibility can be diagnosed.

## UI

Popup exposes a `Run UI Calibration` action and a fixed matrix. Results are rendered into predetermined rows rather than dumping the raw DOM or diagnostics payload.

## Non-goals

This tool does not mark any real-page calibration TODO complete. Actual M4/M5/M6/M7/M8/M9 calibration remains pending until the extension is run against the current real ChatGPT UI and the relevant page state is observed.
