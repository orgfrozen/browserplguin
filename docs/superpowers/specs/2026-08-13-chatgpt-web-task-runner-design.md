# ChatGPT Web Task Runner Design

**Date:** 2026-08-13
**Status:** Approved current architecture

## 1. Purpose

Build a Chrome Extension based Task Runner that uses an already logged-in `chatgpt.com` browser session as an execution environment.

The runner receives a Task from a server, creates a temporary ChatGPT Project for that Task, initializes the Project from Task data, drives one chat through multiple model rounds, downloads generated Patch artifacts, reports progress/results, deletes the temporary Project, and only then releases the server-side lock through a terminal API.

The design intentionally optimizes for deterministic automation and isolation rather than long-lived ChatGPT Project reuse.

## 2. Core invariant

The primary invariant is:

```text
1 Task = 1 temporary ChatGPT Project = 1 Session
```

Consequences:

- Normal execution never searches for a historical business Project.
- Normal execution never reuses an earlier ChatGPT chat.
- A Task may contain many user/model rounds.
- A Task may produce many Patch artifacts.
- A Task never automatically creates a second ChatGPT Project.
- Chat/context length exhaustion terminates the current Task.
- If business logic wants continuation, the server creates a new Task.

This invariant is the most important simplification in the system.

## 3. Scope

### In scope

- Server Task claim/lock integration.
- Fresh temporary ChatGPT Project per Task.
- Project Instructions from Task constraints.
- Task resource package download and ChatGPT upload.
- Resource downloads require explicit exact-origin runtime host permission; Background never auto-prompts for host access.
- Initialization prompt.
- Multi-round task prompt execution.
- Model generation-state observation.
- Optional Patch-count goal.
- Automatic Patch discovery/download/dedupe.
- Local/remote artifact transfer abstraction.
- Context-limit termination.
- Finalization and Project cleanup.
- Durable execution state.
- Crash-recovery hooks for the single recorded Task Project.
- Mock mode for development/testing.

### Out of scope for the first architecture

- Reusing a long-lived ChatGPT Project for normal execution.
- Multiple ChatGPT Projects inside one Task.
- Multiple Sessions inside one Task.
- Automatic continuation after context limit.
- Bypassing authentication challenges or CAPTCHA.
- Fixed-coordinate desktop automation for normal page interactions.

## 4. High-level architecture

```text
                     Task Server
                         │
            claim / heartbeat / report
                         │
                         ▼
┌──────────────── Chrome Extension ────────────────┐
│                                                  │
│  RuntimeController                               │
│       │                                          │
│       ▼                                          │
│  TaskRunner                                      │
│   ├── TaskApi                                    │
│   ├── TaskStore                                  │
│   ├── BrowserPageDriver                          │
│   ├── PatchDownloadManager                       │
│   ├── ChromePatchProcessor                       │
│   └── ArtifactTransferManager                    │
│                                                  │
│  Content Script                                  │
│   ├── ProjectManager                             │
│   ├── ConversationManager                        │
│   ├── Composer                                   │
│   ├── ModelStateObserver                         │
│   └── ArtifactObserver                           │
└───────────────────────┬──────────────────────────┘
                        │ DOM
                        ▼
                    chatgpt.com
```

## 5. Task protocol

Minimum Task:

```json
{
  "task_id": "task_fix_001",
  "project_id": "vetatool",
  "task_prompt": "修复 sitemap lastmod 问题"
}
```

Fuller Task:

```json
{
  "task_id": "task_fix_001",
  "project_id": "vetatool",
  "task_prompt": "修复 sitemap lastmod 问题",
  "project_constraints": "遵循现有架构，不做无关重构。",
  "resource": {
    "url": "https://example.com/vetatool-source.zip",
    "filename": "vetatool-source.zip"
  },
  "initialization_prompt": "分析一下这个项目，并从seo角度来计划一下怎么进行",
  "patch_goal": null
}
```

Batch Patch goal:

```json
{
  "patch_goal": {
    "minimum": 30
  }
}
```

`patch_goal` is optional.

## 6. Project lifecycle

Every successful claim starts a fresh Project.

```text
CLAIM_TASK
    ↓
CREATE_TASK_PROJECT
    ↓
GENERATE_SESSION_ID
    ↓
SET_PROJECT_INSTRUCTIONS
    ↓
DOWNLOAD_RESOURCE
    ↓
UPLOAD_RESOURCE
    ↓
INITIALIZE_PROJECT
    ↓
RUN_TASK
```

The `project_id` from the Task identifies the business/code project, not an existing ChatGPT Project that must be opened.

Example generated ChatGPT Project name:

```text
vetatool2026081315
```

Collision fallback:

```text
vetatool2026081315-02
```

## 7. Session and Patch naming

Each Task Project establishes one `session_id`:

```text
faf42343242
```

Project Instructions require Patch filenames to include that Session ID:

```text
patch-faf42343242-001.patch
patch-faf42343242-002.patch
patch-faf42343242-003.patch
```

Patch sequence starts at `001` for this Task/Session and increases during the Task.

There is no Task-local Session change, so there is no cross-Session Patch numbering problem.

The plugin does not generate Patch sequence numbers. The model follows Project Instructions; the plugin validates current-session identity and counts completed downloads.

## 8. Multi-round Task execution

A Task is not equivalent to one ChatGPT message.

Example:

```text
Task
 ├─ Round 1 → Patch 001 → CONTINUE
 ├─ Round 2 → Patch 002 → CONTINUE
 ├─ Round 3 → no Patch  → CONTINUE
 ├─ ...
 └─ Round N → Patch 010 → DONE
```

`task_round_count` counts completed model rounds.

A model round counts only after the response has completed and stabilized. A context-limit signal before a completed response does not increment `task_round_count` for that incomplete round.

## 9. Model-state detection

The runner must not use a fixed delay as completion logic.

Expected transition:

```text
READY
  ↓ submit prompt
WAIT_GENERATING
  ↓ observe generating/Stop semantics
GENERATING
  ↓
WAIT_READY
  ↓ observe Send/↑ semantics returning
STABILIZE_RESPONSE
  ↓
ROUND_COMPLETE
```

A visible Send/↑ control alone is insufficient because it is also visible before any request starts.

The runner therefore requires a transition into generating state before accepting a return to ready as completion.

## 10. Model task-status protocol

Project Instructions require the model to end responses with one of:

```text
<TASK_STATUS>CONTINUE</TASK_STATUS>
<TASK_STATUS>DONE</TASK_STATUS>
<TASK_STATUS>BLOCKED</TASK_STATUS>
```

Rules:

- `CONTINUE`: send another continuation prompt.
- `DONE` without Patch goal: Task may complete.
- `DONE` with Patch goal below minimum: continue.
- `DONE` with Patch goal satisfied: Task may complete.
- `BLOCKED`: stop normal execution, Finalize/Cleanup, then release according to server retry policy.
- Missing marker: bounded fallback; after threshold, Finalize/Cleanup and release.

## 11. Patch-count semantics

Only one counter is required:

```text
task_patch_count
```

Patch count is always observed, even when there is no quantity requirement.

A Patch counts only when all of these are true:

1. it belongs to the current Session;
2. it has not already been counted;
3. the Chrome download has reached `complete`;
4. required artifact transfer has succeeded for the configured mode; local mode requires final Chrome download metadata and a local transfer receipt.

Do not increment on:

- text mentioning a Patch;
- discovery of a download button;
- click initiation;
- `downloads.onCreated` alone.

## 12. Optional Patch goal

Normal fix:

```json
{
  "patch_goal": null
}
```

The model can complete with 0, 1, or many Patches as appropriate.

Batch optimization:

```json
{
  "patch_goal": {
    "minimum": 30
  }
}
```

If model output says DONE when only 23 completed Patches exist:

```text
action = CONTINUE
remaining = 7
```

The runner sends a continuation prompt that includes Task-level progress.

## 13. Automatic Patch download

The design reuses only the automatic-download logic concept from the supplied reference package.

Per completed Assistant response:

```text
latest assistant message
  ↓
discover Patch controls
  ↓
filter current session
  ↓
filter seen keys
  ↓
trigger download
  ↓
wait for Chrome download completion
  ↓
transfer artifact (local receipt / remote upload receipt)
  ↓
persist Patch count + dedupe state
  ↓
report artifact
```

### Direct URL case

If a candidate exposes a URL, use `chrome.downloads.download()` and bind the returned download ID immediately.

### Click-only case

If the UI only exposes a “下载 Patch” control:

```text
create DownloadIntent
→ click UI control
→ observe chrome.downloads.onCreated
→ correlate by tab/time/.patch/session
→ bind downloadId
```

### Ambiguity

If more than one download can validly match one intent, fail with `PATCH_DOWNLOAD_AMBIGUOUS` rather than guessing.

## 14. Context Limit semantics

ChatGPT chat/context maximum length is a Task terminal condition.

It is explicitly **not** a workspace-change trigger.

When detected:

```text
RUNNING
  ↓
TASK_CONTEXT_LIMIT
  ↓
FINALIZING
  ↓
CLEANUP
  ↓
DELETE_TASK_PROJECT
  ↓
failTask(CHAT_LENGTH_LIMIT)
```

The final payload includes current progress:

```json
{
  "terminal_status": "context_limit",
  "code": "CHAT_LENGTH_LIMIT",
  "task_patch_count": 21,
  "task_round_count": 18,
  "patch_goal": { "minimum": 30 }
}
```

This is terminal but not successful completion.

If continuation is desired, it is a server concern:

```text
old Task → terminal context_limit
server policy → create new Task
new Task → new Project + new Session
```

The browser extension never performs continuation inside the old Task.

## 15. Finalization and cleanup ordering

Task lock ownership must cover cleanup.

For every Task terminal path that already created a Project:

```text
terminal decision
  ↓
FINALIZING
  ↓
ensure artifact state/result state durable
  ↓
CLEANUP
  ↓
delete the Task's one temporary Project
  ↓
server terminal transition
```

Successful task:

```text
DELETE PROJECT
→ completeTask
```

Context-limit/unexpected terminal failure:

```text
DELETE PROJECT
→ failTask
```

Retryable blocked/protocol/max-round condition:

```text
DELETE PROJECT
→ releaseTask
```

## 16. Cleanup failure

If Project deletion fails:

```json
{
  "phase": "CLEANUP",
  "cleanup_error": {
    "code": "UI_SELECTOR_INCOMPATIBLE",
    "message": "..."
  },
  "task_project": {
    "status": "active"
  }
}
```

The Task remains server-locked.

Do not call complete/fail/release until cleanup is resolved, because doing so could allow another executor to start the same Task while the old Task workspace still exists.

## 17. Execution state

Representative state:

```json
{
  "task_id": "task_001",
  "project_id": "vetatool",
  "phase": "RUNNING",
  "session_id": "faf42343242",
  "chatgpt_project_name": "vetatool2026081315",
  "task_round_count": 8,
  "task_patch_count": 5,
  "downloaded_patch_keys": [
    "patch-faf42343242-001.patch"
  ],
  "task_project": {
    "project_name": "vetatool2026081315",
    "session_id": "faf42343242",
    "status": "active"
  },
  "last_task_status": "CONTINUE",
  "fallback_count": 0,
  "terminal_reason": null,
  "cleanup_error": null
}
```

No Session-level Patch counter, Session-level round counter, Project-round counter, or Project-history array is required.

## 18. Crash recovery

Normal execution creates a fresh Project.

Recovery is different: if extension/service-worker restart occurs while a server Task remains locked, TaskStore may contain the exact Task Project mapping.

Recovery rules:

- persist the normalized Task snapshot and latest lease together with the active execution state;
- heartbeat lease rotations must update the durable lease checkpoint;
- recovery restores the persisted lease and performs a heartbeat before any Project operation;
- if lease validation fails, return `recovery_blocked` and do not open/delete a Project or send a Prompt;
- reopen only the exact persisted temporary Project; never search by loose substring or choose between ambiguous duplicates;
- on service-worker bootstrap, automatically enter recovery only when settings are in real mode and `activeExecution` exists; runtime messages wait for bootstrap recovery to settle;
- if persisted phase is RUNNING, prepare the exact Project/Chat identity, restart lease heartbeat, and reconcile a durable `in_flight_round` checkpoint against current page facts before any Prompt side effect;
- if persisted phase is CLEANUP, only continue cleanup; after Project deletion persist `TERMINAL_PENDING`, the terminal action, and the exact terminal payload before calling the server;
- if persisted phase is TERMINAL_PENDING, never reopen/delete the Project; retry only the exact persisted terminal payload so the deterministic idempotency key is unchanged;
- work rounds persist `READY_TO_SEND → PROMPT_SENT → RESPONSE_READY`, and `task_round_count` increments only when response/Patch/status processing commits and clears the checkpoint;
- recovery reads the current latest user text, latest message role, latest assistant text, composer state and context-limit signal; it may send/wait/reuse only when those facts prove the checkpoint state, otherwise it returns `recovery_blocked`;
- a resource Task must have durable `initialization_completed=true` before RUNNING work-round auto-resume; an ambiguous initialization interruption remains fail closed.

Recovery does not create a second Project for the Task. v0.9.0 safely auto-resumes work rounds only from the persisted checkpoint/page-fact protocol; legacy RUNNING states without checkpoint capability are not guessed or replayed.

## 19. Error classification

Important codes include:

```text
PROJECT_CREATE_FAILED
PROJECT_NOT_FOUND
CHAT_NOT_FOUND
PROJECT_INSTRUCTIONS_FAILED
RESOURCE_DOWNLOAD_FAILED
RESOURCE_UPLOAD_FAILED
MODEL_DID_NOT_START
MODEL_RESPONSE_TIMEOUT
CHAT_LENGTH_LIMIT
PATCH_DOWNLOAD_AMBIGUOUS
PATCH_DOWNLOAD_FAILED
REMOTE_ARTIFACT_UPLOAD_FAILED
TASK_PROTOCOL_MISSING
LOGIN_OR_CHALLENGE_REQUIRED
UI_SELECTOR_INCOMPATIBLE
```

UI uncertainty must be explicit and fail closed.

## 20. Server API abstraction

Required logical operations:

```text
claimTask()
heartbeatTask(taskId)
reportProgress(taskId, event)
reportArtifact(taskId, artifact)
completeTask(taskId, result)
failTask(taskId, error)
releaseTask(taskId, reason)
```

Wire contract for real mode:

- every request carries `X-Task-Protocol-Version: 1`;
- `POST /tasks/claim` returns `204` when idle, otherwise `{ task, lease }`;
- `lease.token` is opaque and `lease.ttl_ms` is a positive integer;
- every Task-scoped request carries `X-Task-Lease-Token`;
- heartbeat may rotate the lease token/TTL, and the next heartbeat is scheduled no later than one third of the latest TTL (bounded by the configured heartbeat interval);
- progress/artifact/complete/fail/release carry deterministic `Idempotency-Key` values derived from Task ID, endpoint, and canonical JSON payload;
- terminal success clears the local lease only after the server acknowledges the terminal request.

Server responsibilities:

- locking/lease semantics and opaque lease issuance;
- honoring idempotency keys;
- retry policy;
- deciding whether a context-limited Task should cause a separate continuation Task;
- long-term artifact/result storage.

## 21. Mock mode

Mock mode must cover at least:

1. simple fix with one Patch;
2. multi-round feature with several Patches;
3. Patch-goal Task that continues until minimum count;
4. Context Limit after partial progress;
5. duplicate Patch observation;
6. multiple Patch candidates in one reply;
7. cleanup failure keeping Task locked.

Mock mode should exercise TaskRunner without requiring live ChatGPT DOM.

## 22. Real ChatGPT UI strategy

Preferred element-location priority:

```text
stable data/test attribute
→ role + accessible name
→ aria-label/title
→ visible text + structural relation
→ tightly scoped DOM fallback
```

Avoid hashed CSS class names and fixed coordinates.

Destructive operations (especially Project deletion) require stronger identity checks than non-destructive reads.

## 23. Real UI implementation status

Semantic DOM automation is now implemented for:

- page access guard that blocks task automation on logged-out/security-challenge pages while leaving privacy-safe diagnostics available;

- create one temporary Project;
- generate a collision-safe Project name and 12-character Session ID;
- set Project Instructions;
- input/send prompts through textarea or contenteditable composers;
- delete the exact Task-owned Project and verify disappearance;
- collect privacy-limited UI diagnostics for live calibration;
- attach stricter privacy-safe DOM diagnostics to failed automation responses: error code, selector profile, access state, sanitized path/title category, and bounded control fingerprints only; never include conversation text, task/project names, attachment names, URL query/hash, raw document title, or screenshots;
- route Project/Composer/Access Guard semantic selectors through versioned selector registry profile `chatgpt-semantic-v1`; expose only profile id/version in diagnostics/status and fail closed on unknown profiles;
- aggregate compatibility-relevant UI failures locally using only selector profile, operation, error code, access status, page category, count, and timestamps; do not persist DOM fingerprints/free text and do not upload compatibility telemetry remotely;
- persist privacy-safe Live Calibration evidence locally using only fixed surface ids/statuses, selector profile, page/access enums, timestamps, bounded recent runs, and aggregate counts; never persist matrix evidence/free text and never upload the ledger remotely;
- derive a fixed six-surface calibration review gate from the sanitized ledger, requiring real pass evidence and treating the latest incompatible result as needs-review; expose a downloadable safe handoff JSON containing only fixed enums/counts/profile metadata and never auto-complete live-calibration TODOs;
- upload remote Patch bytes through the Task API only after a trusted reader supplies canonical base64; validate size/receipt, retry transient failures with the same idempotency payload, and strip Patch bytes/returned URLs before durable artifact metadata;
- the trusted reader is a read-only Native Messaging host: only canonical Downloads-root `.patch` regular files are accepted; the host streams bounded `BEGIN/CHUNK/END` messages, never echoes the local path, and the extension revalidates size/order/SHA-256 before upload; macOS/Linux user-level installer generates an absolute launcher/manifest bound to the exact Extension ID, and `PING/PONG` readiness verifies host/protocol/capability without reading a file;
- validate/download one Task `resource.url` in the background;
- inject the downloaded resource into the unique composer file input and wait for attachment readiness;
- run `initialization_prompt` before the normal Task loop without incrementing `task_round_count`.

These flows remain **live-calibration pending** against the current ChatGPT DOM/host-permission environment. If a semantic target is missing or ambiguous, execution fails closed.

Still pending:

- live calibration of the resource file input / attachment readiness DOM and real resource host access;
- live remote E2E for the installed/readiness-verified chunked Native Helper + remote artifact upload protocol, followed by explicit Options remote enablement, plus remaining live calibration;
- optional error screenshots only after an explicit opt-in + redaction design exists.

## 24. Security and platform constraints

- Use the user's existing logged-in browser session.
- Do not automate bypass of CAPTCHA/security challenges.
- Detect logged-out/security-challenge states before ChatGPT automation side effects; allow diagnostics/access-state reads but fail closed with `LOGIN_OR_CHALLENGE_REQUIRED`.
- Respect browser local-file access boundaries.
- Service credentials/tokens must not be exposed to page JavaScript.
- Prefer background/service-worker network access for Task API calls.
- Avoid deleting any ChatGPT Project not proven to be the current Task-owned Project.

## 25. Implementation milestones

Current milestone order:

```text
M0 core extension skeleton
M1 task/state model
M2 multi-round TaskRunner
M3 finalization/cleanup
M4 model-state observation
M5 Patch automatic download
M6 semantic Project creation (implemented; live calibration pending)
M7 Project Instructions (implemented; live calibration pending)
M8 resource upload + initialization (implemented; live calibration pending)
M9 semantic Project deletion (implemented; live calibration pending)
M10 production Task API semantics (including dedicated idempotent Context Limit terminal status + Popup result visibility)
M11 artifact transfer (local implemented; remote lease/idempotent upload transport implemented; chunked Native Helper/file reader + macOS/Linux installer/readiness implemented; live remote E2E/enablement pending)
M12 crash recovery (startup auto-recovery + in-flight work-round safe continuation implemented)
M13 compatibility/observability (privacy-safe Popup active Task status + login/challenge fail-closed guard + selector registry versioning + privacy-safe error DOM diagnostics + local UI compatibility telemetry + read-only Live Calibration Matrix + bounded local Calibration Evidence Ledger + calibration coverage gate/safe handoff report implemented; any opt-in redacted screenshot design still pending)
```

There is intentionally no Project/Session continuation milestone for a single Task.

## 26. Acceptance criteria for the architecture

The architecture is correctly implemented when:

1. every normally claimed Task creates exactly one temporary ChatGPT Project;
2. the Task uses exactly one Session;
3. multi-round model execution can generate many Patches;
4. Patch count increments only on durable completed downloads;
5. optional `patch_goal.minimum` works without constraining ordinary Tasks;
6. context-limit detection terminates the Task without creating another Project and is reported through the dedicated lease-scoped `/tasks/{task_id}/context-limit` terminal endpoint;
7. terminal server APIs run only after Task Project cleanup;
8. cleanup failure leaves the Task locked and recoverable;
9. server continuation, if desired, is represented as a new Task;
10. live UI uncertainty fails closed rather than guessing;
11. crash recovery validates the persisted lease before any Project operation and uses durable round checkpoints plus current page facts to avoid guessing whether to replay a Prompt;
12. terminal API response loss leaves a durable TERMINAL_PENDING checkpoint whose exact payload can be retried idempotently without touching the deleted Project;
13. task_round_count is incremented only when the corresponding RESPONSE_READY round has fully committed and its in-flight checkpoint is cleared.
14. Popup status is projected from durable state without exposing Prompt text, Project constraints, resource URLs, Task API tokens, lease tokens, or error messages.
15. Native Helper readiness uses exact host/protocol/capability metadata only, performs no file read, and never enables remote transfer as a side effect.
16. legacy durable `FAIL + terminal_status=context_limit` checkpoints keep retrying the original fail endpoint; only newly created Context Limit checkpoints use `CONTEXT_LIMIT`.
