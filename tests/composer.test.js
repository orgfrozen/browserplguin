import test from 'node:test';
import assert from 'node:assert/strict';
import { Composer } from '../src/content/composer.js';

function editor({ contenteditable = false } = {}) {
  return {
    tagName: contenteditable ? 'DIV' : 'TEXTAREA',
    value: '',
    textContent: '',
    focused: 0,
    events: [],
    focus() { this.focused += 1; },
    getAttribute(name) {
      if (name === 'contenteditable') return contenteditable ? 'true' : null;
      return null;
    },
    dispatchEvent(event) { this.events.push(event?.type ?? 'unknown'); return true; }
  };
}

function button(attrs = {}) {
  return {
    clicked: 0,
    textContent: attrs.text ?? '',
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { width: 10, height: 10 }; },
    click() { this.clicked += 1; }
  };
}

test('sendPrompt recognizes send button from data-testid and dispatches input', async () => {
  const input = editor();
  const send = button({ 'data-testid': 'send-button' });
  const root = {
    querySelector() { return input; },
    querySelectorAll() { return [send]; }
  };
  await new Composer(root).sendPrompt('修复 sitemap bug');
  assert.equal(input.value, '修复 sitemap bug');
  assert.ok(input.events.includes('input'));
  assert.equal(send.clicked, 1);
});

test('sendPrompt supports contenteditable composer', async () => {
  const input = editor({ contenteditable: true });
  delete input.value;
  const send = button({ 'aria-label': 'Send prompt' });
  const root = {
    querySelector() { return input; },
    querySelectorAll() { return [send]; }
  };
  await new Composer(root).sendPrompt('继续');
  assert.equal(input.textContent, '继续');
  assert.equal(send.clicked, 1);
});

function fileInput() {
  return {
    files: null,
    events: [],
    getAttribute(name) { return name === 'type' ? 'file' : null; },
    dispatchEvent(event) { this.events.push(event?.type ?? 'unknown'); return true; }
  };
}

test('attachResource injects a File into the unique composer file input and waits for ready attachment', async () => {
  const input = editor();
  const upload = fileInput();
  let attachmentVisible = false;
  upload.dispatchEvent = function(event) {
    this.events.push(event?.type ?? 'unknown');
    if (event?.type === 'change') attachmentVisible = true;
    return true;
  };
  const attachment = button({ 'data-testid': 'file-attachment', text: 'source.zip' });
  const form = {
    querySelectorAll(selector) {
      if (selector === 'input[type="file"]') return [upload];
      if (selector.includes('[data-testid]')) return attachmentVisible ? [attachment] : [];
      if (selector === '[role="progressbar"]') return [];
      return [];
    }
  };
  input.closest = selector => selector === 'form' ? form : null;
  const root = {
    querySelector(selector) { return selector.includes('textarea') ? input : null; },
    querySelectorAll() { return []; }
  };
  const madeFiles = [];
  const composer = new Composer(root, {
    sleep: async () => {}, pollMs: 1, timeoutMs: 10, readyReadsRequired: 1,
    fileFactory(bytes, filename, options) {
      const file = { bytes: [...bytes], name: filename, type: options.type };
      madeFiles.push(file);
      return file;
    },
    dataTransferFactory() {
      const files = [];
      return { items: { add(file) { files.push(file); } }, get files() { return files; } };
    }
  });
  const result = await composer.attachResource({ filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' });
  assert.deepEqual(result, { attached: true, filename: 'source.zip' });
  assert.deepEqual(madeFiles[0].bytes, [1, 2, 3]);
  assert.equal(upload.files[0].name, 'source.zip');
  assert.ok(upload.events.includes('change'));
});

test('attachResource reveals the current composer plus menu and selects the file input associated with Add photos and files', async () => {
  const input = editor();
  let menuVisible = false;
  let attachmentVisible = false;
  const upload = fileInput();
  upload.dispatchEvent = function(event) {
    this.events.push(event?.type ?? 'unknown');
    if (event?.type === 'change') attachmentVisible = true;
    return true;
  };
  const uploadAction = button({ text: '添加照片和文件' });
  uploadAction.tagName = 'LABEL';
  uploadAction.querySelectorAll = selector => selector === 'input[type="file"]' ? [upload] : [];
  const plus = button({ 'aria-label': '添加文件及其他' });
  plus.click = function() { this.clicked += 1; menuVisible = true; };
  const attachment = button({ 'data-testid': 'file-attachment', text: 'source.zip' });
  const form = {
    querySelectorAll(selector) {
      if (selector === 'input[type="file"]') return [];
      if (selector.includes('[data-testid]')) return attachmentVisible ? [attachment] : [];
      if (selector === '[role="progressbar"]') return [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [plus];
      return [];
    }
  };
  input.closest = selector => selector === 'form' ? form : null;
  const root = {
    querySelector(selector) { return selector.includes('textarea') ? input : null; },
    querySelectorAll(selector) {
      if (selector.includes('[role="menuitem"]') || selector.includes('label')) return menuVisible ? [uploadAction] : [];
      if (selector === 'input[type="file"]') return [];
      return [];
    }
  };
  const composer = new Composer(root, {
    sleep: async () => {}, pollMs: 1, timeoutMs: 10, readyReadsRequired: 1,
    fileFactory(bytes, filename, options) { return { bytes: [...bytes], name: filename, type: options.type }; },
    dataTransferFactory() {
      const files = [];
      return { items: { add(file) { files.push(file); } }, get files() { return files; } };
    }
  });
  const result = await composer.attachResource({ filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' });
  assert.equal(plus.clicked, 1);
  assert.equal(upload.files[0].name, 'source.zip');
  assert.deepEqual(result, { attached: true, filename: 'source.zip' });
});

test('current ChatGPT composer prefers visible #prompt-textarea over the fallback textarea', () => {
  const fallback = editor();
  fallback.getAttribute = name => name === 'placeholder' ? 'test2中的新聊天' : null;
  const rich = editor({ contenteditable: true });
  rich.id = 'prompt-textarea';
  rich.getAttribute = name => {
    if (name === 'contenteditable') return 'true';
    if (name === 'role') return 'textbox';
    if (name === 'id') return 'prompt-textarea';
    return null;
  };
  const root = {
    querySelector(selector) {
      if (selector.includes('#prompt-textarea')) return rich;
      if (selector.includes('textarea')) return fallback;
      return null;
    },
    querySelectorAll() { return []; }
  };
  const composer = new Composer(root);
  assert.equal(composer.findEditor(), rich);
});

test('current ChatGPT composer attachment menu recognizes aria-label 添加文件等', () => {
  const input = editor({ contenteditable: true });
  const plus = button({ 'aria-label': '添加文件等', 'data-testid': 'composer-plus-btn' });
  const form = { querySelectorAll() { return [plus]; } };
  input.closest = selector => selector === 'form' ? form : null;
  const root = { querySelector() { return input; }, querySelectorAll() { return []; } };
  const composer = new Composer(root);
  assert.equal(composer.findAttachmentMenuTrigger(), plus);
});

test('sendPrompt waits for the current ChatGPT send button to become enabled after upload', async () => {
  const input = editor({ contenteditable: true });
  delete input.value;
  let enabled = false;
  const send = button({ 'data-testid': 'send-button' });
  send.getAttribute = name => {
    if (name === 'data-testid') return 'send-button';
    if (name === 'aria-label') return '发送提示';
    if (name === 'aria-disabled') return enabled ? 'false' : 'true';
    return null;
  };
  send.click = function() {
    if (this.getAttribute('aria-disabled') === 'false') this.clicked += 1;
  };
  const root = {
    querySelector() { return input; },
    querySelectorAll() { return [send]; }
  };
  let sleeps = 0;
  const composer = new Composer(root, {
    pollMs: 1,
    timeoutMs: 10,
    sleep: async () => {
      sleeps += 1;
      if (sleeps >= 2) enabled = true;
    }
  });

  await composer.sendPrompt('分析源码后开始执行任务');

  assert.equal(send.clicked, 1);
  assert.ok(sleeps >= 2);
});


test('sendPrompt treats three minutes without semantic composer progress as COMPOSER_STALLED', async () => {
  const input = editor({ contenteditable: true });
  delete input.value;
  const send = button({ 'data-testid': 'send-button' });
  send.getAttribute = name => {
    if (name === 'data-testid') return 'send-button';
    if (name === 'aria-label') return '发送提示';
    if (name === 'aria-disabled') return 'true';
    return null;
  };
  const root = {
    querySelector() { return input; },
    querySelectorAll() { return [send]; }
  };
  let nowMs = 0;
  const composer = new Composer(root, {
    pollMs: 2000,
    stallTimeoutMs: 180000,
    now: () => nowMs,
    sleep: async ms => { nowMs += ms; }
  });

  await assert.rejects(
    composer.sendPrompt('分析源码'),
    error => error?.code === 'COMPOSER_STALLED'
      && error?.details?.stall_timeout_ms === 180000
      && error?.details?.poll_ms === 2000
  );
  assert.equal(send.clicked, 0);
});

test('sendPrompt resets the three-minute watchdog when semantic send state makes progress', async () => {
  const input = editor({ contenteditable: true });
  delete input.value;
  let phase = 0;
  const send = button({ 'data-testid': 'send-button' });
  send.getAttribute = name => {
    if (name === 'data-testid') return 'send-button';
    if (name === 'aria-label') return '发送提示';
    if (name === 'aria-disabled') return phase >= 2 ? 'false' : 'true';
    return null;
  };
  const root = {
    querySelector() { return input; },
    querySelectorAll() { return phase === 0 ? [] : [send]; }
  };
  let nowMs = 0;
  const composer = new Composer(root, {
    pollMs: 2000,
    stallTimeoutMs: 180000,
    now: () => nowMs,
    sleep: async ms => {
      nowMs += ms;
      if (nowMs >= 170000 && phase === 0) phase = 1;
      if (nowMs >= 340000 && phase === 1) phase = 2;
    }
  });

  await composer.sendPrompt('分析源码');

  assert.equal(send.clicked, 1);
  assert.ok(nowMs >= 340000, 'total wall time may exceed three minutes when progress resets the watchdog');
});

test('attachResource reuses an existing ready source attachment after page recovery instead of uploading a duplicate', async () => {
  const input = editor();
  const attachment = button({ 'data-testid': 'file-attachment', text: 'source.zip' });
  const form = {
    querySelectorAll(selector) {
      if (selector.includes('[data-testid]')) return [attachment];
      if (selector === '[role="progressbar"]') return [];
      if (selector === 'input[type="file"]') return [];
      return [];
    }
  };
  input.closest = selector => selector === 'form' ? form : null;
  const root = {
    querySelector(selector) { return selector.includes('textarea') ? input : null; },
    querySelectorAll() { return []; }
  };
  const composer = new Composer(root, {
    readyReadsRequired: 1,
    fileFactory() { throw new Error('must not build a duplicate File'); },
    dataTransferFactory() { throw new Error('must not create duplicate DataTransfer'); }
  });

  const result = await composer.attachResource({ filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' });

  assert.deepEqual(result, { attached: true, filename: 'source.zip', reused: true });
});

test('sendPrompt reacts to MutationObserver progress without waiting for the two-second polling fallback', async () => {
  const input = editor({ contenteditable: true });
  delete input.value;
  let enabled = false;
  let observerCallback = null;
  class FakeMutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const send = button({ 'data-testid': 'send-button' });
  send.getAttribute = name => {
    if (name === 'data-testid') return 'send-button';
    if (name === 'aria-label') return '发送提示';
    if (name === 'aria-disabled') return enabled ? 'false' : 'true';
    return null;
  };
  const root = {
    querySelector() { return input; },
    querySelectorAll() { return [send]; }
  };
  const composer = new Composer(root, {
    pollMs: 2000,
    stallTimeoutMs: 180000,
    MutationObserverCtor: FakeMutationObserver,
    sleep: async () => new Promise(() => {})
  });

  const pending = composer.sendPrompt('继续执行');
  for (let i = 0; i < 10 && !observerCallback; i += 1) await Promise.resolve();
  assert.equal(typeof observerCallback, 'function');
  enabled = true;
  observerCallback();
  await pending;

  assert.equal(send.clicked, 1);
});
