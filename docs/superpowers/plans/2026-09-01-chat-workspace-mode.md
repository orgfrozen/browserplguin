# BrowserPlugin Dual Workspace Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-selectable normal-Chat workspace mode that uploads `LLM_RULES.md` plus the PatchSync source ZIP, performs the existing READY initialization handshake, shares the existing Task/Patch lifecycle, recovers by exact conversation identity, and deletes only the owned conversation at cleanup-safe terminal state.

**Architecture:** Keep one `TaskRunner` and introduce a narrow `WorkspaceDriver` strategy boundary for ChatGPT-container-specific creation/configuration/initialization/reopen/cleanup. Durable state captures `workspace_mode` at claim time and stores generic `task_workspace` identity while continuing to mirror legacy Project fields for compatibility. Chat mode remains internally gated until exact recovery and cleanup are implemented; only the final patch exposes the mode selector to users.

**Tech Stack:** Chrome Manifest V3 extension, Node.js ES modules, `node:test`, DOM content-script automation, Chrome tabs/storage/runtime APIs, PatchSync HTTP export API.

**Spec:** `docs/superpowers/specs/2026-09-01-chat-workspace-mode-design.md`

## Global Constraints

- Current PatchSync Session is `ps-20260901-114430-db7b15`; implementation starts at browserplguin Patch `001` and uses contiguous sequence numbers.
- Existing installs and legacy durable executions resolve to `project` mode.
- A Task captures its workspace mode once when claimed; changing the plugin preference never changes an already-running Task.
- Do not create a second Task runner or duplicate Task rounds, Patch discovery/download, WAIT_EXTERNAL, completion-check, lease, or terminal semantics.
- Chat mode must upload exactly the owned `LLM_RULES.md` rules artifact and current PatchSync source ZIP before initialization.
- Chat initialization Prompt must not be sent until both expected attachments are confirmed ready.
- Formal Task Prompt must not be sent until the assistant returns exactly `<INIT_STATUS>READY</INIT_STATUS>`.
- Chat ownership/recovery/cleanup uses exact persisted conversation URL/id, never title, sidebar position, or "most recent chat".
- If exact cleanup identity cannot be proven, delete nothing and defer cleanup through existing recovery semantics.
- Existing Project-mode behavior, `task_project`, `chatgpt_project_name`, Project retry suffixes, and legacy recovery remain compatible during this implementation.
- User-facing Chat mode is not enabled until creation, initialization, recovery, and exact cleanup are all implemented.
- Every implementation patch uses TDD: write the focused test, verify the intended RED failure, implement the minimum behavior, rerun focused tests, then run full `npm test`.
- Test results must be reported exactly as observed; never claim full verification unless `npm test` exits successfully.

---

## Patch 001 — Workspace Mode Foundation

### Task 1: Add durable workspace-mode primitives without changing Project behavior

**Files:**
- Create: `src/shared/workspace-mode.js`
- Modify: `src/shared/execution-state.js`
- Modify: `src/shared/runner-status.js`
- Test: `tests/execution-state.test.js`
- Test: `tests/runner-status.test.js`

**Interfaces:**
- Produces: `WORKSPACE_MODES`, `normalizeWorkspaceMode(value)`, `resolveWorkspaceMode(state)`.
- Produces: `createExecutionState(task, { lease, localStartedAt, workspaceMode })` with durable `workspace_mode` and `task_workspace`.
- Produces: generalized `recordCreatedWorkspace(state, input)` and `markWorkspaceDeleted(state)` that support both modes while preserving legacy Project mirrors.
- Consumers: `TaskRunner`, `WorkspaceDriver`, status UI in later patches.

- [ ] **Step 1: Write failing shared-state tests**

Add tests that prove the compatibility contract:

```js
import { WORKSPACE_MODES, normalizeWorkspaceMode, resolveWorkspaceMode } from '../src/shared/workspace-mode.js';

assert.equal(normalizeWorkspaceMode(undefined), WORKSPACE_MODES.PROJECT);
assert.equal(normalizeWorkspaceMode('project'), WORKSPACE_MODES.PROJECT);
assert.equal(normalizeWorkspaceMode('chat'), WORKSPACE_MODES.CHAT);
assert.equal(normalizeWorkspaceMode('invalid'), WORKSPACE_MODES.PROJECT);

const claimedChat = createExecutionState(task, { workspaceMode: 'chat' });
assert.equal(claimedChat.workspace_mode, 'chat');
assert.equal(claimedChat.task_workspace, null);

const legacyProject = { task_project: { project_name: 'vetatool_ewan_20260901', status: 'active' } };
assert.equal(resolveWorkspaceMode(legacyProject), 'project');
```

Also assert a Chat workspace can be recorded without inventing a Project name:

```js
const created = recordCreatedWorkspace(createExecutionState(task, { workspaceMode: 'chat' }), {
  mode: 'chat',
  browserWorkspaceId: 'assignment-1',
  sessionId: 'ps-1',
  chatgptTabId: 10,
  conversationUrl: 'https://chatgpt.com/c/conv-1',
  conversationId: 'conv-1'
});
assert.equal(created.task_workspace.mode, 'chat');
assert.equal(created.task_workspace.project_name, null);
assert.equal(created.task_workspace.conversation_id, 'conv-1');
assert.equal(created.chatgpt_project_name, null);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test tests/execution-state.test.js tests/runner-status.test.js
```

Expected failure: module/functions/fields for workspace mode do not yet exist.

- [ ] **Step 3: Implement `src/shared/workspace-mode.js`**

Use stable protocol values only:

```js
export const WORKSPACE_MODES = Object.freeze({
  PROJECT: 'project',
  CHAT: 'chat'
});

export function normalizeWorkspaceMode(value) {
  return value === WORKSPACE_MODES.CHAT ? WORKSPACE_MODES.CHAT : WORKSPACE_MODES.PROJECT;
}

export function resolveWorkspaceMode(state = {}) {
  if (state.workspace_mode != null) return normalizeWorkspaceMode(state.workspace_mode);
  if (state.task_workspace?.mode != null) return normalizeWorkspaceMode(state.task_workspace.mode);
  return WORKSPACE_MODES.PROJECT;
}
```

Do not infer Chat mode from an arbitrary conversation URL; absent mode remains Project for legacy safety.

- [ ] **Step 4: Generalize execution-state workspace recording**

Change `createExecutionState` to accept `workspaceMode` and initialize:

```js
workspace_mode: normalizeWorkspaceMode(workspaceMode),
task_workspace: null,
chatgpt_conversation_url: null,
chatgpt_conversation_id: null,
```

Generalize `recordCreatedWorkspace` to accept:

```js
{
  mode,
  projectName = null,
  browserWorkspaceId = null,
  sessionId = null,
  chatgptTabId = null,
  browserSlotId = null,
  browserSlotGeneration = null,
  conversationUrl = null,
  conversationId = null
}
```

Always write `task_workspace`. Only Project mode writes/updates `task_project` and `chatgpt_project_name`. Keep top-level tab/slot/session fields as compatibility mirrors. Update `markWorkspaceDeleted` so it marks `task_workspace.status='deleted'` and also legacy `task_project.status='deleted'` when present.

- [ ] **Step 5: Expose safe workspace metadata in runner status**

In `compactActiveExecution`, add:

```js
workspace_mode: resolveWorkspaceMode(state),
workspace_status: state.task_workspace?.status ?? state.task_project?.status ?? null,
conversation_identity_present: Boolean(state.task_workspace?.conversation_id ?? state.chatgpt_conversation_id)
```

Do not expose conversation text or full conversation URL in telemetry.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test tests/execution-state.test.js tests/runner-status.test.js
```

Expected: PASS.

### Task 2: Introduce a Project-compatible WorkspaceDriver seam

**Files:**
- Create: `src/background/workspace-driver.js`
- Modify: `src/background/task-runner.js`
- Modify: `src/background/service-worker.js`
- Test: `tests/task-runner.test.js`
- Test: `tests/service-worker-wiring.test.js`

**Interfaces:**
- Consumes: `resolveWorkspaceMode(state)` from Task 1.
- Produces: `WorkspaceDriver.create()`, `configure()`, `initialize()`, `prepareExisting()`, `reopen()`, `cleanup()`.
- Produces: `TaskRunner({ ..., workspaceDriver, defaultWorkspaceMode })`.
- Project mode delegates to the existing `BrowserPageDriver` methods so behavior is unchanged.

- [ ] **Step 1: Write failing delegation and immutability tests**

Add a TaskRunner test where the runner is constructed with `defaultWorkspaceMode: 'chat'`, state is saved at claim, then the mutable outside settings object is changed to `project`; assert the saved execution remains `workspace_mode === 'chat'`.

Add a Project-mode test with a fake workspace driver that records calls and assert the existing flow uses:

```text
create -> configure -> initialize -> shared Task loop -> cleanup
```

without calling a second runner.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test tests/task-runner.test.js tests/service-worker-wiring.test.js
```

Expected failure: `workspaceDriver/defaultWorkspaceMode` are not wired.

- [ ] **Step 3: Implement Project-first `WorkspaceDriver`**

Create `src/background/workspace-driver.js`:

```js
import { WORKSPACE_MODES, resolveWorkspaceMode } from '../shared/workspace-mode.js';
import { RunnerError, ERROR_CODES } from '../shared/errors.js';

export class WorkspaceDriver {
  constructor({ page }) { this.page = page; }

  mode(state) { return resolveWorkspaceMode(state); }

  async create(input) {
    if (this.mode(input.state) === WORKSPACE_MODES.PROJECT) {
      return this.page.createTaskProject(input);
    }
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Chat workspace mode is not enabled in this build');
  }

  async configure(input) {
    if (this.mode(input.state) === WORKSPACE_MODES.PROJECT) return this.page.configureTaskProject(input);
    return { saved: true, mode: WORKSPACE_MODES.CHAT };
  }

  async initialize(input) { return this.page.initializeTask(input); }
  async prepareExisting(input) { return this.page.prepareExistingTask(input); }
  async reopen(input) { return this.page.reopenWorkspace(input); }
  async cleanup(input) { return this.page.deleteTaskProject({ ...input, project: input.state.task_project }); }
}
```

The Chat branch intentionally fails closed in 001; no UI exposes it yet.

- [ ] **Step 4: Route TaskRunner workspace-specific calls through the driver**

Keep `page` for shared model/patch operations. Add:

```js
this.workspace = workspaceDriver ?? new WorkspaceDriver({ page });
this.defaultWorkspaceMode = normalizeWorkspaceMode(defaultWorkspaceMode);
```

At claim time:

```js
state = createExecutionState(task, {
  lease: ...,
  localStartedAt: this.#isoNow(),
  workspaceMode: this.defaultWorkspaceMode
});
```

Replace direct Project-specific orchestration calls with the workspace seam while keeping Project progress payloads compatible in this patch. Do not alter Patch/WAIT_EXTERNAL/task-round functions.

- [ ] **Step 5: Wire service worker default to Project**

Add the internal setting default:

```js
workspaceMode: 'project'
```

Normalize it before passing to TaskRunner:

```js
defaultWorkspaceMode: normalizeWorkspaceMode(settings.workspaceMode)
```

Do not add the selector to `options.html` yet.

- [ ] **Step 6: Verify focused and full tests**

```bash
node --test tests/task-runner.test.js tests/service-worker-wiring.test.js
npm test
```

Expected: all existing Project behavior remains green.

- [ ] **Step 7: Add the approved spec/plan to the repository and produce Patch 001**

Add:

```text
docs/superpowers/specs/2026-09-01-chat-workspace-mode-design.md
docs/superpowers/plans/2026-09-01-chat-workspace-mode.md
```

Patch filename:

```text
browserplguin--ps-20260901-114430-db7b15--001-workspace-mode-foundation.patch
```

Metadata:

```text
# SEQUENCE=1
# PARENT_SEQUENCE=0
```

---

## Patch 002 — Normal Chat Creation and Dual-Artifact Initialization

### Task 3: Build the Chat initialization artifact bundle

**Files:**
- Create: `src/background/workspace-artifacts.js`
- Modify: `src/shared/task-schema.js`
- Modify: `src/background/task-runner.js`
- Modify: `src/background/workspace-driver.js`
- Test: `tests/task-schema.test.js`
- Test: `tests/task-runner.test.js`

**Interfaces:**
- Produces: `CHAT_INITIALIZATION_PROMPT`.
- Produces: `createRulesResource(rules)` returning Composer-compatible `{ filename, mimeType, size, base64 }`.
- Produces: `loadPreparedWorkspaceArtifacts()` result `{ source, rules }` for Chat mode; Project mode continues to initialize from source only while using Project Instructions for rules.

- [ ] **Step 1: Write failing prompt and artifact tests**

Assert the Chat Prompt contains all of these exact requirements:

```text
LLM_RULES.md
源码 ZIP
不要修改任何文件
不要执行任何具体业务 Task
不要生成 Git Patch
<INIT_STATUS>READY</INIT_STATUS>
```

Assert rules text containing non-ASCII Chinese round-trips through the generated UTF-8 base64 payload.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test tests/task-schema.test.js tests/task-runner.test.js
```

- [ ] **Step 3: Add `CHAT_INITIALIZATION_PROMPT`**

Use the approved wording from the spec verbatim and keep `INITIALIZATION_READY_MARKER` shared.

- [ ] **Step 4: Implement rules-text upload resource conversion**

`createRulesResource` must:

```js
const bytes = new TextEncoder().encode(rules.text);
```

encode bytes to base64 without `unescape/encodeURIComponent`, return MIME `text/markdown`, preserve `rules.filename || 'LLM_RULES.md'`, and reject missing/empty rules text with `RESOURCE_DOWNLOAD_FAILED`.

- [ ] **Step 5: Generalize source loading to return both prepared artifacts**

Rename the private loader conceptually from one resource to an artifact bundle:

```js
{
  state: current,
  artifacts: {
    source: await patchSyncClient.downloadSource(...),
    rules: createRulesResource(current.source_preparation.rules)
  }
}
```

The source ZIP remains the same bytes currently used by Project mode. No second PatchSync export may be created to obtain the rules file.

### Task 4: Add normal-Chat semantic operations and stable identity capture

**Files:**
- Modify: `src/shared/selector-registry.js`
- Modify: `src/content/conversation-manager.js`
- Modify: `src/content/chatgpt-adapter.js`
- Modify: `src/content/content-script.js`
- Modify: `src/background/browser-page-driver.js`
- Modify: `src/background/workspace-driver.js`
- Test: `tests/conversation-manager.test.js`
- Test: `tests/chatgpt-adapter.test.js`
- Test: `tests/browser-page-driver.test.js`
- Test: `tests/composer.test.js`

**Interfaces:**
- Produces content commands `CHATGPT_PREPARE_NEW_CHAT` and `CHATGPT_CONVERSATION_IDENTITY`.
- Produces `ConversationManager.prepareNewChat()` and `currentConversationIdentity()`.
- Produces `BrowserPageDriver.createTaskChat()`.
- Generalizes `BrowserPageDriver.initializeTask()` to accept `resources[]` and `initializationPrompt`.

- [ ] **Step 1: Write failing New Chat and identity tests**

Use DOM fixtures with a semantic New Chat control and assert `prepareNewChat()` clicks only the matching control, then requires a primary composer.

Identity tests:

```js
assert.deepEqual(manager.currentConversationIdentity('https://chatgpt.com/c/abc123?x=1#y'), {
  conversationUrl: 'https://chatgpt.com/c/abc123',
  conversationId: 'abc123'
});
assert.equal(manager.currentConversationIdentity('https://chatgpt.com/'), null);
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test tests/conversation-manager.test.js tests/chatgpt-adapter.test.js tests/browser-page-driver.test.js tests/composer.test.js
```

- [ ] **Step 3: Extend selector semantics for New Chat**

Add a conversation namespace with localized semantic patterns equivalent to:

```js
newChat: [/^new chat$/i, /^新聊天$/, /^新建聊天$/, /^新しいチャット$/i]
```

Keep actual DOM selection inside content code and selector registry; do not put raw selectors into TaskRunner.

- [ ] **Step 4: Add content commands**

Wire:

```js
case 'CHATGPT_PREPARE_NEW_CHAT': return adapter.prepareNewChat();
case 'CHATGPT_CONVERSATION_IDENTITY': return adapter.currentConversationIdentity();
```

`currentConversationIdentity()` must normalize only exact `https://chatgpt.com/c/<id>` paths and strip query/hash.

- [ ] **Step 5: Implement `BrowserPageDriver.createTaskChat()`**

Reuse the slot-owned tab acquisition behavior of `createTaskProject`, navigate the assigned tab to `https://chatgpt.com/`, then invoke `CHATGPT_PREPARE_NEW_CHAT`. Return:

```js
{
  projectName: null,
  browserWorkspaceId,
  patchSessionId,
  tabId,
  slotId,
  slotGeneration
}
```

Do not create/list/delete a Project in this path.

- [ ] **Step 6: Generalize attachment initialization**

Change `initializeTask` to accept:

```js
{
  resources: [resource1, resource2],
  initializationPrompt,
  ...
}
```

while preserving backward compatibility with existing `resource` calls during the patch transition.

Attach sequentially and wait for each existing `Composer.attachResource()` call to return before proceeding:

```js
for (const resource of resources) {
  await this.#send({ type: 'CHATGPT_ATTACH_RESOURCE', resource, options: this.#composerWaitOptions() });
  await hooks.onAttachmentReady?.({ filename: resource.filename });
}
```

Only after the loop completes call `onPromptIntent` and send the Prompt. Parameterize `#resumeInitializationIfAlreadySent` so it compares against the mode-specific expected Prompt instead of the global Project Prompt.

- [ ] **Step 7: Implement Chat WorkspaceDriver create/configure/initialize**

Chat behavior:

```text
create -> page.createTaskChat
configure -> no Project Instructions; return saved/no-op
initialize -> rules resource first, source ZIP second, CHAT_INITIALIZATION_PROMPT
```

After READY, call `CHATGPT_CONVERSATION_IDENTITY`/page helper and require a stable id. Persist it through generalized `recordCreatedWorkspace` or a focused `recordWorkspaceConversationIdentity` helper before TaskRunner sends the first formal Task Prompt.

If stable identity cannot be captured, throw a dedicated `CHAT_IDENTITY_MISSING` error added to `src/shared/errors.js`; do not continue formal Task execution.

- [ ] **Step 8: Add a TaskRunner integration test for the exact ordering**

Record calls and assert:

```text
create chat
attach LLM_RULES.md
attachment ready
attach source.zip
attachment ready
send Chat initialization Prompt
READY
persist conversation id
send formal Task Prompt
```

Assert the formal Task Prompt never occurs if either attachment throws or READY is missing.

- [ ] **Step 9: Verify Patch 002**

```bash
node --test tests/task-schema.test.js tests/task-runner.test.js tests/conversation-manager.test.js tests/chatgpt-adapter.test.js tests/browser-page-driver.test.js tests/composer.test.js
npm test
```

Patch filename:

```text
browserplguin--ps-20260901-114430-db7b15--002-chat-dual-artifact-initialization.patch
```

Metadata:

```text
# SEQUENCE=2
# PARENT_SEQUENCE=1
```

Chat mode remains not user-selectable from Options after this patch.

---

## Patch 003 — Exact Chat Recovery

### Task 5: Reopen Chat workspaces by persisted conversation identity

**Files:**
- Modify: `src/background/browser-page-driver.js`
- Modify: `src/background/workspace-driver.js`
- Modify: `src/background/task-runner.js`
- Modify: `src/shared/execution-state.js`
- Test: `tests/browser-page-driver.test.js`
- Test: `tests/task-runner.test.js`
- Test: `tests/response-recovery.test.js`

**Interfaces:**
- Produces `BrowserPageDriver.prepareExistingChat({ ... })`.
- Produces `BrowserPageDriver.reopenChatWorkspace({ state })`.
- WorkspaceDriver routes `prepareExisting/reopen` by captured state mode.
- Chat recovery requires `chatgpt_conversation_url` or `task_workspace.conversation_url` established by Patch 002.

- [ ] **Step 1: Write failing recovery tests for tab survival variants**

Cover:

```text
owned tab exists on exact URL -> reuse
owned tab exists but is discarded -> reload
owned tab exists on wrong URL -> navigate exact conversation URL
owned tab missing -> create slot-owned tab and navigate exact conversation URL
```

Assert no test searches the sidebar by title.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test tests/browser-page-driver.test.js tests/task-runner.test.js tests/response-recovery.test.js
```

- [ ] **Step 3: Implement exact Chat prepare/reopen**

`prepareExistingChat` validates:

```js
const conversationUrl = normalizeConversationUrl(
  task.chatgpt_conversation_url ?? task.task_workspace?.conversation_url
);
if (!conversationUrl) throw new RunnerError(ERROR_CODES.CHAT_IDENTITY_MISSING, ...);
```

After navigating/reloading, require `CHATGPT_RESOLVE_CHAT`, then fetch `CHATGPT_CONVERSATION_IDENTITY` and compare `conversationId` with the persisted id. Mismatch throws `TASK_RECOVERY_BLOCKED`; it must never replay a Prompt into the wrong conversation.

- [ ] **Step 4: Make initialization local recovery mode-aware**

Replace Project-name prerequisites in `#recoverInitializationInPlace` with workspace identity through `this.workspace`. For Chat mode:

```text
attempt 1 -> reload exact owned tab/conversation
attempt 2 -> reopen exact conversation URL
```

Project behavior remains reload then reopen Project.

- [ ] **Step 5: Make workspace recreation mode-aware**

Generalize the existing `#restartInitializationWorkspace` logic:

- Project: keep delete/recreate with `-rN` Project names.
- Chat: cleanup/abandon the exact failed conversation when provable, create New Chat, reattach both artifacts, redo initialization.

Replace Project-only orphan entries with generic owned workspace entries:

```js
{
  mode: 'chat',
  conversation_id: '...',
  conversation_url: '...',
  error: { code, message }
}
```

Continue accepting legacy `{ project_name, error }` entries.

- [ ] **Step 6: Add crash-checkpoint tests**

At minimum cover durable recovery after:

```text
New Chat before attachments
first attachment ready
both attachments ready before Prompt
PROMPT_SENT before READY
READY before formal Task Prompt
normal task-round PROMPT_SENT
WAIT_EXTERNAL
```

The existing round checkpoint logic stays shared; tests assert Chat mode reopens exact conversation before reconciliation.

- [ ] **Step 7: Verify Patch 003**

```bash
node --test tests/browser-page-driver.test.js tests/task-runner.test.js tests/response-recovery.test.js tests/execution-state.test.js
npm test
```

Patch filename:

```text
browserplguin--ps-20260901-114430-db7b15--003-exact-chat-recovery.patch
```

Metadata:

```text
# SEQUENCE=3
# PARENT_SEQUENCE=2
```

---

## Patch 004 — Exact Conversation Cleanup

### Task 6: Delete only the owned conversation by exact id/href

**Files:**
- Modify: `src/shared/selector-registry.js`
- Modify: `src/content/conversation-manager.js`
- Modify: `src/content/chatgpt-adapter.js`
- Modify: `src/content/content-script.js`
- Modify: `src/background/browser-page-driver.js`
- Modify: `src/background/workspace-driver.js`
- Modify: `src/background/task-runner.js`
- Modify: `src/shared/errors.js`
- Test: `tests/conversation-manager.test.js`
- Test: `tests/chatgpt-adapter.test.js`
- Test: `tests/browser-page-driver.test.js`
- Test: `tests/task-runner.test.js`
- Test: `tests/selector-registry.test.js`

**Interfaces:**
- Produces content command `CHATGPT_DELETE_CONVERSATION` with `{ conversationId }`.
- Produces `ConversationManager.deleteConversationById(conversationId)`.
- Produces `BrowserPageDriver.deleteTaskChat({ state })`.
- WorkspaceDriver `cleanup()` routes to exact Project or exact Chat deletion.

- [ ] **Step 1: Write failing exact-target safety tests**

DOM fixture contains two chats with different titles and ids. Request deletion of `conv-b` and assert only the anchor whose normalized href is `/c/conv-b` has its menu opened.

Also test:

```text
same visible title, different ids -> exact id wins
requested id already absent -> idempotent { deleted:false, alreadyMissing:true }
no exact id but several chats present -> delete nothing
exact row found but menu/delete semantics ambiguous -> throw UI_SELECTOR_INCOMPATIBLE; delete nothing else
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test tests/conversation-manager.test.js tests/chatgpt-adapter.test.js tests/browser-page-driver.test.js tests/task-runner.test.js tests/selector-registry.test.js
```

- [ ] **Step 3: Add conversation delete semantics to selector registry**

Add localized patterns for conversation row menu, Delete, and confirm Delete under the conversation namespace. Keep Project delete patterns untouched.

- [ ] **Step 4: Implement exact-id deletion in content code**

Algorithm:

```text
normalize requested conversation id
find anchor/row with href resolving exactly to /c/<requested id>
if absent -> return alreadyMissing
open only that row's associated menu
select semantic Delete
confirm destructive action
wait until exact href disappears
return deleted
```

Never use row text/title as ownership evidence.

- [ ] **Step 5: Implement BrowserPageDriver Chat cleanup**

Resolve owned tab when available. If the owned tab is missing, create/navigate a safe ChatGPT tab only when necessary for exact sidebar cleanup; send `CHATGPT_DELETE_CONVERSATION` with the durable id.

Return a deferred result instead of guessing when identity is missing:

```js
{ deleted: false, deferred: true, reason: 'conversation_identity_missing' }
```

- [ ] **Step 6: Generalize TaskRunner terminal cleanup**

Rename the Project-specific private cleanup concept to workspace cleanup and route through `WorkspaceDriver.cleanup`.

Preserve existing timing: cleanup happens only from `#finalizeAndCleanup`/cleanup recovery after terminal semantics permit it. Chat mode success updates `task_workspace.status='deleted'`; Project mode continues to update both generic and legacy status.

Report generic progress such as:

```js
{
  type: 'TASK_WORKSPACE_DELETED',
  workspace_mode: state.workspace_mode,
  browser_workspace_id: state.browser_workspace_id,
  patch_session_id: ...
}
```

Continue emitting the legacy `TASK_PROJECT_DELETED` event for Project mode if server compatibility currently depends on it.

- [ ] **Step 7: Preserve reusable slot tab behavior**

After Chat deletion call the existing `releaseTaskTab`. Assert the managed tab remains reusable/navigated to New Chat rather than being unconditionally closed.

- [ ] **Step 8: Test cleanup recovery and idempotency**

TaskRunner tests must cover:

```text
Chat terminal -> exact delete -> store cleared/terminal sent
Chat delete UI failure -> phase CLEANUP with next_recovery_at
recovery rerun after conversation already absent -> cleanup succeeds idempotently
Project terminal -> existing Project delete path unchanged
```

- [ ] **Step 9: Verify Patch 004**

```bash
node --test tests/conversation-manager.test.js tests/chatgpt-adapter.test.js tests/browser-page-driver.test.js tests/task-runner.test.js tests/selector-registry.test.js
npm test
```

Patch filename:

```text
browserplguin--ps-20260901-114430-db7b15--004-exact-chat-cleanup.patch
```

Metadata:

```text
# SEQUENCE=4
# PARENT_SEQUENCE=3
```

---

## Patch 005 — User Mode Switch, Runtime Visibility, Calibration, and Documentation

### Task 7: Expose the mode selector only after Chat lifecycle is complete

**Files:**
- Modify: `src/ui/options.html`
- Modify: `src/ui/options.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/ui/popup.js`
- Modify: `src/shared/runner-status.js`
- Test: `tests/ui-files.test.js`
- Test: `tests/service-worker-wiring.test.js`
- Test: `tests/runner-status.test.js`

**Interfaces:**
- User setting: `workspaceMode: 'project' | 'chat'`.
- Durable execution field remains `workspace_mode`.
- Active Task card reads captured `active.workspace_mode`, not current settings.

- [ ] **Step 1: Write failing UI/default/immutability tests**

Assert Options contains:

```html
<select id="workspaceMode">
  <option value="project">Project</option>
  <option value="chat">普通聊天</option>
</select>
```

and supporting copy equivalent to:

```text
仅影响之后领取的新 Task；运行中的 Task 保持原模式。
```

Assert missing/invalid stored setting renders Project. Assert active Task card displays `Workspace: Chat` when durable state says Chat even if settings now say Project.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test tests/ui-files.test.js tests/service-worker-wiring.test.js tests/runner-status.test.js
```

- [ ] **Step 3: Wire Options persistence**

Add `workspaceMode` to `ids`, load/save it through the existing settings message path, and normalize in service worker with `normalizeWorkspaceMode` before constructing each runner.

No active state may be rewritten when `SAVE_SETTINGS` changes this value.

- [ ] **Step 4: Render captured mode in active Task cards**

Add to each active card metadata:

```js
const workspace = active.workspace_mode === 'chat' ? 'Chat' : 'Project';
meta.textContent = [
  `Workspace: ${workspace}`,
  slot.slot_id,
  Number.isInteger(active.chatgpt_tab_id) ? `tab ${active.chatgpt_tab_id}` : null,
  active.in_flight_stage
].filter(Boolean).join(' · ');
```

Optionally update the detailed panel's `activeProject` label/value so Chat mode does not misleadingly show `-` as if Project creation failed; display workspace mode separately.

### Task 8: Add selector calibration coverage and safe observability

**Files:**
- Modify: `src/shared/calibration-campaign.js`
- Modify: `src/content/calibration-matrix.js`
- Modify: `src/shared/calibration-coverage.js`
- Modify: `src/shared/selector-calibration-delta.js` only if the current delta model needs the new semantic operations
- Modify: `src/background/ui-compatibility-telemetry.js` only if new operation names require allowlisting
- Test: `tests/calibration-campaign.test.js`
- Test: `tests/calibration-matrix.test.js`
- Test: `tests/calibration-coverage.test.js`
- Test: `tests/ui-compatibility-telemetry.test.js`

**Interfaces:**
- Adds calibration surfaces for New Chat and exact conversation delete.
- Telemetry may expose operation/result/mode but not Prompt text, attachment content, conversation title, or full URL.

- [ ] **Step 1: Write failing calibration coverage tests**

Require campaign ids equivalent to:

```text
new_chat
conversation_delete
```

and verify expected page categories include `home/chat` as appropriate.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test tests/calibration-campaign.test.js tests/calibration-matrix.test.js tests/calibration-coverage.test.js tests/ui-compatibility-telemetry.test.js
```

- [ ] **Step 3: Implement semantic calibration probes**

Probes report only semantic availability/fingerprint data. They must not delete a real conversation during passive calibration; destructive delete confirmation is covered by controlled E2E/manual evidence only.

### Task 9: Update architecture/state-machine/operator docs and final verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHATGPT_AUTOMATION.md`
- Modify: `STATE_MACHINE.md`
- Modify: `TASK_PROTOCOL.md` only where workspace-mode state/progress semantics need documenting
- Modify: `TODO.md` to reflect any live-DOM calibration items that remain objectively unverified
- Test: `tests/ui-files.test.js`
- Test: `tests/release-readiness.test.js`
- Test: `tests/live-calibration-integration.test.js`

**Interfaces:**
- Documents two workspace modes and exact lifecycle/ownership rules.
- Does not mark live UI calibration complete unless actual evidence exists.

- [ ] **Step 1: Update docs with the final lifecycle**

Document this common flow:

```text
claim -> capture workspace_mode -> PatchSync export
  project: create Project -> Project Instructions -> source ZIP -> READY
  chat: New Chat -> LLM_RULES.md -> source ZIP -> Chat init Prompt -> READY -> capture conversation id
shared Task rounds -> PatchSync/WAIT_EXTERNAL -> terminal -> mode-specific exact cleanup
```

Explicitly state Chat cleanup identity is `/c/<conversation_id>`, never title.

- [ ] **Step 2: Run complete regression verification**

Run focused final checks:

```bash
node --test tests/ui-files.test.js tests/release-readiness.test.js tests/live-calibration-integration.test.js
```

Then run the repository-required command:

```bash
npm test
```

Expected: zero failing tests. If live ChatGPT DOM evidence is unavailable, keep the relevant calibration item open in `TODO.md` and state that limitation; do not convert missing live evidence into a pass claim.

- [ ] **Step 3: Produce Patch 005**

Patch filename:

```text
browserplguin--ps-20260901-114430-db7b15--005-workspace-mode-ui-and-hardening.patch
```

Metadata:

```text
# SEQUENCE=5
# PARENT_SEQUENCE=4
```

---

## Final Acceptance Gate

Before declaring the feature complete, verify every item below against code plus fresh test output:

- [ ] Existing/no-setting installations run `project` mode.
- [ ] A claimed Task persists `workspace_mode` exactly once and ignores later preference changes.
- [ ] Project mode still creates/configures/deletes Projects using existing behavior.
- [ ] Chat mode starts a normal Chat and creates no Project.
- [ ] Chat mode attaches `LLM_RULES.md` first and the current source ZIP second.
- [ ] Initialization Prompt is blocked until both owned attachments are ready.
- [ ] Formal Task Prompt is blocked until exact READY marker.
- [ ] Chat conversation URL/id is persisted before formal Task work.
- [ ] Shared Task rounds/Patch handling are used by both modes.
- [ ] Recovery navigates to exact persisted `/c/<id>` and rejects identity mismatch.
- [ ] Initialization recreation creates a new Chat only within bounded workspace retry policy.
- [ ] Terminal cleanup deletes only exact owned conversation id/href.
- [ ] Missing/ambiguous cleanup identity deletes nothing and becomes deferred/recoverable.
- [ ] Chat cleanup can leave the managed slot tab reusable.
- [ ] Active Task UI displays captured workspace mode.
- [ ] Changing the default mode while a Task runs affects only future claims.
- [ ] Full `npm test` exits 0.
