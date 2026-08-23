import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPageDriver } from '../src/background/browser-page-driver.js';
import { INITIALIZATION_PROMPT, INITIALIZATION_READY_MARKER } from '../src/shared/task-schema.js';
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
  const driver = new BrowserPageDriver({ tabManager, sleep: async () => {}, stableReadsRequired: 1, pollMs: 1, generationStartTimeoutMs: 5 });
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
