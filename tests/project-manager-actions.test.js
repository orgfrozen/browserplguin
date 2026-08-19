import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectManager } from '../src/content/project-manager.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

function element({ tagName = 'BUTTON', text = '', attrs = {}, children = [], onClick = null } = {}) {
  const el = {
    tagName,
    textContent: text,
    hidden: false,
    value: '',
    children,
    parentElement: null,
    clicked: 0,
    focused: 0,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { width: 20, height: 20 }; },
    focus() { this.focused += 1; },
    click() { this.clicked += 1; onClick?.(this); },
    dispatchEvent() { return true; },
    querySelectorAll(selector) {
      if (selector.includes('input')) return children.filter(x => x.tagName === 'INPUT');
      if (selector.includes('button') || selector.includes('[role="button"]')) return children.filter(x => x.tagName === 'BUTTON');
      return children;
    }
  };
  for (const child of children) child.parentElement = el;
  return el;
}

function createRoot() {
  let dialogVisible = false;
  let created = false;
  const nameInput = element({ tagName: 'INPUT', attrs: { placeholder: 'Project name', type: 'text' } });
  const createButton = element({ text: 'Create project', onClick: () => { created = true; dialogVisible = false; } });
  const dialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [nameInput, createButton] });
  const newProject = element({ text: 'New project', attrs: { 'aria-label': 'New project' }, onClick: () => { dialogVisible = true; } });
  const projectLink = element({ tagName: 'A', text: 'vetatool2026081315', attrs: { href: '/project/p123' } });

  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialogVisible ? [dialog] : [];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return created ? [projectLink] : [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [newProject];
      return [];
    }
  };
  return { root, newProject, dialog, nameInput, createButton, projectLink };
}

test('createProject uses semantic New project flow and confirms exact created identity', async () => {
  const fixture = createRoot();
  const manager = new ProjectManager(fixture.root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const created = await manager.createProject({ projectName: 'vetatool2026081315' });
  assert.equal(fixture.newProject.clicked, 1);
  assert.equal(fixture.nameInput.value, 'vetatool2026081315');
  assert.equal(fixture.createButton.clicked, 1);
  assert.deepEqual(created, { name: 'vetatool2026081315', href: '/project/p123' });
});

test('createProject fails closed when New project entry is ambiguous', async () => {
  const a = element({ text: 'New project' });
  const b = element({ text: '新建项目' });
  const root = { querySelectorAll() { return [a, b]; } };
  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 2 });
  await assert.rejects(
    manager.createProject({ projectName: 'p' }),
    error => error instanceof RunnerError && error.code === ERROR_CODES.UI_SELECTOR_INCOMPATIBLE
  );
});

function settingsFixture() {
  let menuVisible = false;
  let dialogVisible = false;
  let saved = false;
  const instructions = element({ tagName: 'TEXTAREA', attrs: { placeholder: 'Project instructions' } });
  const save = element({ text: 'Save', onClick: () => { saved = true; dialogVisible = false; } });
  const dialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [instructions, save] });
  const settings = element({ text: 'Project settings', attrs: { role: 'menuitem' }, onClick: () => { dialogVisible = true; menuVisible = false; } });
  const menu = element({ tagName: 'DIV', attrs: { role: 'menu' }, children: [settings] });
  const projectMenu = element({ attrs: { 'aria-label': 'Project options' }, onClick: () => { menuVisible = true; } });
  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialogVisible ? [dialog] : [];
      if (selector.includes('[role="menuitem"]')) return menuVisible ? [settings] : [];
      if (selector.includes('[role="menu"]')) return menuVisible ? [menu] : [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [projectMenu];
      if (selector.includes('header') || selector.includes('[role="banner"]')) return [];
      return [];
    }
  };
  return { root, projectMenu, settings, instructions, save, get saved() { return saved; } };
}

test('setProjectInstructions opens project settings, replaces instructions, and saves', async () => {
  const fixture = settingsFixture();
  const manager = new ProjectManager(fixture.root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const result = await manager.setProjectInstructions('rules\nSession: abc123');
  assert.equal(fixture.projectMenu.clicked, 1);
  assert.equal(fixture.settings.clicked, 1);
  assert.equal(fixture.instructions.value, 'rules\nSession: abc123');
  assert.equal(fixture.save.clicked, 1);
  assert.equal(fixture.saved, true);
  assert.deepEqual(result, { saved: true });
});

function deleteFixture(projectName = 'vetatool2026081315') {
  let menuVisible = false;
  let confirmVisible = false;
  let deleted = false;
  const confirm = element({ text: 'Delete', onClick: () => { deleted = true; confirmVisible = false; } });
  const dialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [confirm] });
  const deleteAction = element({ text: 'Delete project', attrs: { role: 'menuitem' }, onClick: () => { confirmVisible = true; menuVisible = false; } });
  const projectMenu = element({ attrs: { 'aria-label': 'Project options' }, onClick: () => { menuVisible = true; } });
  const projectLink = element({ tagName: 'A', text: projectName, attrs: { href: '/project/task-owned' } });
  const row = element({ tagName: 'DIV', children: [projectLink, projectMenu] });
  const otherLink = element({ tagName: 'A', text: 'other-project', attrs: { href: '/project/other' } });
  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return confirmVisible ? [dialog] : [];
      if (selector.includes('[role="menuitem"]')) return menuVisible ? [deleteAction] : [];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return deleted ? [otherLink] : [projectLink, otherLink];
      return [];
    }
  };
  return { root, row, projectLink, projectMenu, deleteAction, confirm, get deleted() { return deleted; } };
}

test('deleteProject starts from exact owned project and verifies disappearance', async () => {
  const fixture = deleteFixture();
  const manager = new ProjectManager(fixture.root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const result = await manager.deleteProject('vetatool2026081315');
  assert.equal(fixture.projectMenu.clicked, 1);
  assert.equal(fixture.deleteAction.clicked, 1);
  assert.equal(fixture.confirm.clicked, 1);
  assert.equal(fixture.deleted, true);
  assert.deepEqual(result, { deleted: true, name: 'vetatool2026081315' });
});

test('project settings prefers the current project header menu over duplicate sidebar project menus', () => {
  const headerMenu = element({ attrs: { 'aria-label': 'Project options' } });
  const header = element({ tagName: 'HEADER', children: [headerMenu] });
  const sidebarMenu1 = element({ attrs: { 'aria-label': 'Project options' } });
  const sidebarMenu2 = element({ attrs: { 'aria-label': 'Project options' } });
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('header') || selector.includes('[role="banner"]')) return [header];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [headerMenu, sidebarMenu1, sidebarMenu2];
      return [];
    }
  };
  const manager = new ProjectManager(root);
  assert.equal(manager.findProjectMenuButton(), headerMenu);
});

test('createProject reveals the current sidebar New project control by hovering the Projects section', async () => {
  let revealed = false;
  let dialogVisible = false;
  let created = false;
  const nameInput = element({ tagName: 'INPUT', attrs: { placeholder: 'Project name', type: 'text' } });
  const createButton = element({ text: 'Create project', onClick: () => { created = true; dialogVisible = false; } });
  const dialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [nameInput, createButton] });
  const newProject = element({ text: '', attrs: { 'aria-label': 'New project' }, onClick: () => { dialogVisible = true; } });
  const projectsHeading = element({ tagName: 'DIV', text: '项目' });
  projectsHeading.dispatchEvent = event => {
    if (['pointerover', 'mouseover', 'mouseenter'].includes(event?.type)) revealed = true;
    return true;
  };
  const projectLink = element({ tagName: 'A', text: 'browserplguin2026081918', attrs: { href: '/g/g-p-test/project' } });

  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialogVisible ? [dialog] : [];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return created ? [projectLink] : [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return revealed ? [newProject] : [];
      if (selector.includes('h1') || selector.includes('h2') || selector.includes('h3') || selector.includes('div') || selector.includes('span')) return [projectsHeading];
      return [];
    }
  };

  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const result = await manager.createProject({ projectName: 'browserplguin2026081918' });
  assert.equal(revealed, true);
  assert.equal(newProject.clicked, 1);
  assert.equal(nameInput.value, 'browserplguin2026081918');
  assert.deepEqual(result, { name: 'browserplguin2026081918', href: '/g/g-p-test/project' });
});


test('createProject uses the Projects header plus action when the current ChatGPT UI has no text New project control', async () => {
  let dialogVisible = false;
  let created = false;
  const nameInput = element({ tagName: 'INPUT', attrs: { placeholder: '项目名称', type: 'text' } });
  const createButton = element({ text: '创建项目', onClick: () => { created = true; dialogVisible = false; } });
  const dialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [nameInput, createButton] });
  const plusButton = element({ text: '', onClick: () => { dialogVisible = true; } });
  const moreButton = element({ text: '', attrs: { 'aria-label': 'More' } });
  const projectsHeading = element({ tagName: 'DIV', text: '项目' });
  const header = element({ tagName: 'DIV', children: [projectsHeading, plusButton, moreButton] });
  const projectLink = element({ tagName: 'A', text: 'browserplguin2026081918', attrs: { href: '/g/g-p-test/project' } });

  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialogVisible ? [dialog] : [];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return created ? [projectLink] : [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [plusButton, moreButton];
      if (selector.includes('h1') || selector.includes('h2') || selector.includes('h3') || selector.includes('div') || selector.includes('span')) return [projectsHeading];
      return [];
    }
  };

  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const result = await manager.createProject({ projectName: 'browserplguin2026081918' });
  assert.equal(plusButton.clicked, 1);
  assert.equal(moreButton.clicked, 0);
  assert.equal(nameInput.value, 'browserplguin2026081918');
  assert.equal(createButton.clicked, 1);
  assert.deepEqual(result, { name: 'browserplguin2026081918', href: '/g/g-p-test/project' });
  assert.equal(header.children.length, 3);
});
