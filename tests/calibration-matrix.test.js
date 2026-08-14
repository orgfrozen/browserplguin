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
  const newProject = node({ tagName: 'BUTTON', attrs: { 'aria-label': 'New project' }, text: 'New project' });
  const projectSettings = node({ tagName: 'BUTTON', attrs: { role: 'menuitem', 'aria-label': 'Project settings' }, text: 'Project settings' });
  const deleteProject = node({ tagName: 'BUTTON', attrs: { role: 'menuitem', 'aria-label': 'Delete project' }, text: 'Delete project' });
  const fileInput = node({ tagName: 'INPUT', attrs: { type: 'file', name: 'secret-upload-input' }, visible: false });
  const projectLink = node({ tagName: 'A', text: 'Secret Project Alpha', attrs: { href: '/project/secret-project-alpha' } });
  const allButtons = [send, newProject, projectSettings, deleteProject];
  const root = {
    title: 'Secret Project Alpha - ChatGPT',
    body: { innerText: 'Maximum conversation length reached. private assistant response' },
    documentElement: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'textarea, [contenteditable="true"]') return [composer];
      if (selector.includes('button[aria-label]') || selector.includes('button[title]') || selector.includes('button[data-testid]')) return allButtons;
      if (selector === '[data-message-author-role="assistant"]') return [assistant];
      if (selector.includes('input[type="file"]')) return [fileInput];
      if (selector === 'button, [role="button"]') return allButtons;
      if (selector.includes('a[href*="/g/"]') || selector.includes('a[href*="/project"]') || selector.includes('[role="link"]')) return [projectLink];
      if (selector.includes('textarea') || selector.includes('[contenteditable="true"]') || selector.includes('button') || selector.includes('a[href]') || selector.includes('input') || selector.includes('iframe') || selector.includes('form')) {
        return [composer, ...allButtons, projectLink, fileInput];
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
  for (const id of ['access','composer','model_state','latest_assistant','patch_candidates','context_limit','project_create','project_settings','project_delete','resource_input']) {
    assert.ok(byId[id], `missing ${id}`);
  }
  for (const id of ['access','composer','model_state','latest_assistant','patch_candidates','context_limit','project_create','project_settings','project_delete','resource_input']) {
    assert.equal(byId[id].status, 'pass', `${id} should pass`);
  }
  const serialized = JSON.stringify(result).toLowerCase();
  for (const secret of ['secret project alpha','private assistant response','secret-session-001-fix.patch','secret.invalid','secret=1','#token','secret prompt composer','secret-upload-input']) {
    assert.equal(serialized.includes(secret), false, `calibration leaked ${secret}`);
  }
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
  assert.equal(byId.patch_candidates.status, 'unavailable');
  assert.equal(byId.context_limit.status, 'unavailable');
  assert.equal(byId.project_settings.status, 'unavailable');
  assert.equal(byId.resource_input.status, 'unavailable');
});
