import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPageDriver } from '../src/background/browser-page-driver.js';
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

test('createTaskProject allocates a fresh collision-safe project and session on the open ChatGPT tab', async () => {
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_LIST_PROJECTS') return [{ name: 'vetatool2026081315', href: '/project/old' }];
    if (message.type === 'CHATGPT_CREATE_PROJECT') return { name: message.projectName, href: '/project/new' };
    if (message.type === 'CHATGPT_SET_PROJECT_INSTRUCTIONS') return { saved: true };
    if (message.type === 'CHATGPT_RESOLVE_CHAT') return { composerPresent: true };
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    sleep: async () => {},
    now: () => new Date('2026-08-13T15:30:00+08:00'),
    timeZone: 'Asia/Shanghai',
    sessionIdFactory: () => 'b81ac90277aa'
  });
  const result = await driver.createTaskProject({ task: { task_id: 't1', project_id: 'vetatool', project_constraints: '' }, state: {} });
  assert.deepEqual(result, { projectName: 'vetatool2026081315-02', sessionId: 'b81ac90277aa', tabId: 7 });
  assert.ok(tabManager.messages.some(message => message.type === 'CHATGPT_CREATE_PROJECT' && message.projectName === 'vetatool2026081315-02'));
  const instructions = tabManager.messages.find(message => message.type === 'CHATGPT_SET_PROJECT_INSTRUCTIONS');
  assert.match(instructions.text, /b81ac90277aa/);
  assert.match(instructions.text, /001/);
  assert.match(instructions.text, /<TASK_STATUS>DONE<\/TASK_STATUS>/);
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

test('initializeTask downloads resource, attaches it, waits for initialization response, and does not discover patches', async () => {
  const states = [{ state: 'GENERATING', contextLimit: false }, { state: 'READY', contextLimit: false }];
  let stateIndex = 0;
  const loaded = [];
  const tabManager = fakeTabManager(message => {
    if (message.type === 'CHATGPT_ATTACH_RESOURCE') return { attached: true, filename: message.resource.filename };
    if (message.type === 'CHATGPT_SEND_PROMPT') return { ok: true };
    if (message.type === 'CHATGPT_STATE') return states[Math.min(stateIndex++, states.length - 1)];
    if (message.type === 'CHATGPT_LATEST_RESPONSE') return { text: '项目分析完成' };
    if (message.type === 'CHATGPT_DISCOVER_PATCHES') throw new Error('initialization must not discover patches');
    return {};
  });
  const driver = new BrowserPageDriver({
    tabManager,
    resourceLoader: { async load(resource) { loaded.push(resource); return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID', sourceUrl: resource.url }; } },
    sleep: async () => {}, stableReadsRequired: 1, pollMs: 1
  });
  driver.tabId = 7;
  const task = { resource: { url: 'https://assets.example.com/source.zip' }, initialization_prompt: '先分析项目' };
  const result = await driver.initializeTask({ task, state: { session_id: 's1' } });
  assert.deepEqual(loaded, [task.resource]);
  assert.equal(result.contextLimit, false);
  assert.equal(result.assistantText, '项目分析完成');
  assert.ok(tabManager.messages.some(message => message.type === 'CHATGPT_ATTACH_RESOURCE' && message.resource.filename === 'source.zip'));
  assert.ok(tabManager.messages.some(message => message.type === 'CHATGPT_SEND_PROMPT' && message.text === '先分析项目'));
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
