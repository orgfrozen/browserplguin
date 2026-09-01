import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPageDriver } from '../src/background/browser-page-driver.js';
import { CHAT_INITIALIZATION_PROMPT, INITIALIZATION_PROMPT, INITIALIZATION_READY_MARKER } from '../src/shared/task-schema.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

function fakeTabManager(script) {
  const messages = [];
  return {
    messages,
    async findChatGptTab() { return { id: 7 }; },
    async send(_tabId, message) {
      messages.push(message);
      return script(message, messages.length - 1);
    }
  };
}

test('prepare existing task requires durable project/session mapping for recovery only', async () => {
  const driver = new BrowserPageDriver({ tabManager: fakeTabManager(() => ({})), sleep: async () => {} });
  await assert.rejects(
    driver.prepareExistingTask({ task_id: 't1', project_id: 'vetatool', task_prompt: 'x' }),
    error => error instanceof RunnerError && error.code === ERROR_CODES.PROJECT_NOT_FOUND
  );
});



test('prepareExistingTask reopens the exact persisted conversation before project fallback', async () => {
  const actions = [];
  const tabManager = {
    async findChatGptTab() { return { id: 7, url: 'https://chatgpt.com/' }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(_tabId, message) { actions.push(`send:${message.type}`); return message.type === 'CHATGPT_RESOLVE_CHAT' ? { composerPresent: true } : {}; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  await driver.prepareExistingTask({
    task_id: 't1',
    project_id: 'vetatool',
    chatgpt_project_name: 'vetatool_ewan_1',
    chatgpt_conversation_url: 'https://chatgpt.com/c/conversation-123?utm_source=x#frag',
    session_id: 's1'
  });

  assert.deepEqual(actions, [
    'navigate:7:https://chatgpt.com/c/conversation-123',
    'send:CHATGPT_RESOLVE_CHAT'
  ]);
});

test('discoverCurrentPatches checks the already-open conversation before recovery navigation', async () => {
  const actions = [];
  const tabManager = {
    async findChatGptTab() { actions.push('find'); return { id: 7, url: 'https://chatgpt.com/c/current' }; },
    async send(_tabId, message) {
      actions.push(message.type);
      if (message.type === 'CHATGPT_DISCOVER_PATCHES') {
        return [{ filename: 'browserplguin--s1--001-current.patch', url: 'blob:current', clickToken: 'current-1' }];
      }
      return {};
    }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  const patches = await driver.discoverCurrentPatches({ state: { session_id: 's1', downloaded_patch_keys: [] }, settle: true });

  assert.equal(patches.length, 1);
  assert.equal(patches[0].filename, 'browserplguin--s1--001-current.patch');
  assert.deepEqual(actions, ['find', 'CHATGPT_DISCOVER_PATCHES']);
});

test('runRound observes generating then ready and returns stabilized response plus patches', async () => {
  const states = [
    { state: 'GENERATING', contextLimit: false },
    { state: 'GENERATING', contextLimit: false },
    { state: 'READY', contextLimit: false }
  ];
  let stateIndex = 0;
  let latestReads = 0;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_OPEN_PROJECT') return { name: message.projectName };
    if (message.type === 'CHATGPT_RESOLVE_CHAT') return { composerPresent: true };
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') { latestReads++; return { text: '<TASK_STATUS>DONE</TASK_STATUS>' }; }
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [{ filename: 'patch-s1-001.patch', url: 'blob:x', clickToken: 'c1' }];
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 2, pollMs: 1 });
  await driver.prepareExistingTask({ task_id: 't1', project_id: 'vetatool', task_prompt: 'x', chatgpt_project_name: 'vetatool2026081314', session_id: 's1' });
  const round = await driver.runRound({ task: { task_id: 't1' }, state: { session_id: 's1', downloaded_patch_keys: [] }, prompt: 'fix' });
  assert.equal(round.assistantText, '<TASK_STATUS>DONE</TASK_STATUS>');
  assert.equal(round.patches[0].tabId, 7);
  assert.ok(latestReads >= 2);
});

test('runRound emits generation telemetry without exposing prompt text', async () => {
  const events = [];
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_OPEN_PROJECT') return { name: message.projectName };
    if (message.type === 'CHATGPT_RESOLVE_CHAT') return { composerPresent: true };
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: '<TASK_STATUS>DONE</TASK_STATUS>' };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    stableReadsRequired: 1,
    pollMs: 1,
    onGenerationEvent: event => events.push(structuredClone(event))
  });
  await driver.prepareExistingTask({ task_id: 't1', project_id: 'vetatool', chatgpt_project_name: 'vetatool_ewan_1', session_id: 's1' });

  await driver.runRound({
    task: { task_id: 't1' },
    state: { task_id: 't1', session_id: 's1', downloaded_patch_keys: [] },
    prompt: 'secret prompt text',
    promptType: 'continuation'
  });

  assert.deepEqual(events.map(event => [event.phase, event.type]), [
    ['submitted', 'continuation'],
    ['started', 'continuation'],
    ['finished', 'continuation']
  ]);
  assert.equal(events[0].taskId, 't1');
  assert.equal(JSON.stringify(events).includes('secret prompt text'), false);
});

test('runRound settles briefly when the Patch control appears after the assistant text is stable', async () => {
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  let discoveryReads = 0;
  const sleeps = [];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_OPEN_PROJECT') return { name: message.projectName };
    if (message.type === 'CHATGPT_RESOLVE_CHAT') return { composerPresent: true };
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: '<TASK_STATUS>DONE</TASK_STATUS>\n下载patch 001：修复状态同步' };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') {
      discoveryReads += 1;
      return discoveryReads === 1 ? [] : [{ filename: 'browserplguin--s1--001-late.patch', url: 'blob:late', clickToken: 'late-1' }];
    }
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async ms => { sleeps.push(ms); },
    stableReadsRequired: 1,
    pollMs: 1,
    patchDiscoverySettlePollMs: 25,
    patchDiscoverySettleAttempts: 3
  });
  await driver.prepareExistingTask({ task_id: 't1', project_id: 'browserplguin', task_prompt: 'fix', chatgpt_project_name: 'browserplguin_ewan_1', session_id: 's1' });

  const round = await driver.runRound({ task: { task_id: 't1' }, state: { session_id: 's1', downloaded_patch_keys: [] }, prompt: 'fix' });

  assert.equal(round.patches.length, 1);
  assert.equal(round.patches[0].filename, 'browserplguin--s1--001-late.patch');
  assert.equal(discoveryReads, 2);
  assert.ok(sleeps.includes(25));
});

test('context length signal returns terminal contextLimit result', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_OPEN_PROJECT') return {};
    if (message.type === 'CHATGPT_RESOLVE_CHAT') return { composerPresent: true };
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return { state: 'READY', contextLimit: true };
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });
  await driver.prepareExistingTask({ task_id: 't1', project_id: 'vetatool', task_prompt: 'x', chatgpt_project_name: 'p', session_id: 's1' });
  assert.deepEqual(await driver.runRound({ task: { task_id: 't1' }, state: { session_id: 's1' }, prompt: 'x' }), { contextLimit: true, assistantText: '', patches: [] });
});

test('createTaskProject uses server project/task context and authoritative LLM rules without inventing a Patch session', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_LIST_PROJECTS') return [{ name: 'vetatool_ewan_202608131530', href: '/project/old' }];
    if (message.type === 'CHATGPT_CREATE_PROJECT') return { name: message.projectName, href: '/project/new' };
    if (message.type === 'CHATGPT_SET_PROJECT_INSTRUCTIONS') return { saved: true };
    if (message.type === 'CHATGPT_RESOLVE_CHAT') return { composerPresent: true };
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager, sleep: async () => {}, now: () => new Date('2026-08-13T15:30:00+08:00'), timeZone: 'Asia/Shanghai'
  });
  const task = { task_id: 't1', project_id: 'vetatool', agent_control: { assignment_id: 'assignment-1' } };
  const state = {
    assignment_id: 'assignment-1',
    browser_execution_bootstrap: {
      project: { project_id: 'vetatool', name: 'VetaTool', description: '海外工具站', goal: '稳定增长' },
      task: { task_id: 't1', title: '修复登录', goal: '登录稳定', instructions: ['不要无关重构'], acceptance: { min_successful_patches: 1 } }
    },
    source_preparation: { patch_session_id: 'ps-20260817-abc123', rules: { text: '# PATCH_SESSION_ID=ps-20260817-abc123' } }
  };
  const result = await driver.createTaskProject({ task, state });
  assert.deepEqual(result, { projectName: 'vetatool_ewan_202608131530-02', browserWorkspaceId: 'assignment-1', patchSessionId: 'ps-20260817-abc123', tabId: 7 });
  assert.equal(tabManager.messages.some(message => message.type === 'CHATGPT_SET_PROJECT_INSTRUCTIONS'), false);

  await driver.configureTaskProject({ task, state: { ...state, chatgpt_project_name: result.projectName } });
  const instructions = tabManager.messages.find(message => message.type === 'CHATGPT_SET_PROJECT_INSTRUCTIONS');
  assert.match(instructions.text, /海外工具站/);
  assert.doesNotMatch(instructions.text, /修复登录/);
  assert.doesNotMatch(instructions.text, /登录稳定/);
  assert.match(instructions.text, /正式 Task Prompt/);
  assert.match(instructions.text, /# PATCH_SESSION_ID=ps-20260817-abc123/);
  assert.doesNotMatch(instructions.text, /当前执行 Session ID/);
  assert.ok(tabManager.messages.some(message => message.type === 'CHATGPT_RESOLVE_CHAT'));
});

test('deleteTaskProject delegates exact owned project cleanup to the content script', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_DELETE_PROJECT') return { deleted: true, name: message.projectName };
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {} });
  driver.tabId = 7;
  const result = await driver.deleteTaskProject({ project: { project_name: 'vetatool2026081315', session_id: 's1' } });
  assert.deepEqual(result, { deleted: true, name: 'vetatool2026081315' });
  assert.ok(tabManager.messages.some(message => message.type === 'CHATGPT_DELETE_PROJECT' && message.projectName === 'vetatool2026081315'));
  assert.equal(typeof driver.migrateTask, 'undefined');
});



test('createTaskProject cleans only same-project ewan workspaces before first creation when enabled', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_LIST_PROJECTS') return [
      { name: 'vetatool_ewan_202608221005' },
      { name: 'vetatool_ewan_202608221130' },
      { name: 'patchsync_ewan_202608221130' },
      { name: 'vetatool2026082211' }
    ];
    if (message.type === 'CHATGPT_DELETE_PROJECT') return { deleted: true, name: message.projectName };
    if (message.type === 'CHATGPT_CREATE_PROJECT') return { name: message.projectName };
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    cleanupLegacyProjects: true,
    now: () => new Date('2026-08-23T10:42:00+08:00'),
    timeZone: 'Asia/Shanghai'
  });

  const result = await driver.createTaskProject({ task: { project_id: 'vetatool' }, state: {} });
  assert.equal(result.projectName, 'vetatool_ewan_202608231042');
  const actions = tabManager.messages.filter(message => ['CHATGPT_DELETE_PROJECT', 'CHATGPT_CREATE_PROJECT'].includes(message.type));
  assert.deepEqual(actions, [
    { type: 'CHATGPT_DELETE_PROJECT', projectName: 'vetatool_ewan_202608221005' },
    { type: 'CHATGPT_DELETE_PROJECT', projectName: 'vetatool_ewan_202608221130' },
    { type: 'CHATGPT_CREATE_PROJECT', projectName: 'vetatool_ewan_202608231042' }
  ]);
});

test('legacy cleanup rescans sidebar Projects until all same-project legacy workspaces are removed', async () => {
  const remaining = ['vetatool_ewan_202608221005', 'vetatool_ewan_202608221130'];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_LIST_PROJECTS') {
      return remaining.length > 0 ? [{ name: remaining[0] }] : [];
    }
    if (message.type === 'CHATGPT_DELETE_PROJECT') {
      assert.equal(message.projectName, remaining[0]);
      remaining.shift();
      return { deleted: true, name: message.projectName };
    }
    if (message.type === 'CHATGPT_CREATE_PROJECT') return { name: message.projectName };
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    cleanupLegacyProjects: true,
    now: () => new Date('2026-08-23T10:42:00+08:00'),
    timeZone: 'Asia/Shanghai'
  });

  const result = await driver.createTaskProject({ task: { project_id: 'vetatool' }, state: {} });

  assert.deepEqual(remaining, []);
  assert.deepEqual(result.legacyProjectCleanup, {
    status: 'completed',
    scanned: 2,
    matched: 2,
    deleted: 2,
    failed: 0
  });
});

test('legacy cleanup preserves a recovered creation-intent Project while deleting older siblings', async () => {
  const intended = 'vetatool_ewan_202608231042';
  const visible = [
    { name: 'vetatool_ewan_202608221005' },
    { name: intended }
  ];
  const deleted = [];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_LIST_PROJECTS') return visible.filter(project => !deleted.includes(project.name));
    if (message.type === 'CHATGPT_DELETE_PROJECT') {
      deleted.push(message.projectName);
      return { deleted: true, name: message.projectName };
    }
    if (message.type === 'CHATGPT_CREATE_PROJECT') throw new Error('existing creation intent must be reused');
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    cleanupLegacyProjects: true,
    now: () => new Date('2026-08-23T10:42:00+08:00'),
    timeZone: 'Asia/Shanghai'
  });

  const result = await driver.createTaskProject({
    task: { project_id: 'vetatool' },
    state: {},
    creationIntentProjectName: intended
  });

  assert.deepEqual(deleted, ['vetatool_ewan_202608221005']);
  assert.equal(result.projectName, intended);
  assert.equal(result.legacyProjectCleanup.deleted, 1);
  assert.equal(result.legacyProjectCleanup.failed, 0);
});

test('legacy cleanup is best-effort and does not run for replacement workspace recovery', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_LIST_PROJECTS') return [{ name: 'vetatool_ewan_202608221005' }];
    if (message.type === 'CHATGPT_DELETE_PROJECT') return { ok: false, error: { code: 'UI_SELECTOR_INCOMPATIBLE', message: 'delete control changed' } };
    if (message.type === 'CHATGPT_CREATE_PROJECT') return { name: message.projectName };
    return {};
  });
  const warnings = [];
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    cleanupLegacyProjects: true,
    onLegacyProjectCleanupWarning: warning => warnings.push(warning),
    now: () => new Date('2026-08-23T10:42:00+08:00'),
    timeZone: 'Asia/Shanghai'
  });

  const first = await driver.createTaskProject({ task: { project_id: 'vetatool' }, state: {} });
  assert.equal(first.projectName, 'vetatool_ewan_202608231042');
  assert.equal(warnings.length, 1);

  tabManager.messages.length = 0;
  warnings.length = 0;
  const replacement = await driver.createTaskProject({
    task: { project_id: 'vetatool' },
    state: { task_project: { project_name: 'vetatool_ewan_202608231042', status: 'active' } },
    preferredProjectName: 'vetatool_ewan_202608231042-r1'
  });
  assert.equal(replacement.projectName, 'vetatool_ewan_202608231042-r1');
  assert.equal(tabManager.messages.some(message => message.type === 'CHATGPT_DELETE_PROJECT'), false);
  assert.equal(warnings.length, 0);
});

test('initializeTask downloads resource, attaches it, waits for initialization response, and does not discover patches', async () => {
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const loaded = [];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') return { attached: true, filename: message.resource.filename };
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: INITIALIZATION_READY_MARKER };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') throw new Error('initialization must not discover patches');
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    resourceLoader: { async load(resource) { loaded.push(resource); return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID', sourceUrl: resource.url }; } },
    sleep: async () => {}, stableReadsRequired: 1, pollMs: 1
  });
  driver.tabId = 7;
  const task = { resource: { url: 'https://assets.example.com/source.zip' }, initialization_prompt: '执行 SEO 优化并生成 Patch' };
  const result = await driver.initializeTask({ task, state: { session_id: 's1' } });
  assert.deepEqual(loaded, [task.resource]);
  assert.equal(result.contextLimit, false);
  assert.equal(result.assistantText, INITIALIZATION_READY_MARKER);
  assert.ok(tabManager.messages.some(message => message.type === 'CHATGPT_ATTACH_RESOURCE' && message.resource.filename === 'source.zip'));
  const initPrompt = tabManager.messages.find(message => message.type === 'CHATGPT_SEND_PROMPT');
  assert.equal(initPrompt.text, INITIALIZATION_PROMPT);
  assert.doesNotMatch(initPrompt.text, /SEO|优化并生成 Patch/i);
});


test('initializeTask rejects an initialization response that does not include the explicit READY marker', async () => {
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') return { attached: true };
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: '项目已经分析完成，可以开始修改。' };
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {}, stableReadsRequired: 1, pollMs: 1
  });
  driver.tabId = 7;

  await assert.rejects(
    driver.initializeTask({ task: { resource: { url: 'https://assets.example.com/source.zip' } }, resource: { filename: 'source.zip', base64: 'AQID' } }),
    error => error?.code === 'INITIALIZATION_PROTOCOL_MISSING'
  );
});


test('initializeTask rejects extra execution output even when the READY marker is present', async () => {
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') return { attached: true };
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: `我已经修改文件并生成 Patch。 ${INITIALIZATION_READY_MARKER}` };
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;

  await assert.rejects(
    driver.initializeTask({ task: { resource: { url: 'https://assets.example.com/source.zip' } }, resource: { filename: 'source.zip', base64: 'AQID' } }),
    error => error?.code === 'INITIALIZATION_PROTOCOL_MISSING'
  );
});


test('initializeTask exposes resource downloaded and attached hooks only after successful stages', async () => {
  const events = [];
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') { events.push('attach-command'); return { attached: true, filename: message.resource.filename }; }
    if (message.type === 'CHATGPT_SEND_PROMPT') { events.push('send-prompt'); return { ok: true }; }
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: INITIALIZATION_READY_MARKER };
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    resourceLoader: { async load() { events.push('load'); return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; } },
    sleep: async () => {}, stableReadsRequired: 1, pollMs: 1
  });
  driver.tabId = 7;
  await driver.initializeTask({
    task: { resource: { url: 'https://assets.example.com/source.zip' }, initialization_prompt: 'analyze' },
    hooks: {
      async onResourceDownloaded() { events.push('hook-downloaded'); },
      async onResourceAttached() { events.push('hook-attached'); }
    }
  });
  assert.deepEqual(events.slice(0, 5), ['load', 'hook-downloaded', 'attach-command', 'hook-attached', 'send-prompt']);
});

test('runRound checkpoints prompt sent and response ready in page side-effect order', async () => {
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const events = [];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_SEND_PROMPT') { events.push('send'); return { ok: true }; }
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: 'done' };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;
  await driver.runRound({
    task: { task_id: 't1' },
    state: { session_id: 's1', downloaded_patch_keys: [] },
    prompt: 'fix',
    hooks: {
      async onPromptSent() { events.push('checkpoint-sent'); },
      async onResponseReady(text) { events.push(`checkpoint-ready:${text}`); }
    }
  });
  assert.deepEqual(events, ['send', 'checkpoint-sent', 'checkpoint-ready:done']);
});

test('recoverRound safely sends a checkpointed prompt only when page proves it was not sent', async () => {
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const events = [];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') return {
      state: 'READY', contextLimit: false, latestUserText: 'previous prompt', latestAssistantText: 'previous answer', latestRole: 'assistant'
    };
    if (message.type === 'CHATGPT_SEND_PROMPT') { events.push('send'); return { ok: true }; }
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: 'new answer' };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;
  const result = await driver.recoverRound({
    task: { task_id: 't1' },
    state: { session_id: 's1', downloaded_patch_keys: [] },
    checkpoint: { round_number: 1, prompt: 'fix now', stage: 'READY_TO_SEND', assistant_text: null },
    hooks: { async onPromptSent() { events.push('sent'); }, async onResponseReady() { events.push('ready'); } }
  });
  assert.equal(result.assistantText, 'new answer');
  assert.deepEqual(events, ['send', 'sent', 'ready']);
});

test('recoverRound continues an already generating prompt without resending it', async () => {
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const messages = [];
  const tabManager = fakeTabManager(message => {
    messages.push(message.type);
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') return {
      state: 'GENERATING', contextLimit: false, latestUserText: 'fix now', latestAssistantText: '', latestRole: 'user'
    };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: 'finished answer' };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
    if (message.type === 'CHATGPT_SEND_PROMPT') throw new Error('must not resend');
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;
  const result = await driver.recoverRound({
    task: { task_id: 't1' },
    state: { session_id: 's1', downloaded_patch_keys: [] },
    checkpoint: { round_number: 2, prompt: 'fix now', stage: 'PROMPT_SENT', assistant_text: null },
    hooks: { async onResponseReady() {} }
  });
  assert.equal(result.assistantText, 'finished answer');
  assert.equal(messages.includes('CHATGPT_SEND_PROMPT'), false);
});


test('recoverRound safely adopts a newer assistant Patch when the persisted prompt is stale but the Patch is the next current-session sequence', async () => {
  const sessionId = 'ps-20260828-111310-b7ac6b';
  const filename = `zeroparse--${sessionId}--004-smoke-version-override.patch`;
  const events = [];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') return {
      state: 'READY',
      contextLimit: false,
      latestUserText: 'server continuation prompt that advanced after the durable checkpoint',
      latestAssistantText: `done\n下载patch 004：smoke\n${filename}`,
      latestRole: 'assistant'
    };
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return {
      text: `done\n下载patch 004：smoke\n${filename}`
    };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') {
      return [{ filename, url: 'blob:patch-004', clickToken: 'patch-004' }];
    }
    if (message.type === 'CHATGPT_SEND_PROMPT') throw new Error('must not resend while reconciling');
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;

  const result = await driver.recoverRound({
    task: { task_id: 't1' },
    state: {
      patch_session_id: sessionId,
      session_id: sessionId,
      downloaded_patch_keys: [
        `zeroparse--${sessionId}--001-first.patch`,
        `zeroparse--${sessionId}--002-second.patch`,
        `zeroparse--${sessionId}--003-third.patch`
      ]
    },
    checkpoint: { round_number: 4, prompt: 'persisted older prompt', stage: 'PROMPT_SENT', assistant_text: null },
    hooks: {
      async onMeaningfulProgress(kind) { events.push(`progress:${kind}`); },
      async onResponseReady(text) { events.push(`ready:${text.includes(filename)}`); }
    }
  });

  assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].filename, filename);
  assert.ok(events.includes('progress:response_reconciled'));
  assert.ok(events.includes('ready:true'));
});

test('recoverRound refuses a stale-prompt assistant Patch that jumps beyond the next sequence', async () => {
  const sessionId = 'ps-20260828-111310-b7ac6b';
  const filename = `zeroparse--${sessionId}--006-unsafe-jump.patch`;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') return {
      state: 'READY',
      contextLimit: false,
      latestUserText: 'different newer prompt',
      latestAssistantText: `下载patch 006：unsafe\n${filename}`,
      latestRole: 'assistant'
    };
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: `下载patch 006：unsafe\n${filename}` };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [{ filename, url: 'blob:unsafe', clickToken: 'unsafe' }];
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;

  await assert.rejects(
    driver.recoverRound({
      task: { task_id: 't1' },
      state: {
        patch_session_id: sessionId,
        downloaded_patch_keys: [
          `zeroparse--${sessionId}--001-first.patch`,
          `zeroparse--${sessionId}--002-second.patch`,
          `zeroparse--${sessionId}--003-third.patch`
        ]
      },
      checkpoint: { round_number: 4, prompt: 'persisted older prompt', stage: 'PROMPT_SENT', assistant_text: null },
      hooks: {}
    }),
    error => error instanceof RunnerError
      && error.code === ERROR_CODES.TASK_RECOVERY_BLOCKED
      && /latest ChatGPT user message/.test(error.message)
  );
});

test('prepareExistingTask does not renavigate an owned tab that is already on the persisted conversation', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) {
      actions.push(`get:${tabId}`);
      return { id: tabId, url: 'https://chatgpt.com/c/owned-conversation', status: 'complete', discarded: false };
    },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(tabId, message) { actions.push(`send:${tabId}:${message.type}`); return {}; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  const prepared = await driver.prepareExistingTask({
    task_id: 't-owned',
    project_id: 'zeroparse',
    chatgpt_project_name: 'zeroparse_ewan_1',
    chatgpt_tab_id: 17,
    chatgpt_conversation_url: 'https://chatgpt.com/c/owned-conversation',
    session_id: 's1'
  });

  assert.equal(prepared.tabId, 17);
  assert.deepEqual(actions, [
    'get:17',
    'activate:17',
    'send:17:CHATGPT_RESOLVE_CHAT'
  ]);
});

test('prepareExistingTask explicitly restores a discarded owned tab before resolving the persisted conversation', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) {
      actions.push(`get:${tabId}`);
      return { id: tabId, url: 'https://chatgpt.com/c/owned-conversation', status: 'unloaded', discarded: true };
    },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async reloadTab(tabId) {
      actions.push(`reload:${tabId}`);
      return { id: tabId, url: 'https://chatgpt.com/c/owned-conversation', status: 'complete', discarded: false };
    },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(tabId, message) { actions.push(`send:${tabId}:${message.type}`); return {}; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  await driver.prepareExistingTask({
    task_id: 't-owned',
    project_id: 'zeroparse',
    chatgpt_project_name: 'zeroparse_ewan_1',
    chatgpt_tab_id: 17,
    chatgpt_conversation_url: 'https://chatgpt.com/c/owned-conversation',
    session_id: 's1'
  });

  assert.deepEqual(actions, [
    'get:17',
    'activate:17',
    'reload:17',
    'send:17:CHATGPT_RESOLVE_CHAT'
  ]);
});

test('recoverRound reuses a response-ready checkpoint without sending or waiting for another generation', async () => {
  const messages = [];
  const tabManager = fakeTabManager(message => {
    messages.push(message.type);
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') return {
      state: 'READY', contextLimit: false, latestUserText: 'fix now', latestAssistantText: 'done already', latestRole: 'assistant'
    };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [{ filename: 'patch-s1-001.patch' }];
    if (message.type === 'CHATGPT_SEND_PROMPT' || message.type === 'CHATGPT_STATE') throw new Error('must not send or wait');
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;
  const result = await driver.recoverRound({
    task: { task_id: 't1' },
    state: { session_id: 's1', downloaded_patch_keys: [] },
    checkpoint: { round_number: 2, prompt: 'fix now', stage: 'RESPONSE_READY', assistant_text: 'done already' },
    hooks: {}
  });
  assert.equal(result.assistantText, 'done already');
  assert.equal(result.patches.length, 1);
  assert.equal(messages.includes('CHATGPT_SEND_PROMPT'), false);
  assert.equal(messages.includes('CHATGPT_STATE'), false);
});

test('recoverRound blocks ambiguous ready state when the checkpointed prompt is latest user message but no assistant reply follows it', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') return {
      state: 'READY', contextLimit: false, latestUserText: 'fix now', latestAssistantText: 'older answer', latestRole: 'user'
    };
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });
  driver.tabId = 7;
  await assert.rejects(
    driver.recoverRound({
      task: { task_id: 't1' },
      state: { session_id: 's1', downloaded_patch_keys: [] },
      checkpoint: { round_number: 1, prompt: 'fix now', stage: 'READY_TO_SEND', assistant_text: null },
      hooks: {}
    }),
    error => error instanceof RunnerError && error.code === ERROR_CODES.TASK_RECOVERY_BLOCKED
  );
});


test('recoverRound does not send over a different unanswered user message even when composer reports ready', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') return {
      state: 'READY', contextLimit: false, latestUserText: 'different pending prompt', latestAssistantText: 'older answer', latestRole: 'user'
    };
    if (message.type === 'CHATGPT_SEND_PROMPT') throw new Error('must not send');
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });
  driver.tabId = 7;
  await assert.rejects(
    driver.recoverRound({
      task: { task_id: 't1' },
      state: { session_id: 's1', downloaded_patch_keys: [] },
      checkpoint: { round_number: 1, prompt: 'fix now', stage: 'READY_TO_SEND', assistant_text: null },
      hooks: {}
    }),
    error => error instanceof RunnerError && error.code === ERROR_CODES.TASK_RECOVERY_BLOCKED
  );
});

test('BrowserPageDriver records compatibility telemetry before rethrowing selector failures', async () => {
  const records = [];
  const driver = new BrowserPageDriver({
    tabManager: fakeTabManager(message => {
      if (message.type === 'CHATGPT_LIST_PROJECTS') return {
        ok: false,
        error: {
          code: 'UI_SELECTOR_INCOMPATIBLE',
          message: 'new project control missing',
          diagnostics: {
            selector_profile: { id: 'chatgpt-semantic-v1', version: 1 },
            access_state: { status: 'READY' },
            page: { title_category: 'chat' }
          }
        }
      };
      return {};
    }),
    compatibilityTelemetry: { async record(event) { records.push(event); return true; } },
    sleep: async () => {}
  });

  await assert.rejects(
    driver.createTaskProject({ task: { project_id: 'vetatool', project_constraints: '' } }),
    error => error.code === 'UI_SELECTOR_INCOMPATIBLE'
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].operation, 'CHATGPT_LIST_PROJECTS');
  assert.equal(records[0].error.code, 'UI_SELECTOR_INCOMPATIBLE');
});

test('BrowserPageDriver does not record unrelated content-command errors as compatibility telemetry', async () => {
  const records = [];
  const driver = new BrowserPageDriver({
    tabManager: fakeTabManager(message => {
      if (message.type === 'CHATGPT_STATE') return { ok: false, error: { code: 'MODEL_RESPONSE_TIMEOUT', message: 'timeout' } };
      return {};
    }),
    compatibilityTelemetry: { async record(event) { records.push(event); return true; } },
    sleep: async () => {},
    pollMs: 1
  });
  driver.tabId = 7;
  await assert.rejects(driver.runRound({ state: { session_id: 's1' }, prompt: 'x' }), error => error.code === 'MODEL_RESPONSE_TIMEOUT');
  assert.equal(records.length, 0);
});

test('BrowserPageDriver has no hard-coded responseTimeoutMs business default', () => {
  const driver = new BrowserPageDriver({ tabManager: fakeTabManager(() => ({})), sleep: async () => {} });
  assert.equal(Object.prototype.hasOwnProperty.call(driver, 'responseTimeoutMs'), false);
});

test('meaningful assistant growth resets the server-provided no-progress observation window', async () => {
  let nowMs = Date.parse('2026-08-28T12:00:00.000Z');
  let stateReads = 0;
  let textReads = 0;
  const states = [
    { state: 'GENERATING', contextLimit: false },
    { state: 'GENERATING', contextLimit: false },
    { state: 'GENERATING', contextLimit: false },
    { state: 'GENERATING', contextLimit: false },
    { state: 'READY', contextLimit: false }
  ];
  const texts = ['', 'a', 'a', 'ab', 'done'];
  const progress = [];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateReads++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: texts[Math.min(textReads++, texts.length - 1)] };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => { nowMs += 1; },
    now: () => new Date(nowMs),
    stableReadsRequired: 1,
    pollMs: 1,
    generationStartTimeoutMs: 5
  });
  driver.tabId = 7;
  const round = await driver.runRound({
    state: { session_id: 's1', downloaded_patch_keys: [] }, prompt: 'fix', observationTimeoutMs: 2,
    hooks: { async onMeaningfulProgress(kind) { progress.push(kind); } }
  });
  assert.equal(round.assistantText, 'done');
  assert.ok(progress.includes('assistant_text_growth'));
  assert.ok(progress.includes('response_ready'));
});



test('response observation timeout uses wall-clock time after browser suspension instead of remaining poll count', async () => {
  let nowMs = Date.parse('2026-08-21T00:00:00.000Z');
  let stateReads = 0;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') {
      stateReads += 1;
      return { state: 'GENERATING', contextLimit: false };
    }
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: '' };
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    pollMs: 300,
    generationStartTimeoutMs: 15000,
    now: () => new Date(nowMs),
    sleep: async () => { nowMs += 60_000; }
  });
  driver.tabId = 7;

  await assert.rejects(
    driver.runRound({ state: { session_id: 's1', downloaded_patch_keys: [] }, prompt: 'fix', observationTimeoutMs: 1000 }),
    error => error instanceof RunnerError && error.code === ERROR_CODES.MODEL_RESPONSE_TIMEOUT
  );

  assert.equal(stateReads, 2);
});
test('reloadPage and reopenWorkspace preserve the owned Project instead of creating a replacement', async () => {
  const actions = [];
  const tabManager = {
    async findChatGptTab() { return { id: 7 }; },
    async send(_id, message) { actions.push(message); return {}; },
    async reloadTab(tabId) { actions.push({ type: 'TAB_RELOAD', tabId }); return { id: tabId }; },
    async navigateTab(tabId, url) { actions.push({ type: 'TAB_NAVIGATE', tabId, url }); return { id: tabId }; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });
  driver.tabId = 7;
  await driver.reloadPage();
  await driver.reopenWorkspace({ state: { task_project: { project_name: 'vetatool2026081719', status: 'active' } } });
  assert.ok(actions.some(action => action.type === 'TAB_RELOAD'));
  assert.ok(actions.some(action => action.type === 'TAB_NAVIGATE'));
  assert.ok(actions.some(action => action.type === 'CHATGPT_OPEN_PROJECT' && action.projectName === 'vetatool2026081719'));
  assert.equal(actions.some(action => action.type === 'CHATGPT_CREATE_PROJECT'), false);
});

test('createTaskProject passes the exact created project name when opening Project settings for instructions', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_LIST_PROJECTS') return [];
    if (message.type === 'CHATGPT_CREATE_PROJECT') return { name: message.projectName, href: '/g/g-p-test/project' };
    if (message.type === 'CHATGPT_SET_PROJECT_INSTRUCTIONS') return { saved: true };
    if (message.type === 'CHATGPT_RESOLVE_CHAT') return { composerPresent: true };
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager, sleep: async () => {}, now: () => new Date('2026-08-19T18:30:00+08:00'), timeZone: 'Asia/Shanghai'
  });
  const task = { task_id: 't1', project_id: 'browserplguin', agent_control: { assignment_id: 'assignment-1' } };
  const state = { assignment_id: 'assignment-1', source_preparation: { patch_session_id: 'ps-test', rules: { text: 'rules' } } };
  const created = await driver.createTaskProject({ task, state });
  await driver.configureTaskProject({
    task,
    state: { ...state, chatgpt_project_name: created.projectName, task_project: { project_name: created.projectName, status: 'active' } }
  });
  const message = tabManager.messages.find(item => item.type === 'CHATGPT_SET_PROJECT_INSTRUCTIONS');
  assert.equal(message.projectName, 'browserplguin_ewan_202608191830');
});



test('createTaskProject honors a recovery Project name and avoids a leftover collision', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_LIST_PROJECTS') return [{ name: 'vetatool2026082111-r1' }];
    if (message.type === 'CHATGPT_CREATE_PROJECT') return { name: message.projectName };
    if (message.type === 'CHATGPT_SET_PROJECT_INSTRUCTIONS') return { saved: true };
    if (message.type === 'CHATGPT_RESOLVE_CHAT') return { composerPresent: true };
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  const result = await driver.createTaskProject({
    task: { task_id: 't-recovery-name', project_id: 'vetatool' },
    state: { source_preparation: { patch_session_id: 'ps-1', rules: { text: 'rules' } } },
    preferredProjectName: 'vetatool2026082111-r1'
  });

  assert.equal(result.projectName, 'vetatool2026082111-r1-02');
  assert.ok(tabManager.messages.some(message => message.type === 'CHATGPT_CREATE_PROJECT' && message.projectName === 'vetatool2026082111-r1-02'));
});
test('browser page driver stops the current ChatGPT wait as soon as the Task run is aborted', async () => {
  const abortController = new AbortController();
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_SEND_PROMPT') {
      abortController.abort();
      return { ok: true };
    }
    if (message.type === 'CHATGPT_STATE') return { state: 'READY', contextLimit: false };
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: '<TASK_STATUS>DONE</TASK_STATUS>' };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    stableReadsRequired: 2,
    pollMs: 1,
    abortSignal: abortController.signal
  });
  driver.tabId = 7;

  await assert.rejects(
    driver.runRound({ task: { task_id: 't-abort' }, state: { session_id: 's1' }, prompt: 'stop me' }),
    error => error?.code === 'TASK_TERMINATED'
  );
  assert.equal(tabManager.messages.some(message => message.type === 'CHATGPT_STATE'), false);
});

test('BrowserPageDriver clears a stale compatibility error after the same content command later succeeds', async () => {
  const successes = [];
  const driver = new BrowserPageDriver({
    tabManager: fakeTabManager(message => {
      if (message.type === 'CHATGPT_DELETE_PROJECT') return { deleted: true };
      return {};
    }),
    compatibilityTelemetry: {
      async record() { throw new Error('must not record success'); },
      async recordSuccess(event) { successes.push(event); return true; }
    },
    sleep: async () => {}
  });

  await driver.deleteTaskProject({ project: { project_name: 'browserplguin20260821' } });
  assert.deepEqual(successes, [{ operation: 'CHATGPT_DELETE_PROJECT' }]);
});

test('explicit ChatGPT response failure uses native Retry immediately instead of waiting for timeout', async () => {
  const states = [
    { state: 'READY', contextLimit: false, responseFailure: { failed: true, retryAvailable: true } },
    { state: 'GENERATING', contextLimit: false, responseFailure: { failed: false, retryAvailable: false } },
    { state: 'READY', contextLimit: false, responseFailure: { failed: false, retryAvailable: false } }
  ];
  let stateIndex = 0;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_RETRY_RESPONSE') return { retried: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: '<TASK_STATUS>DONE</TASK_STATUS>' };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;

  const result = await driver.runRound({ state: { session_id: 's1', downloaded_patch_keys: [] }, prompt: '继续任务' });

  assert.equal(result.assistantText, '<TASK_STATUS>DONE</TASK_STATUS>');
  assert.equal(tabManager.messages.filter(message => message.type === 'CHATGPT_RETRY_RESPONSE').length, 1);
});

test('native Retry is bounded and surfaces MODEL_RESPONSE_FAILED after repeated explicit failures', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_RETRY_RESPONSE') return { retried: true };
    if (message.type === 'CHATGPT_STATE') return { state: 'READY', contextLimit: false, responseFailure: { failed: true, retryAvailable: true } };
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1, nativeRetryLimit: 2 });
  driver.tabId = 7;

  await assert.rejects(
    driver.runRound({ state: { session_id: 's1', downloaded_patch_keys: [] }, prompt: '继续任务' }),
    error => error instanceof RunnerError && error.code === ERROR_CODES.MODEL_RESPONSE_FAILED
  );
  assert.equal(tabManager.messages.filter(message => message.type === 'CHATGPT_RETRY_RESPONSE').length, 2);
});


test('BrowserPageDriver passes progress-aware composer timing to attach and send commands', async () => {
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') return { attached: true };
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: INITIALIZATION_READY_MARKER };
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    stableReadsRequired: 1,
    pollMs: 1,
    composerPollMs: 2000,
    composerStallTimeoutMs: 180000
  });
  driver.tabId = 7;

  await driver.initializeTask({
    task: { resource: { url: 'https://assets.example.com/source.zip' } },
    resource: { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }
  });

  const attach = tabManager.messages.find(message => message.type === 'CHATGPT_ATTACH_RESOURCE');
  const send = tabManager.messages.find(message => message.type === 'CHATGPT_SEND_PROMPT');
  assert.deepEqual(attach.options, { pollMs: 2000, stallTimeoutMs: 180000 });
  assert.deepEqual(send.options, { pollMs: 2000, stallTimeoutMs: 180000 });
});

test('initializeTask resumes an already-sent initialization Prompt after page recovery instead of attaching or sending it twice', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') {
      return {
        state: 'READY',
        contextLimit: false,
        latestRole: 'assistant',
        latestUserText: INITIALIZATION_PROMPT,
        latestAssistantText: INITIALIZATION_READY_MARKER
      };
    }
    if (message.type === 'CHATGPT_STATE') return { state: 'READY', contextLimit: false, responseFailure: { failed: false, retryAvailable: false } };
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: INITIALIZATION_READY_MARKER };
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') throw new Error('must not attach source twice');
    if (message.type === 'CHATGPT_SEND_PROMPT') throw new Error('must not send initialization twice');
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;

  const result = await driver.initializeTask({
    task: { resource: { url: 'https://assets.example.com/source.zip' } },
    resource: { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }
  });

  assert.equal(result.assistantText, INITIALIZATION_READY_MARKER);
  assert.equal(tabManager.messages.some(message => message.type === 'CHATGPT_ATTACH_RESOURCE'), false);
  assert.equal(tabManager.messages.some(message => message.type === 'CHATGPT_SEND_PROMPT'), false);
});

test('initializeTask never resends a durably sent initialization Prompt when recovered page evidence is missing', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') {
      return { state: 'READY', contextLimit: false, latestRole: null, latestUserText: '', latestAssistantText: '' };
    }
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') throw new Error('must not attach after durable prompt send');
    if (message.type === 'CHATGPT_SEND_PROMPT') throw new Error('must not resend durable initialization prompt');
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;

  await assert.rejects(
    driver.initializeTask({
      task: { resource: { url: 'https://assets.example.com/source.zip' } },
      state: { initialization_prompt_checkpoint: { stage: 'PROMPT_SENT' } },
      resource: { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }
    }),
    error => error instanceof RunnerError && error.code === ERROR_CODES.INITIALIZATION_PROTOCOL_MISSING
  );
  assert.equal(tabManager.messages.some(message => message.type === 'CHATGPT_ATTACH_RESOURCE'), false);
  assert.equal(tabManager.messages.some(message => message.type === 'CHATGPT_SEND_PROMPT'), false);
});

test('initializeTask reconciles an already-sent initialization Prompt into the durable sent checkpoint hook', async () => {
  const events = [];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ROUND_SNAPSHOT') {
      return {
        state: 'READY', contextLimit: false, latestRole: 'assistant',
        latestUserText: INITIALIZATION_PROMPT, latestAssistantText: INITIALIZATION_READY_MARKER
      };
    }
    if (message.type === 'CHATGPT_STATE') return { state: 'READY', contextLimit: false, responseFailure: { failed: false, retryAvailable: false } };
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: INITIALIZATION_READY_MARKER };
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;

  await driver.initializeTask({
    task: { resource: { url: 'https://assets.example.com/source.zip' } },
    state: { initialization_prompt_checkpoint: { stage: 'READY_TO_SEND' } },
    resource: { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' },
    hooks: { onPromptSent: () => events.push('sent') }
  });

  assert.deepEqual(events, ['sent']);
  assert.equal(tabManager.messages.some(message => message.type === 'CHATGPT_SEND_PROMPT'), false);
});

test('createTaskProject owns a fresh ChatGPT tab instead of reusing the user active tab', async () => {
  const actions = [];
  let assigned = null;
  const tabManager = {
    async createChatGptTab() { actions.push('create-tab'); return { id: 17, url: 'https://chatgpt.com/' }; },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async findChatGptTab() { actions.push('find-existing'); return { id: 42, active: true, url: 'https://chatgpt.com/c/user' }; },
    async send(tabId, message) {
      actions.push(`send:${tabId}:${message.type}`);
      if (message.type === 'CHATGPT_LIST_PROJECTS') return [];
      return {};
    }
  };
  const slotStore = {
    async load() { return null; },
    async assign(input) { assigned = structuredClone(input); return { slot_id: 'chatgpt-1', tab_id: input.tabId, task_id: input.taskId, generation: 1, status: 'assigned', managed_tab: input.managedTab }; }
  };
  const driver = new BrowserPageDriver({ tabManager, tabSlotStore: slotStore, sleep: async () => {}, pollMs: 1, now: () => new Date('2026-08-26T01:00:00Z'), timeZone: 'Asia/Shanghai' });

  const session = await driver.createTaskProject({ task: { task_id: 't-owned', project_id: 'vetatool' }, state: {} });

  assert.equal(session.tabId, 17);
  assert.equal(actions.includes('find-existing'), false);
  assert.equal(actions[0], 'create-tab');
  assert.ok(actions.includes('send:17:CHATGPT_CREATE_PROJECT'));
  assert.equal(assigned.managedTab, true);
});

test('prepareExistingTask reuses and focuses the persisted task tab even when another ChatGPT tab is active', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); return { id: tabId, url: 'https://chatgpt.com/c/owned' }; },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async findChatGptTab() { actions.push('find-active'); return { id: 42, active: true, url: 'https://chatgpt.com/c/user' }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(tabId, message) { actions.push(`send:${tabId}:${message.type}`); return {}; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  const prepared = await driver.prepareExistingTask({
    task_id: 't-owned', project_id: 'vetatool', chatgpt_project_name: 'vetatool_ewan_1',
    chatgpt_tab_id: 17, chatgpt_conversation_url: 'https://chatgpt.com/c/owned-conversation', session_id: 's1'
  });

  assert.equal(prepared.tabId, 17);
  assert.equal(actions.includes('find-active'), false);
  assert.deepEqual(actions, [
    'get:17',
    'activate:17',
    'navigate:17:https://chatgpt.com/c/owned-conversation',
    'send:17:CHATGPT_RESOLVE_CHAT'
  ]);
});

test('prepareExistingTask recreates a closed owned tab and restores the exact persisted conversation', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); throw new Error(`No tab with id: ${tabId}`); },
    async createChatGptTab() { actions.push('create-tab'); return { id: 88, url: 'https://chatgpt.com/' }; },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(tabId, message) { actions.push(`send:${tabId}:${message.type}`); return {}; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  const prepared = await driver.prepareExistingTask({
    task_id: 't-owned', project_id: 'vetatool', chatgpt_project_name: 'vetatool_ewan_1',
    chatgpt_tab_id: 17, chatgpt_conversation_url: 'https://chatgpt.com/c/owned-conversation', session_id: 's1'
  });

  assert.equal(prepared.tabId, 88);
  assert.deepEqual(actions, [
    'get:17',
    'create-tab',
    'activate:88',
    'navigate:88:https://chatgpt.com/c/owned-conversation',
    'send:88:CHATGPT_RESOLVE_CHAT'
  ]);
});

test('createTaskProject reuses the idle worker slot tab for the next Task instead of opening another tab', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); return { id: tabId, url: 'https://chatgpt.com/', status: 'complete' }; },
    async createChatGptTab() { actions.push('create-tab'); return { id: 88, url: 'https://chatgpt.com/' }; },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(tabId, message) {
      actions.push(`send:${tabId}:${message.type}`);
      if (message.type === 'CHATGPT_LIST_PROJECTS') return [];
      return {};
    }
  };
  const slotStore = {
    async load() { actions.push('slot:load'); return { slot_id: 'chatgpt-1', tab_id: 17, task_id: null, generation: 4, status: 'idle' }; },
    async assign({ taskId, tabId }) {
      actions.push(`slot:assign:${taskId}:${tabId}`);
      return { slot_id: 'chatgpt-1', tab_id: tabId, task_id: taskId, generation: 5, status: 'assigned' };
    }
  };
  const driver = new BrowserPageDriver({ tabManager, tabSlotStore: slotStore, sleep: async () => {}, pollMs: 1, now: () => new Date('2026-08-26T01:00:00Z'), timeZone: 'Asia/Shanghai' });

  const session = await driver.createTaskProject({ task: { task_id: 'task-b', project_id: 'vetatool' }, state: {} });

  assert.equal(session.tabId, 17);
  assert.equal(session.slotId, 'chatgpt-1');
  assert.equal(session.slotGeneration, 5);
  assert.equal(actions.includes('create-tab'), false);
  assert.deepEqual(actions.slice(0, 5), ['slot:load', 'get:17', 'navigate:17:https://chatgpt.com/', 'slot:assign:task-b:17', 'activate:17']);
});

test('releaseTaskTab resets the owned tab to ChatGPT home and leaves the slot idle for reuse', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); return { id: tabId, url: 'https://chatgpt.com/c/old', status: 'complete' }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; }
  };
  const slotStore = {
    async release({ taskId, tabId, slotId }) {
      actions.push(`slot:release:${slotId}:${taskId}:${tabId}`);
      return { slot_id: slotId, tab_id: tabId, task_id: null, generation: 5, status: 'idle' };
    }
  };
  const driver = new BrowserPageDriver({ tabManager, tabSlotStore: slotStore, sleep: async () => {}, pollMs: 1 });

  const released = await driver.releaseTaskTab({ state: { task_id: 'task-a', chatgpt_tab_id: 17, browser_slot_id: 'chatgpt-1' } });

  assert.equal(released.status, 'idle');
  assert.deepEqual(actions, [
    'get:17',
    'navigate:17:https://chatgpt.com/',
    'slot:release:chatgpt-1:task-a:17'
  ]);
});


test('releaseTaskTab closes a managed tab when reset navigation fails instead of leaving an untracked blank tab', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); return { id: tabId, url: 'about:blank', status: 'complete' }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); throw new Error('navigation interrupted'); },
    async closeTab(tabId) { actions.push(`close:${tabId}`); }
  };
  const slotStore = {
    async load() { return { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 5, status: 'assigned', managed_tab: true }; },
    async release({ taskId, tabId, slotId }) {
      actions.push(`slot:release:${slotId}:${taskId}:${tabId}`);
      return { slot_id: slotId, tab_id: tabId, task_id: null, generation: 5, status: 'idle', managed_tab: true };
    }
  };
  const driver = new BrowserPageDriver({ tabManager, tabSlotStore: slotStore, sleep: async () => {}, pollMs: 1 });

  const released = await driver.releaseTaskTab({ state: { task_id: 'task-a', chatgpt_tab_id: 17, browser_slot_id: 'chatgpt-1' } });

  assert.equal(released.tab_id, null);
  assert.deepEqual(actions, [
    'get:17',
    'navigate:17:https://chatgpt.com/',
    'close:17',
    'slot:release:chatgpt-1:task-a:null'
  ]);
});

test('releaseTaskTab leaves an unmanaged ChatGPT tab open and detaches it from the idle slot', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); return { id: tabId, url: 'https://chatgpt.com/c/user', status: 'complete' }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; }
  };
  const slotStore = {
    async load() { return { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 5, status: 'assigned', managed_tab: false }; },
    async release({ taskId, tabId, slotId }) {
      actions.push(`slot:release:${slotId}:${taskId}:${tabId}`);
      return { slot_id: slotId, tab_id: tabId, task_id: null, generation: 5, status: 'idle', managed_tab: false };
    }
  };
  const driver = new BrowserPageDriver({ tabManager, tabSlotStore: slotStore, sleep: async () => {}, pollMs: 1 });

  const released = await driver.releaseTaskTab({ state: { task_id: 'task-a', chatgpt_tab_id: 17, browser_slot_id: 'chatgpt-1' } });

  assert.equal(released.status, 'idle');
  assert.equal(released.tab_id, null);
  assert.deepEqual(actions, ['slot:release:chatgpt-1:task-a:null']);
});

test('discoverCurrentPatches stays on the durable owned tab after the user activates another ChatGPT tab', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); return { id: tabId, url: 'https://chatgpt.com/c/owned' }; },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async findChatGptTab() { actions.push('find-active'); return { id: 42, active: true, url: 'https://chatgpt.com/c/user' }; },
    async send(tabId, message) {
      actions.push(`send:${tabId}:${message.type}`);
      if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
      return {};
    }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  await driver.discoverCurrentPatches({ state: { chatgpt_tab_id: 17, session_id: 's1', downloaded_patch_keys: [] } });

  assert.equal(actions.includes('find-active'), false);
  assert.deepEqual(actions, ['get:17', 'send:17:CHATGPT_DISCOVER_PATCHES']);
});

test('deleteTaskProject defers orphan cleanup to the next same-project creation when the persisted owned tab was closed', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); throw new Error(`No tab with id: ${tabId}`); },
    async createChatGptTab() { actions.push('create-tab'); return { id: 88, url: 'https://chatgpt.com/' }; },
    async findChatGptTab() { actions.push('find-active'); return { id: 42, active: true, url: 'https://chatgpt.com/c/user' }; },
    async send(tabId, message) { actions.push(`send:${tabId}:${message.type}`); return { deleted: true, name: message.projectName }; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  const result = await driver.deleteTaskProject({ project: { project_name: 'vetatool_ewan_closed', chatgpt_tab_id: 17 } });

  assert.deepEqual(result, {
    deleted: false,
    deferred: true,
    reason: 'owned_tab_missing',
    projectName: 'vetatool_ewan_closed'
  });
  assert.deepEqual(actions, ['get:17']);
});

test('deleteTaskProject focuses the persisted owned tab instead of deleting from the user active ChatGPT tab', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); return { id: tabId, url: 'https://chatgpt.com/c/owned' }; },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async findChatGptTab() { actions.push('find-active'); return { id: 42, active: true, url: 'https://chatgpt.com/c/user' }; },
    async send(tabId, message) { actions.push(`send:${tabId}:${message.type}`); return { deleted: true }; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  await driver.deleteTaskProject({ project: { project_name: 'vetatool_ewan_owned', chatgpt_tab_id: 17 } });

  assert.equal(actions.includes('find-active'), false);
  assert.deepEqual(actions, ['get:17', 'activate:17', 'send:17:CHATGPT_DELETE_PROJECT']);
});

test('runRound reactivates the owned worker tab once before the next UI interaction after the user switches away', async () => {
  const actions = [];
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const tabManager = {
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async send(tabId, message) {
      actions.push(`send:${tabId}:${message.type}`);
      if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
      if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
      if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: '<TASK_STATUS>DONE</TASK_STATUS>' };
      if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
      return {};
    }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 17;

  await driver.runRound({ state: { session_id: 's1', downloaded_patch_keys: [] }, prompt: 'next task step' });

  assert.equal(actions[0], 'activate:17');
  assert.equal(actions.filter(action => action === 'activate:17').length, 1);
  assert.ok(actions.indexOf('activate:17') < actions.indexOf('send:17:CHATGPT_SEND_PROMPT'));
});

test('prepareExistingTask reassigns a recreated closed tab to the same durable worker slot generation', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); throw new Error(`No tab with id: ${tabId}`); },
    async createChatGptTab() { actions.push('create-tab'); return { id: 88, url: 'https://chatgpt.com/' }; },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(tabId, message) { actions.push(`send:${tabId}:${message.type}`); return {}; }
  };
  const slotStore = {
    async assign({ taskId, tabId, slotId }) {
      actions.push(`slot:assign:${slotId}:${taskId}:${tabId}`);
      return { slot_id: slotId, tab_id: tabId, task_id: taskId, generation: 6, status: 'assigned' };
    }
  };
  const driver = new BrowserPageDriver({ tabManager, tabSlotStore: slotStore, sleep: async () => {}, pollMs: 1 });

  const prepared = await driver.prepareExistingTask({
    task_id: 'task-a', project_id: 'vetatool', chatgpt_project_name: 'vetatool_ewan_1',
    chatgpt_tab_id: 17, browser_slot_id: 'chatgpt-1', browser_slot_generation: 5,
    chatgpt_conversation_url: 'https://chatgpt.com/c/owned-conversation', session_id: 's1'
  });

  assert.equal(prepared.tabId, 88);
  assert.equal(prepared.slotId, 'chatgpt-1');
  assert.equal(prepared.slotGeneration, 6);
  assert.ok(actions.includes('slot:assign:chatgpt-1:task-a:88'));
});

test('reloadPage recovers the durable owned tab instead of reloading whichever tab the user activated', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); return { id: tabId, url: 'https://chatgpt.com/c/owned' }; },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async findChatGptTab() { actions.push('find-active'); return { id: 42, active: true }; },
    async reloadTab(tabId) { actions.push(`reload:${tabId}`); return { id: tabId, status: 'complete' }; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  await driver.reloadPage({ state: { chatgpt_tab_id: 17 } });

  assert.equal(actions.includes('find-active'), false);
  assert.deepEqual(actions, ['get:17', 'activate:17', 'reload:17']);
});

test('reopenWorkspace recovers the durable owned tab instead of navigating the user active tab', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); return { id: tabId, url: 'https://chatgpt.com/c/owned' }; },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async findChatGptTab() { actions.push('find-active'); return { id: 42, active: true }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(tabId, message) { actions.push(`send:${tabId}:${message.type}`); return {}; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  await driver.reopenWorkspace({ state: { chatgpt_tab_id: 17, task_project: { project_name: 'vetatool_ewan_owned' } } });

  assert.equal(actions.includes('find-active'), false);
  assert.deepEqual(actions, [
    'get:17',
    'activate:17',
    'navigate:17:https://chatgpt.com/',
    'send:17:CHATGPT_OPEN_PROJECT',
    'send:17:CHATGPT_RESOLVE_CHAT'
  ]);
});

test('discoverCurrentPatches never falls back to a user active tab when the durable owned tab was closed', async () => {
  const actions = [];
  const tabManager = {
    async getTab(tabId) { actions.push(`get:${tabId}`); throw new Error(`No tab with id: ${tabId}`); },
    async findChatGptTab() { actions.push('find-active'); return { id: 42, active: true, url: 'https://chatgpt.com/c/user' }; },
    async send(tabId, message) { actions.push(`send:${tabId}:${message.type}`); return []; }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  await assert.rejects(
    driver.discoverCurrentPatches({ state: { chatgpt_tab_id: 17, session_id: 's1', downloaded_patch_keys: [] } }),
    error => error instanceof RunnerError && error.code === ERROR_CODES.CHAT_NOT_FOUND
  );
  assert.equal(actions.includes('find-active'), false);
  assert.deepEqual(actions, ['get:17']);
});

test('runRound uses the shared UI action queue only for the prompt send while passive model polling stays background-safe', async () => {
  const queueActions = [];
  const activations = [];
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const tabManager = {
    async findChatGptTab() { return { id: 17 }; },
    async getTab(tabId) { return { id: tabId }; },
    async activateTab(tabId) { activations.push(tabId); },
    async send(_tabId, message) {
      if (message.type === 'CHATGPT_OPEN_PROJECT') return {};
      if (message.type === 'CHATGPT_RESOLVE_CHAT') return {};
      if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
      if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
      if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: 'done' };
      if (message.type === 'CHATGPT_DISCOVER_PATCHES') return [];
      return {};
    }
  };
  const slotStore = {
    async assign() { return { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 3, status: 'assigned' }; },
    async load() { return { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 3, status: 'assigned' }; }
  };
  const uiActionQueue = {
    async enqueue(item) { queueActions.push(item.actionType); return item.run(); }
  };
  const driver = new BrowserPageDriver({ tabManager, tabSlotStore: slotStore, uiActionQueue, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  await driver.prepareExistingTask({
    task_id: 'task-a', project_id: 'vetatool', chatgpt_project_name: 'p', session_id: 's1', chatgpt_tab_id: 17,
    browser_slot_id: 'chatgpt-1', browser_slot_generation: 3
  });
  queueActions.length = 0;
  activations.length = 0;

  await driver.runRound({ state: { session_id: 's1' }, prompt: 'next' });

  assert.deepEqual(queueActions, ['SEND_PROMPT']);
  assert.deepEqual(activations, []);
});

test('BrowserPageDriver keeps create and recovery ownership inside its fixed worker slot', async () => {
  const actions = [];
  const tabManager = {
    async createChatGptTab() { actions.push('create-tab'); return { id: 22, url: 'https://chatgpt.com/' }; },
    async getTab(tabId) { actions.push(`get:${tabId}`); throw new Error(`No tab with id: ${tabId}`); },
    async activateTab(tabId) { actions.push(`activate:${tabId}`); return { id: tabId }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(tabId, message) {
      actions.push(`send:${tabId}:${message.type}`);
      if (message.type === 'CHATGPT_LIST_PROJECTS') return [];
      return {};
    }
  };
  const slotStore = {
    async load(slotId) { actions.push(`slot:load:${slotId}`); return null; },
    async assign({ taskId, tabId, slotId }) {
      actions.push(`slot:assign:${slotId}:${taskId}:${tabId}`);
      return { slot_id: slotId, tab_id: tabId, task_id: taskId, generation: 1, status: 'assigned' };
    }
  };
  const driver = new BrowserPageDriver({
    tabManager, tabSlotStore: slotStore, slotId: 'chatgpt-2', sleep: async () => {}, pollMs: 1,
    now: () => new Date('2026-08-26T08:00:00.000Z'), timeZone: 'UTC'
  });

  const created = await driver.createTaskProject({ task: { task_id: 'task-b', project_id: 'vetatool' }, state: {} });
  assert.equal(created.slotId, 'chatgpt-2');
  assert.ok(actions.includes('slot:load:chatgpt-2'));
  assert.ok(actions.includes('slot:assign:chatgpt-2:task-b:22'));

  actions.length = 0;
  const recovered = await driver.prepareExistingTask({
    task_id: 'task-b', project_id: 'vetatool', chatgpt_project_name: created.projectName,
    chatgpt_tab_id: 22, browser_slot_id: 'chatgpt-2', browser_slot_generation: 1,
    chatgpt_conversation_url: 'https://chatgpt.com/c/task-b', session_id: 's2'
  });
  assert.equal(recovered.slotId, 'chatgpt-2');
  assert.ok(actions.includes('slot:assign:chatgpt-2:task-b:22'));
  assert.equal(actions.some(action => action.includes('chatgpt-1')), false);
});

test('createTaskProject reloads and rescans before failing when creation confirmation times out', async () => {
  let reloaded = false;
  let projectName = null;
  let createCalls = 0;
  const actions = [];
  const tabManager = {
    async findChatGptTab() { return { id: 7, url: 'https://chatgpt.com/' }; },
    async activateTab() {},
    async reloadTab(tabId) { actions.push(`reload:${tabId}`); reloaded = true; return { id: tabId, status: 'complete' }; },
    async send(_tabId, message) {
      actions.push(message.type);
      if (message.type === 'CHATGPT_LIST_PROJECTS') return reloaded && projectName ? [{ name: projectName, href: '/project/recovered' }] : [];
      if (message.type === 'CHATGPT_CREATE_PROJECT') {
        createCalls += 1;
        projectName = message.projectName;
        return { ok: false, error: { code: 'UI_SELECTOR_INCOMPATIBLE', message: `Created Project ${projectName} did not appear before timeout` } };
      }
      return {};
    }
  };
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    pollMs: 1,
    now: () => new Date('2026-08-27T12:43:00+08:00'),
    timeZone: 'Asia/Shanghai'
  });

  const result = await driver.createTaskProject({ task: { task_id: 't1', project_id: 'vetatool' }, state: {} });

  assert.equal(createCalls, 1);
  assert.equal(result.projectName, projectName);
  assert.ok(actions.includes('reload:7'));
  assert.ok(actions.filter(value => value === 'CHATGPT_LIST_PROJECTS').length >= 2);
});

test('createTaskProject retries the create flow once after a pre-submit selector failure and reload', async () => {
  let reloaded = false;
  let createCalls = 0;
  const actions = [];
  const tabManager = {
    async findChatGptTab() { return { id: 7, url: 'https://chatgpt.com/' }; },
    async activateTab() {},
    async reloadTab(tabId) { actions.push(`reload:${tabId}`); reloaded = true; return { id: tabId, status: 'complete' }; },
    async send(_tabId, message) {
      actions.push(message.type);
      if (message.type === 'CHATGPT_LIST_PROJECTS') return [];
      if (message.type === 'CHATGPT_CREATE_PROJECT') {
        createCalls += 1;
        if (!reloaded) return { ok: false, error: { code: 'UI_SELECTOR_INCOMPATIBLE', message: 'Projects section was not found while resolving the create action' } };
        return { name: message.projectName, href: '/project/new' };
      }
      return {};
    }
  };
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    pollMs: 1,
    now: () => new Date('2026-08-27T12:43:00+08:00'),
    timeZone: 'Asia/Shanghai'
  });

  const result = await driver.createTaskProject({ task: { task_id: 't2', project_id: 'vetatool' }, state: {} });

  assert.equal(createCalls, 2);
  assert.equal(result.projectName.startsWith('vetatool_ewan_'), true);
  assert.ok(actions.includes('reload:7'));
});

test('createTaskProject adopts the exact durable creation intent instead of creating a duplicate Project', async () => {
  const intended = 'vetatool_ewan_202608290900';
  const actions = [];
  const tabManager = {
    async findChatGptTab() { return { id: 7, url: 'https://chatgpt.com/' }; },
    async activateTab() {},
    async send(_tabId, message) {
      actions.push(message.type);
      if (message.type === 'CHATGPT_LIST_PROJECTS') return [{ name: intended, href: '/project/existing' }];
      if (message.type === 'CHATGPT_CREATE_PROJECT') throw new Error('must not create a duplicate Project');
      return {};
    }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });
  const result = await driver.createTaskProject({
    task: { task_id: 't-intent', project_id: 'vetatool' },
    state: {},
    creationIntentProjectName: intended
  });

  assert.equal(result.projectName, intended);
  assert.equal(actions.filter(value => value === 'CHATGPT_CREATE_PROJECT').length, 0);
});

test('createTaskProject records the exact creation intent before submitting Create Project', async () => {
  const events = [];
  const tabManager = {
    async findChatGptTab() { return { id: 7, url: 'https://chatgpt.com/' }; },
    async activateTab() {},
    async send(_tabId, message) {
      if (message.type === 'CHATGPT_LIST_PROJECTS') return [];
      if (message.type === 'CHATGPT_CREATE_PROJECT') {
        events.push(`create:${message.projectName}`);
        return { name: message.projectName, href: '/project/new' };
      }
      return {};
    }
  };
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    pollMs: 1,
    now: () => new Date('2026-08-29T09:00:00+08:00'),
    timeZone: 'Asia/Shanghai'
  });
  const result = await driver.createTaskProject({
    task: { task_id: 't-intent-order', project_id: 'vetatool' },
    state: {},
    async onProjectCreateIntent(projectName) { events.push(`intent:${projectName}`); }
  });

  assert.deepEqual(events, [`intent:${result.projectName}`, `create:${result.projectName}`]);
});


test('createTaskChat prepares a normal New Chat in the owned slot without any Project command', async () => {
  const actions = [];
  const tabManager = {
    async findChatGptTab() { actions.push('find'); return { id: 7, url: 'https://chatgpt.com/c/old' }; },
    async navigateTab(tabId, url) { actions.push(`navigate:${tabId}:${url}`); return { id: tabId, url, status: 'complete' }; },
    async send(_tabId, message) {
      actions.push(`send:${message.type}`);
      if (message.type === 'CHATGPT_PREPARE_NEW_CHAT') return { composerPresent: true };
      return {};
    }
  };
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });

  const result = await driver.createTaskChat({
    task: { task_id: 'chat-1', project_id: 'vetatool', agent_control: { assignment_id: 'assignment-1' } },
    state: { patch_session_id: 'ps-1', assignment_id: 'assignment-1' }
  });

  assert.deepEqual(result, {
    projectName: null,
    browserWorkspaceId: 'assignment-1',
    patchSessionId: 'ps-1',
    tabId: 7
  });
  assert.deepEqual(actions, ['find', 'navigate:7:https://chatgpt.com/', 'send:CHATGPT_PREPARE_NEW_CHAT']);
  assert.equal(actions.some(action => action.includes('PROJECT')), false);
});

test('initializeTask attaches every resource sequentially before sending the mode-specific initialization prompt', async () => {
  const order = [];
  let latestText = '';
  let stateReads = 0;
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') { order.push(`attach:${message.resource.filename}`); return { attached: true, filename: message.resource.filename }; }
    if (message.type === 'CHATGPT_SEND_PROMPT') { order.push(`prompt:${message.text}`); latestText = INITIALIZATION_READY_MARKER; return { ok: true }; }
    if (message.type === 'CHATGPT_STATE') return { state: stateReads++ === 0 ? 'GENERATING' : 'READY', contextLimit: false };
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: latestText };
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1 });
  driver.tabId = 7;

  const result = await driver.initializeTask({
    task: { task_id: 'chat-init' },
    state: { task_id: 'chat-init' },
    resources: [
      { filename: 'LLM_RULES.md', mimeType: 'text/markdown', size: 5, base64: 'cnVsZXM=' },
      { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }
    ],
    initializationPrompt: CHAT_INITIALIZATION_PROMPT,
    hooks: { async onAttachmentReady({ filename }) { order.push(`ready:${filename}`); } }
  });

  assert.equal(result.assistantText, INITIALIZATION_READY_MARKER);
  assert.deepEqual(order.slice(0, 5), [
    'attach:LLM_RULES.md',
    'ready:LLM_RULES.md',
    'attach:source.zip',
    'ready:source.zip',
    `prompt:${CHAT_INITIALIZATION_PROMPT}`
  ]);
});

test('BrowserPageDriver returns the exact current conversation identity from content code', async () => {
  const tabManager = fakeTabManager(message => message.type === 'CHATGPT_CONVERSATION_IDENTITY'
    ? { conversationUrl: 'https://chatgpt.com/c/conv-2', conversationId: 'conv-2' }
    : {});
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {} });
  driver.tabId = 7;

  assert.deepEqual(await driver.currentConversationIdentity(), {
    conversationUrl: 'https://chatgpt.com/c/conv-2',
    conversationId: 'conv-2'
  });
});

test('initializeTask never sends the initialization prompt when either owned attachment fails', async () => {
  const messages = [];
  const tabManager = fakeTabManager(message => {
    messages.push(message.type);
    if (message.type === 'CHATGPT_ATTACH_RESOURCE' && message.resource.filename === 'source.zip') {
      throw new RunnerError(ERROR_CODES.RESOURCE_UPLOAD_FAILED, 'source attachment failed');
    }
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') return { attached: true };
    return {};
  });
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, pollMs: 1 });
  driver.tabId = 7;

  await assert.rejects(
    driver.initializeTask({
      task: { task_id: 'chat-attach-failure' },
      resources: [
        { filename: 'LLM_RULES.md', base64: 'cnVsZXM=' },
        { filename: 'source.zip', base64: 'AQID' }
      ],
      initializationPrompt: CHAT_INITIALIZATION_PROMPT
    }),
    error => error?.code === ERROR_CODES.RESOURCE_UPLOAD_FAILED
  );
  assert.equal(messages.includes('CHATGPT_SEND_PROMPT'), false);
});
