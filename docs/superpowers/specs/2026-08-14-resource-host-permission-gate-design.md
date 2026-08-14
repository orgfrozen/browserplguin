# Resource Host Permission Gate Design

## Goal

Require explicit per-origin Chrome host permission before any Task `resource.url` is downloaded, and give the operator a small Options UI to check, grant, and revoke exactly that origin.

## Scope

This patch only covers host-access gating for Task resources. It does not claim that ChatGPT file-input/attachment/progress DOM has been calibrated, and it does not mark the full resource download→upload E2E complete without a real Chrome run.

## Permission model

`manifest.json` keeps the existing broad declaration in `optional_host_permissions` (`http://*/*`, `https://*/*`) so runtime-discovered resource origins can be requested. Required `host_permissions` remain limited to ChatGPT.

A resource URL is normalized to an exact scheme+host match pattern:

- `https://assets.example.com/path/file.zip?sig=...` → `https://assets.example.com/*`
- `http://localhost:8080/a.zip` → `http://localhost:8080/*`

Only absolute `http:` and `https:` URLs are accepted. Credentials embedded in URLs are rejected. The permission-facing result exposes the exact origin pattern, never the resource path/query/hash.

## Background download gate

`ResourceHostPermissionManager` owns normalization and `chrome.permissions.contains()` checks. `ResourceLoader.load()` must verify permission before invoking `fetch`. If the permission API is unavailable, rejects, or reports false, loading fails closed with `RESOURCE_HOST_PERMISSION_REQUIRED`.

The error details may contain only the normalized origin pattern and a stable reason code; they must not include the full resource URL or raw Chrome error text.

## Options UI

Options adds a Resource Host Access section with one URL input and three user-driven actions:

- Check access: `chrome.permissions.contains({ origins: [pattern] })`
- Grant access: `chrome.permissions.request({ origins: [pattern] })`
- Revoke access: `chrome.permissions.remove({ origins: [pattern] })`

Grant is executed directly inside the button click handler so it retains the required user gesture. The UI renders only the normalized origin pattern and a stable status (`granted`, `missing`, `removed`, `denied`, `invalid`).

## Privacy and safety

- Never request `<all_urls>` or `*://*/*` at runtime.
- Never auto-request permission in the service worker or during Task claim.
- Never store the full resource URL, URL query/hash, credentials, or raw permission error text.
- Permission loss between configuration and execution is handled by the download-time fail-closed check.

## Tests

Tests cover URL normalization, credential rejection, contains failures, loader-before-fetch ordering, exact-origin grant/check/revoke UI wiring, no wildcard runtime request, and service-worker wiring with `chrome.permissions`.
