import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCalibrationMatrix } from '../src/content/calibration-matrix.js';

function node({ tagName = 'DIV', text = '', attrs = {}, visible = true, children = [], parent = null } = {}) {
  const item = {
    tagName,
    textContent: text,
    hidden: !visible,
    parentElement: parent,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return visible ? { width: 20, height: 20 } : { width: 0, height: 0 }; },
    querySelectorAll(selector) {
      if (selector.includes('button') || selector.includes('[role="button"]')) return children.filter(child => child.tagName === 'BUTTON');
      return children;
    },
    click() { throw new Error('calibration must never click'); }
  };
  for (const child of children) child.parentElement = item;
  return item;
}

function fullFixture() {
  const composer = node({ tagName: 'TEXTAREA', attrs: { placeholder: 'Secret prompt composer' } });
  const send = node({ tagName: 'BUTTON', attrs: { 'aria-label': 'Send prompt' } });
  const patchLink = node({ tagName: 'A', text: 'download secret-session-001-fix.patch', attrs: { href: 'https://secret.invalid/secret-session-001-fix.patch?token=hidden' } });
  const assistant = node({ tagName: 'DIV', text: 'private assistant response', attrs: { 'data-message-author-role': 'assistant' }, children: [patchLink] });
  assistant.querySelectorAll = selector => selector.includes('a[href]') ? [patchLink] : [];
  const newChat = node({ tagName: 'BUTTON', attrs: { 'aria-label': 'New chat' } });
  const newProject = node({ tagName: 'BUTTON', attrs: { 'aria-label': 'New project' }, text: 'New project' });
  const projectSettings = node({ tagName: 'BUTTON', attrs: { role: 'menuitem', 'aria-label': 'Project settings' }, text: 'Project settings' });
  const deleteProject = node({ tagName: 'BUTTON', attrs: { role: 'menuitem', 'aria-label': 'Delete project' }, text: 'Delete project' });
  const deleteConversation = node({ tagName: 'BUTTON', attrs: { role: 'menuitem', 'aria-label': 'Delete conversation' }, text: 'Delete conversation' });
  const fileInput = node({ tagName: 'INPUT', attrs: { type: 'file', name: 'secret-upload-input' }, visible: false });
  const projectLink = node({ tagName: 'A', text: 'Secret Project Alpha', attrs: { href: '/project/secret-project-alpha' } });
  const conversationLink = node({ tagName: 'A', text: 'Secret Conversation', attrs: { href: '/c/secret-conversation-id' } });
  const allButtons = [send, newChat, newProject, projectSettings, deleteProject, deleteConversation];
  const root = {
    title: 'Secret Project Alpha - ChatGPT',
    body: { innerText: 'Maximum conversation length reached. private assistant response' },
    documentElement: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'a[href], button, [role="button"], [role="link"]') return [conversationLink, ...allButtons, projectLink];
      if (selector === 'textarea, [contenteditable="true"]') return [composer];
      if (selector.includes('button[aria-label]') || selector.includes('button[title]') || selector.includes('button[data-testid]')) return allButtons;
      if (selector === '[data-message-author-role="assistant"]') return [assistant];
      if (selector.includes('input[type="file"]')) return [fileInput];
      if (selector === 'button, [role="button"]') return allButtons;
      if (selector.includes('a[href*="/g/"]') || selector.includes('a[href*="/project"]') || selector.includes('[role="link"]')) return [projectLink, conversationLink];
      if (selector.includes('textarea') || selector.includes('[contenteditable="true"]') || selector.includes('button') || selector.includes('a[href]') || selector.includes('input') || selector.includes('iframe') || selector.includes('form')) {
        return [composer, ...allButtons, projectLink, conversationLink, fileInput];
      }
      return [];
    }
  };
  return { root };
}

test('collects a fixed read-only calibration matrix using only safe enums and counts', () => {
  const { root } = fullFixture();
  const result = collectCalibrationMatrix(root, {
    location: { hostname: 'chatgpt.com', pathname: '/project/secret-project-alpha', href: 'https://chatgpt.com/project/secret-project-alpha?secret=1#token' },
    title: root.title
  });

  assert.deepEqual(result.selector_profile, { id: 'chatgpt-semantic-v1', version: 1 });
  assert.equal(result.page.category, 'project');
  assert.equal(result.summary.incompatible, 0);
  const byId = Object.fromEntries(result.checks.map(check => [check.id, check]));
  for (const id of ['access','composer','model_state','latest_assistant','patch_candidates','context_limit','project_create','project_settings','project_delete','resource_input','new_chat','conversation_delete']) {
    assert.ok(byId[id], `missing ${id}`);
  }
  for (const id of ['access','composer','model_state','latest_assistant','patch_candidates','context_limit','project_create','project_settings','project_delete','resource_input','new_chat','conversation_delete']) {
    assert.equal(byId[id].status, 'pass', `${id} should pass`);
  }
  for (const id of ['composer','patch_candidates','project_create','project_settings','project_delete','resource_input','new_chat','conversation_delete']) {
    assert.ok(Array.isArray(byId[id].evidence.fingerprints), `${id} fingerprints missing`);
    assert.ok(byId[id].evidence.fingerprints.length >= 1 && byId[id].evidence.fingerprints.length <= 3, `${id} fingerprint count`);
  }
  assert.equal(byId.patch_candidates.evidence.fingerprints[0].semantic_hint, 'patch_download');
  assert.equal(byId.resource_input.evidence.fingerprints[0].type, 'file');
  const serialized = JSON.stringify(result).toLowerCase();
  for (const secret of ['secret project alpha','private assistant response','secret-session-001-fix.patch','secret.invalid','secret=1','#token','secret prompt composer','secret-upload-input']) {
    assert.equal(serialized.includes(secret), false, `calibration leaked ${secret}`);
  }
});

test('new_chat calibration recognizes the current create-new-chat-button sidebar anchor', () => {
  const newChat = node({
    tagName: 'A',
    text: '新聊天',
    attrs: { 'data-testid': 'create-new-chat-button', 'data-sidebar-item': 'true', href: '/' }
  });
  const composer = node({ tagName: 'TEXTAREA' });
  const root = {
    title: 'ChatGPT',
    body: { innerText: '' },
    documentElement: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'a[href], button, [role="button"], [role="link"]') return [newChat];
      if (selector === 'textarea, [contenteditable="true"]') return [composer];
      if (selector.includes('textarea') || selector.includes('[contenteditable="true"]') || selector.includes('a[href]')) return [composer, newChat];
      return [];
    }
  };

  const result = collectCalibrationMatrix(root, {
    location: { hostname: 'chatgpt.com', pathname: '/', href: 'https://chatgpt.com/' },
    title: root.title
  });
  const newChatCheck = result.checks.find(check => check.id === 'new_chat');

  assert.equal(newChatCheck.status, 'pass');
  assert.equal(newChatCheck.evidence.candidate_count, 1);
  assert.equal(newChatCheck.evidence.fingerprints[0].test_id_category, 'new_chat');
});

test('new_chat calibration prefers the exact sidebar machine control over another visible semantic New Chat control', () => {
  const sidebar = node({
    tagName: 'A',
    text: '新聊天',
    attrs: { 'data-testid': 'create-new-chat-button', 'data-sidebar-item': 'true', href: '/' }
  });
  const secondary = node({ tagName: 'BUTTON', attrs: { 'aria-label': 'New chat' } });
  const composer = node({ tagName: 'TEXTAREA' });
  const root = {
    title: 'ChatGPT',
    body: { innerText: '' },
    documentElement: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'a[href], button, [role="button"], [role="link"]') return [sidebar, secondary];
      if (selector === 'textarea, [contenteditable="true"]') return [composer];
      if (selector.includes('textarea') || selector.includes('[contenteditable="true"]') || selector.includes('a[href]') || selector.includes('button')) return [composer, sidebar, secondary];
      return [];
    }
  };

  const result = collectCalibrationMatrix(root, {
    location: { hostname: 'chatgpt.com', pathname: '/', href: 'https://chatgpt.com/' },
    title: root.title
  });
  const newChatCheck = result.checks.find(check => check.id === 'new_chat');

  assert.equal(newChatCheck.status, 'pass');
  assert.equal(newChatCheck.evidence.candidate_count, 1);
  assert.equal(newChatCheck.evidence.fingerprints[0].test_id_category, 'new_chat');
});

test('temporary UI absence is unavailable while structural ambiguity is incompatible', () => {
  const composerA = node({ tagName: 'TEXTAREA' });
  const composerB = node({ tagName: 'TEXTAREA' });
  const root = {
    body: { innerText: '' },
    documentElement: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'textarea, [contenteditable="true"]') return [composerA, composerB];
      if (selector.includes('textarea') || selector.includes('[contenteditable="true"]')) return [composerA, composerB];
      return [];
    }
  };
  const result = collectCalibrationMatrix(root, {
    location: { hostname: 'chatgpt.com', pathname: '/c/secret', href: 'https://chatgpt.com/c/secret' },
    title: 'ChatGPT'
  });
  const byId = Object.fromEntries(result.checks.map(check => [check.id, check]));
  assert.equal(byId.composer.status, 'incompatible');
  assert.equal(byId.composer.evidence.candidate_count, 2);
  assert.equal(byId.composer.evidence.fingerprints.length, 1);
  assert.equal(byId.patch_candidates.status, 'unavailable');
  assert.equal(byId.context_limit.status, 'unavailable');
  assert.equal(byId.project_settings.status, 'unavailable');
  assert.equal(byId.resource_input.status, 'unavailable');
});


test('project create calibration passes for the current Projects header plus action without clicking it', () => {
  const plusButton = node({ tagName: 'BUTTON', text: '' });
  const moreButton = node({ tagName: 'BUTTON', attrs: { 'aria-label': 'More' } });
  const projectsHeading = node({ tagName: 'DIV', text: '项目' });
  const header = node({ tagName: 'DIV', children: [projectsHeading, plusButton, moreButton] });
  const composer = node({ tagName: 'TEXTAREA' });
  const root = {
    body: { innerText: '' },
    documentElement: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'a[href], button, [role="button"], [role="link"]') return [conversationLink, ...allButtons, projectLink];
      if (selector === 'textarea, [contenteditable="true"]') return [composer];
      if (selector === 'button, [role="button"]') return [plusButton, moreButton];
      if (selector.includes('h1') || selector.includes('h2') || selector.includes('h3') || selector.includes('div') || selector.includes('span')) return [projectsHeading];
      if (selector.includes('textarea') || selector.includes('[contenteditable="true"]') || selector.includes('button')) return [composer, plusButton, moreButton];
      return [];
    }
  };

  const result = collectCalibrationMatrix(root, {
    location: { hostname: 'chatgpt.com', pathname: '/', href: 'https://chatgpt.com/' },
    title: 'ChatGPT'
  });
  const byId = Object.fromEntries(result.checks.map(check => [check.id, check]));
  assert.equal(byId.project_create.status, 'pass');
  assert.equal(byId.project_create.evidence.stage, 'projects_header_action');
  assert.equal(plusButton.clicked, undefined);
});

test('new_chat calibration prefers the revealed current sidebar row over an unrevealed exact duplicate', () => {
  const staleClone = node({
    tagName: 'A',
    text: '新聊天',
    attrs: { 'data-testid': 'create-new-chat-button', 'data-sidebar-item': 'true', href: '/' }
  });
  const revealed = node({
    tagName: 'A',
    text: '新聊天',
    attrs: { 'data-testid': 'create-new-chat-button', 'data-sidebar-item': 'true', 'data-revealed': '', href: '/' }
  });
  const composer = node({ tagName: 'TEXTAREA' });
  const root = {
    title: 'ChatGPT',
    body: { innerText: '' },
    documentElement: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'a[href], button, [role="button"], [role="link"]') return [staleClone, revealed];
      if (selector === 'textarea, [contenteditable="true"]') return [composer];
      if (selector.includes('textarea') || selector.includes('[contenteditable="true"]') || selector.includes('a[href]')) return [composer, staleClone, revealed];
      return [];
    }
  };

  const result = collectCalibrationMatrix(root, {
    location: { hostname: 'chatgpt.com', pathname: '/', href: 'https://chatgpt.com/' },
    title: root.title
  });
  const newChatCheck = result.checks.find(check => check.id === 'new_chat');

  assert.equal(newChatCheck.status, 'pass');
  assert.equal(newChatCheck.evidence.candidate_count, 1);
});
