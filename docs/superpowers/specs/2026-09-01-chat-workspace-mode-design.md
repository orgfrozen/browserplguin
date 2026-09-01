# BrowserPlugin Dual Workspace Mode Design

Date: 2026-09-01
Project: browserplguin
Session: ps-20260901-114430-db7b15
Status: Design approved in chat; implementation pending written-spec review

## 1. Goal

Add a second ChatGPT execution workspace mode while preserving the existing Project-based mode.

The plugin must support a user-selectable default mode for newly claimed Tasks:

- `project`: current behavior. Create/use a temporary ChatGPT Project, configure Project Instructions, attach the source export, run initialization, execute the Task, and delete the Project after the Task reaches a cleanup-safe terminal state.
- `chat`: new behavior. Start a normal ChatGPT conversation, attach both `LLM_RULES.md` and the exported source ZIP, send a dedicated initialization Prompt, wait for the existing READY protocol, execute the Task using the same round/Patch lifecycle as Project mode, and delete the owned conversation after the Task reaches a cleanup-safe terminal state.

The selected default may be changed at any time, but an already claimed Task must keep the workspace mode captured when that Task began. Mid-Task workspace-mode migration is explicitly unsupported.

## 2. Non-goals

This change must not:

- create a second Task runner or duplicate the Patch lifecycle;
- change PatchSync session/sequence semantics;
- change Task claiming, lease, heartbeat, completion-check, Patch discovery, Patch download, WAIT_EXTERNAL, CI/deploy waiting, or terminal decision semantics except where workspace identity/cleanup requires abstraction;
- migrate a running Project-mode Task into Chat mode or vice versa;
- infer conversation ownership from the visible conversation title;
- delete arbitrary chats when exact ownership cannot be proven;
- remove legacy Project execution-state fields in the first implementation wave.

## 3. Existing behavior to preserve

The current implementation already has a strict initialization protocol:

1. prepare the source resource;
2. create/configure the ChatGPT Project;
3. attach the source resource;
4. send `INITIALIZATION_PROMPT`;
5. require the assistant response to equal `<INIT_STATUS>READY</INIT_STATUS>`;
6. only then send the formal Task Prompt.

The new Chat mode must converge into the same post-initialization Task execution path. The only mode-specific responsibilities should be workspace creation/configuration, initialization input preparation, exact workspace recovery, and terminal cleanup.

## 4. Core architecture

Introduce a workspace abstraction rather than scattering `if (mode === ...)` through TaskRunner.

Conceptually:

```text
TaskRunner
   |
   +-- WorkspaceDriver
         |
         +-- ProjectWorkspaceDriver
         |
         +-- ChatWorkspaceDriver
```

`TaskRunner` continues to own:

- Task/lease lifecycle;
- source preparation request to PatchSync;
- durable execution state;
- initialization retry policy;
- Task rounds;
- response recovery;
- Patch discovery/download/transfer;
- WAIT_EXTERNAL and server continuation;
- completion checks;
- terminal policy.

The workspace driver owns only ChatGPT container-specific behavior.

### 4.1 Proposed workspace interface

The implementation may use a class, strategy object, or equivalent internal boundary, but the responsibilities should map to:

```js
workspace.prepare({ task, state, source })
workspace.initialize({ task, state, source, hooks })
workspace.reopen({ task, state })
workspace.cleanup({ task, state })
workspace.identity({ state })
```

Mode-specific low-level UI work remains in `BrowserPageDriver`/content commands, but orchestration should call one workspace-facing interface.

### 4.2 Workspace modes

Use stable internal values:

```text
project
chat
```

Display labels may be localized, for example:

```text
Project
普通聊天
```

Do not persist localized labels as protocol/state values.

## 5. Mode selection and immutability

Add a persistent plugin setting such as:

```js
default_workspace_mode: 'project' | 'chat'
```

Compatibility/default behavior:

- missing setting => `project`;
- invalid setting => `project`;
- changing the setting affects only future Task claims.

When a Task is claimed, capture the resolved value into durable execution state immediately:

```js
workspace_mode: 'project' | 'chat'
```

Recovery must read `state.workspace_mode`, never the current global preference.

This prevents a user changing the UI selector from mutating the semantics of an already running Task.

## 6. Durable workspace identity

Add a generic workspace record while retaining legacy Project fields during migration:

```js
task_workspace: {
  mode: 'project' | 'chat',
  status: 'active' | 'cleanup_deferred' | 'deleted',
  browser_workspace_id: string | null,
  chatgpt_tab_id: number | null,
  browser_slot_id: string | null,
  browser_slot_generation: number | null,
  project_name: string | null,
  conversation_url: string | null,
  conversation_id: string | null
}
```

Top-level fields that are already widely consumed may remain as compatibility mirrors initially:

- `chatgpt_project_name`
- `chatgpt_tab_id`
- `chatgpt_conversation_url`
- `browser_workspace_id`
- `task_project`

### 6.1 Project-mode identity

Project mode owns a temporary Project identity plus its active conversation:

```json
{
  "mode": "project",
  "project_name": "vetatool_ewan_202609011230",
  "conversation_url": "https://chatgpt.com/c/...",
  "conversation_id": "..."
}
```

### 6.2 Chat-mode identity

Chat mode has no Project identity:

```json
{
  "mode": "chat",
  "project_name": null,
  "conversation_url": "https://chatgpt.com/c/...",
  "conversation_id": "..."
}
```

A Chat-mode Task must never invent a fake Project name solely to satisfy old code.

## 7. Chat-mode initialization inputs

Chat mode must attach two exported artifacts to the normal conversation before sending the initialization Prompt:

1. `LLM_RULES.md`
2. the current `SOURCE_FILE` ZIP produced by PatchSync export

These inputs have separate responsibilities:

- `LLM_RULES.md` is the authoritative Patch/session/rules document;
- source ZIP is the authoritative source baseline;
- the initialization Prompt tells the model how to read and use those artifacts, but must not duplicate the entire rules file into the Prompt.

### 7.1 Chat-mode initialization Prompt

Use a Chat-specific initialization Prompt that preserves the current initialization safety semantics while explicitly mentioning both attachments:

```text
请先完整阅读本次聊天上传的 LLM_RULES.md，理解并严格遵守其中的项目约束和 PatchSync 交付规则。

然后完整分析本次上传的项目源码 ZIP，理解现有架构、技术栈、代码风格、项目约束，以及源码与 LLM_RULES.md 之间的关系。

本轮仅用于初始化上下文：
- 必须同时以本次上传的 LLM_RULES.md 和源码 ZIP 为当前会话依据。
- 不要修改任何文件。
- 不要执行任何具体业务 Task。
- 不要生成 Git Patch。
- 不要开始处理后续 Task。
- 必须等待下一条正式 Task Prompt 后才能开始具体业务工作。

分析完成后不要执行其它操作，仅回复 <INIT_STATUS>READY</INIT_STATUS>
```

Project mode may continue using the existing Project-oriented initialization Prompt unless implementation refactoring makes a single parameterized Prompt clearer. The READY marker remains shared and unchanged.

## 8. Attachment readiness protocol

Selecting files is not equivalent to attachment readiness.

Chat mode must not send the initialization Prompt until both expected attachments are confirmed ready by the ChatGPT UI adapter.

Required logical progression:

```text
NEW_CHAT_READY
  -> ATTACHING_RULES
  -> RULES_READY
  -> ATTACHING_SOURCE
  -> SOURCE_READY
  -> ATTACHMENTS_READY
  -> INITIALIZATION_PROMPT_SENT
  -> INITIALIZED
```

The UI implementation may upload both files in one chooser action or in two operations, but the orchestration contract remains:

```text
expected owned attachments = 2
confirmed ready owned attachments = 2
```

before Prompt submission.

Attachment confirmation must be based on the selected/expected file identities when the DOM exposes them, not merely on the presence of any two attachment chips in the composer.

## 9. Normal Chat creation flow

For `workspace_mode=chat`:

```text
Task claimed
  -> PatchSync source export completed
  -> open/activate owned ChatGPT slot tab
  -> navigate to New Chat
  -> verify normal composer is ready
  -> attach LLM_RULES.md
  -> wait until ready
  -> attach source ZIP
  -> wait until ready
  -> send Chat initialization Prompt
  -> require exact READY marker
  -> capture durable conversation URL/id
  -> mark initialization_completed
  -> send formal Task Prompt
```

The Task Prompt and every later model round use the same existing TaskRunner path as Project mode.

## 10. Conversation identity capture

A fresh ChatGPT page may not have a stable `/c/<id>` URL before the first message is submitted.

After the initialization Prompt creates the conversation, Chat mode must capture and persist the stable owned conversation identity as soon as it becomes available:

```text
chatgpt_conversation_url
conversation_id
```

Normalize the conversation identity from the URL rather than deriving it from visible title text.

The persisted identity is mandatory for robust recovery and exact cleanup.

## 11. Recovery

Recovery must be mode-aware but use the same high-level recovery policy.

### 11.1 Project mode

Continue current behavior:

- recover exact owned tab when possible;
- reopen known conversation/project;
- preserve existing initialization/round checkpoints;
- apply existing Project retry/recreate policy.

### 11.2 Chat mode

Recovery preference order:

1. inspect the owned tab if it still exists;
2. if the tab is discarded, restore it;
3. if the tab exists on another URL, navigate it to the exact persisted conversation URL;
4. if the tab was closed, recreate a slot-owned tab and navigate directly to the persisted conversation URL;
5. reconcile durable Prompt/response checkpoints against that exact conversation;
6. only if initialization has not established a usable owned conversation and existing recovery policy exhausts local recovery, abandon/delete the failed owned Chat and create a new Chat initialization attempt.

Never recover Chat mode by searching the sidebar for a title and selecting a likely match.

### 11.3 Missing conversation during recovery

If the exact persisted conversation no longer exists:

- before formal Task execution: treat it as an initialization/workspace recovery failure and use the bounded workspace retry policy;
- after business work or Patch delivery has begun: fail closed or escalate according to existing recovery/terminal policy rather than silently starting a fresh conversation and replaying potentially non-idempotent Task rounds.

## 12. Initialization recovery and retries

Reuse the existing durable initialization checkpoints and retry budget where possible.

Chat mode requires a mode-specific workspace recreate action:

```text
failed Chat initialization
  -> local reload/reopen attempts
  -> if retry policy permits recreation:
       delete/abandon exact failed owned conversation
       open New Chat
       reattach both artifacts
       resend initialization Prompt
```

Each recreate attempt is a new conversation identity. Previous conversation identities should be recorded in an orphan/retry ledger so cleanup can be attempted safely without losing ownership evidence.

Project-mode naming suffix behavior (`-r1`, etc.) remains Project-specific and must not leak into Chat mode.

## 13. Terminal cleanup

Workspace cleanup happens only after the existing Task lifecycle says cleanup is safe.

An assistant response, Patch link, successful local apply, or CI start is not by itself permission to delete the workspace.

### 13.1 Project mode

Keep existing temporary Project deletion behavior.

### 13.2 Chat mode

Delete the exact owned conversation after the Task reaches a cleanup-safe terminal state.

Required identity rule:

```text
conversation_id / exact /c/<id> href
```

Not allowed:

```text
conversation title match
position in sidebar
"most recent chat"
```

Suggested cleanup sequence:

```text
terminal decision allows cleanup
  -> ensure exact conversation_id exists in durable state
  -> find sidebar item whose href resolves to that exact id
  -> open its overflow/menu
  -> choose Delete
  -> confirm destructive action
  -> verify exact conversation no longer exists
  -> mark task_workspace.status = deleted
```

If the exact conversation is already absent, cleanup should be idempotently successful when ownership/state indicates this is the same conversation.

If the UI cannot prove the exact target, do not delete anything. Record `cleanup_deferred`/diagnostics and use the existing cleanup recovery machinery.

## 14. Tab lifecycle

Chat-mode cleanup should not require closing the slot tab.

After deleting the conversation, the tab may remain on New Chat and can be reused by the slot for a future Task. This reduces tab churn and avoids known blank-tab/close-race failure modes.

Tab closure remains an implementation/policy choice for slot shutdown, plugin shutdown, or explicit terminate flows, not a requirement of normal Chat workspace cleanup.

## 15. UI design

Add a compact setting to the plugin control UI:

```text
ChatGPT 工作模式
[ Project v ]

Project
普通聊天
```

Supporting copy:

```text
仅影响之后领取的新 Task；运行中的 Task 保持原模式。
```

Each active Task/slot card should display its captured mode, for example:

```text
Workspace: Project
```

or

```text
Workspace: Chat
```

The mode shown on an active Task must come from durable execution state, not from the current default setting.

## 16. Content-script/UI command changes

New Chat mode will need semantic UI operations beyond the current Project manager. Exact names can follow repository conventions, but the logical capabilities are:

- navigate/activate New Chat;
- determine whether normal chat composer is ready;
- attach one or multiple files with expected identity;
- observe per-file attachment readiness;
- resolve current stable conversation URL/id;
- locate an exact sidebar conversation by conversation id/href;
- open exact conversation menu;
- delete and confirm exact conversation;
- verify disappearance.

These operations must use the existing selector registry/calibration/compatibility telemetry mechanisms rather than introducing unrelated hard-coded selectors in TaskRunner.

## 17. Error handling

Prefer existing error classes/codes when their semantics already match. Add new workspace-specific codes only where operational handling differs.

Expected failure categories include:

- New Chat control unavailable;
- normal composer not ready;
- rules attachment failed/not ready;
- source attachment failed/not ready;
- stable conversation identity not captured;
- persisted conversation not found;
- exact conversation menu/delete action unavailable;
- cleanup target cannot be proven;
- initialization READY protocol missing.

Safety principles:

- attachment uncertainty => do not send initialization Prompt;
- conversation identity uncertainty => do not delete;
- recovery identity mismatch => do not replay Prompt;
- mode ambiguity on legacy state => default legacy executions to Project mode, not Chat mode.

## 18. Legacy compatibility and migration

Existing durable executions predate `workspace_mode` and `task_workspace`.

Migration rule:

```text
if state.workspace_mode is absent:
    infer project mode when legacy Project ownership fields exist
    otherwise use conservative legacy behavior; do not reinterpret as chat
```

Keep current Project fields readable/writable during the first waves. Introduce generic helpers so new code stops adding new direct dependencies on `task_project`, then remove/deprecate legacy fields only in a separate future migration after restart/recovery compatibility has been proven.

## 19. Observability

Add mode and workspace identity to existing safe telemetry/state summaries without exposing conversation text:

- `workspace_mode`
- workspace status
- conversation identity present/missing (id may be redacted/hashed in telemetry if appropriate)
- attachment readiness stage
- cleanup attempt/result
- workspace retry attempt

Do not include Prompt/assistant content in diagnostics solely for this feature.

## 20. Testing strategy

Implementation must be test-driven and preserve the current test suite.

### 20.1 Pure/shared tests

Cover:

- default mode is Project;
- user preference normalization;
- mode captured once at Task start;
- mode does not change when global preference changes;
- legacy state resolves to Project;
- generic workspace identity record mirrors legacy Project fields correctly.

### 20.2 TaskRunner tests

Cover:

- Project path remains unchanged;
- Chat path calls normal-chat preparation instead of Project creation;
- Chat mode waits for both attachments before initialization Prompt;
- formal Task Prompt is blocked until READY marker;
- Task rounds/Patch handling are shared after initialization;
- Chat cleanup only occurs after cleanup-safe terminal state;
- cleanup failure becomes deferred rather than deleting an unproven target.

### 20.3 BrowserPageDriver/content tests

Cover:

- open New Chat;
- detect composer readiness;
- attach `LLM_RULES.md` and source ZIP;
- distinguish selected file readiness from unrelated attachments;
- capture stable `/c/<id>` URL;
- reopen exact conversation after tab close/discard;
- exact-id sidebar lookup;
- exact-id delete confirmation;
- already-missing exact conversation is idempotent cleanup;
- ambiguous/no exact target does not delete another conversation.

### 20.4 Recovery tests

Cover crashes/checkpoints at least at:

- after New Chat before upload;
- after first attachment;
- after both attachments before initialization Prompt;
- after durable initialization Prompt intent;
- after Prompt send before READY;
- after READY before formal Task Prompt;
- during a normal Task round;
- after Patch discovered;
- during WAIT_EXTERNAL;
- before and during terminal cleanup.

### 20.5 UI tests

Cover:

- selector defaults to Project for existing installs;
- changing selector persists preference;
- active Task card shows captured mode;
- changing default while a Task runs does not change that Task card/state.

### 20.6 Full verification

Run repository-required verification:

```text
npm test
```

Do not claim success unless the full command completes successfully.

## 21. Rollout plan

Implement in small, reviewable PatchSync patches rather than one large patch.

### Phase 1 — Workspace mode foundation

- add preference/config value;
- capture immutable mode per Task;
- add generic workspace state/helper facade;
- add UI selector and Task-card mode display;
- keep runtime behavior Project-only for safety, or gate Chat mode as unavailable until Phase 2 is present.

### Phase 2 — Chat creation and dual-artifact initialization

- New Chat semantic action;
- attach `LLM_RULES.md` + source ZIP;
- readiness gating;
- Chat initialization Prompt;
- READY protocol;
- stable conversation identity capture;
- converge into existing Task round/Patch flow.

### Phase 3 — Chat recovery

- exact conversation reopen using persisted URL/id;
- closed/discarded tab restoration;
- initialization recreation policy;
- orphan conversation ledger/cleanup hooks;
- crash checkpoint tests.

### Phase 4 — Exact conversation cleanup

- exact-id sidebar discovery;
- delete/confirm semantics;
- idempotent already-missing handling;
- deferred cleanup on ambiguity/UI incompatibility;
- retain/reuse slot tab after deletion.

### Phase 5 — Hardening and calibration

- compatibility telemetry;
- live calibration evidence for New Chat, attachments, sidebar menu, delete confirm;
- fault injection/soak coverage;
- documentation updates;
- decide whether legacy `task_project` fields can begin deprecation in a later independent change.

## 22. Acceptance criteria

The feature is complete only when all of the following are true:

1. User can select Project or Chat as the default for future Tasks.
2. A running Task's mode is immutable.
3. Existing installs/tasks remain Project mode by default.
4. Chat mode creates a normal Chat, not a Project.
5. Chat mode attaches both `LLM_RULES.md` and source ZIP.
6. Initialization Prompt is not sent until both attachments are confirmed ready.
7. Formal Task Prompt is not sent until the exact READY marker is received.
8. Post-initialization Task/Patch lifecycle uses the existing shared runner logic.
9. Chat mode persists exact conversation URL/id.
10. Restart/recovery reopens the exact owned conversation rather than guessing by title.
11. Terminal cleanup deletes only the exact owned conversation and never another chat.
12. Cleanup occurs only after existing terminal/WAIT_EXTERNAL semantics permit it.
13. Chat cleanup may leave the slot tab alive on New Chat for reuse.
14. Project mode behavior and recovery remain compatible.
15. Full `npm test` passes after implementation.

## 23. Implementation constraints

Follow the current PatchSync delivery rules for this Session. In particular, implementation patches must be based only on the current exported source baseline/session chain, use contiguous Patch sequence numbers, and report actual verification results only.
