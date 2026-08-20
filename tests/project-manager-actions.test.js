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
  const projectMenu = element({ attrs: { 'aria-label': `打开 ${projectName} 的项目选项` }, onClick: () => { menuVisible = true; } });
  const projectRow = element({ tagName: 'DIV', text: projectName, attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_owned_' } });
  const row = element({ tagName: 'DIV', children: [projectRow, projectMenu] });
  const otherRow = element({ tagName: 'DIV', text: 'other-project', attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_other_' } });
  const otherMenu = element({ attrs: { 'aria-label': '打开 other-project 的项目选项' } });
  element({ tagName: 'DIV', children: [otherRow, otherMenu] });
  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return confirmVisible ? [dialog] : [];
      if (selector.includes('[role="menuitem"]')) return menuVisible ? [deleteAction] : [];
      if (selector.includes('[data-sidebar-item="true"]') && selector.includes('[role="button"]')) return deleted ? [otherRow] : [projectRow, otherRow];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return [];
      return [];
    }
  };
  return { root, row, projectRow, projectMenu, deleteAction, confirm, get deleted() { return deleted; } };
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


test('deleteProject fails closed when the exact Project is not present in the sidebar Project list', async () => {
  let menuVisible = false;
  let confirmVisible = false;
  let deleted = false;
  const projectName = 'browserplguin2026081921';
  const confirm = element({ text: '删除项目', onClick: () => { deleted = true; confirmVisible = false; } });
  const confirmDialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [confirm] });
  const deleteAction = element({ text: '删除项目', attrs: { role: 'menuitem' }, onClick: () => { menuVisible = false; confirmVisible = true; } });
  const pageMore = element({ attrs: { 'aria-label': `打开 ${projectName} 的项目选项` }, onClick: () => { menuVisible = true; } });
  const pageProjectLink = element({ tagName: 'A', text: projectName, attrs: { href: '/g/g-p-current/project' } });
  element({ tagName: 'DIV', children: [pageProjectLink, pageMore] });

  // If the sidebar Project list is not available at all, cleanup must not fall back
  // to a same-name anchor from the current page/content area.
  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return confirmVisible ? [confirmDialog] : [];
      if (selector.includes('[role="menuitem"]')) return menuVisible ? [deleteAction] : [];
      if (selector.includes('[data-sidebar-item="true"]') && selector.includes('[role="button"]')) return [];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return deleted ? [] : [pageProjectLink];
      return [];
    }
  };

  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 3 });
  await assert.rejects(
    manager.deleteProject(projectName),
    error => error instanceof RunnerError && error.code === ERROR_CODES.PROJECT_NOT_FOUND
  );
  assert.equal(pageMore.clicked, 0);
  assert.equal(deleteAction.clicked, 0);
  assert.equal(confirm.clicked, 0);
  assert.equal(deleted, false);
});

test('deleteProject uses only the exact matching sidebar Project row menu', async () => {
  let menuVisible = false;
  let confirmVisible = false;
  let deleted = false;
  const projectName = 'browserplguin2026081921';
  const confirm = element({ text: '删除项目', onClick: () => { deleted = true; confirmVisible = false; } });
  const confirmDialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [confirm] });
  const deleteAction = element({ text: '删除项目', attrs: { role: 'menuitem' }, onClick: () => { menuVisible = false; confirmVisible = true; } });

  const targetRow = element({ tagName: 'DIV', text: projectName, attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_target_' } });
  const targetHome = element({ attrs: { 'aria-label': '打开项目首页' } });
  const targetMenu = element({ attrs: { 'aria-label': `打开 ${projectName} 的项目选项` }, onClick: () => { menuVisible = true; } });
  element({ tagName: 'DIV', children: [targetRow, targetHome, targetMenu] });

  const otherRow = element({ tagName: 'DIV', text: 'union1', attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_other_' } });
  const otherMenu = element({ attrs: { 'aria-label': '打开 union1 的项目选项' } });
  element({ tagName: 'DIV', children: [otherRow, otherMenu] });

  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return confirmVisible ? [confirmDialog] : [];
      if (selector.includes('[role="menuitem"]')) return menuVisible ? [deleteAction] : [];
      if (selector.includes('[data-sidebar-item="true"]') && selector.includes('[role="button"]')) return deleted ? [otherRow] : [targetRow, otherRow];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return [];
      return [];
    }
  };

  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const result = await manager.deleteProject(projectName);
  assert.equal(targetMenu.clicked, 1);
  assert.equal(targetHome.clicked, 0);
  assert.equal(otherMenu.clicked, 0);
  assert.equal(deleteAction.clicked, 1);
  assert.equal(confirm.clicked, 1);
  assert.equal(deleted, true);
  assert.deepEqual(result, { deleted: true, name: projectName });
});

test('deleteProject confirms the current ChatGPT delete-project danger dialog', async () => {
  let menuVisible = false;
  let confirmVisible = false;
  let deleted = false;
  const projectName = 'browserplguin2026081921';
  const cancel = element({ text: '取消' });
  const confirm = element({ text: '从“聊天”和“工作”中删除', onClick: () => { deleted = true; confirmVisible = false; } });
  const confirmDialog = element({
    tagName: 'DIV',
    text: '要从“聊天”和“工作”中删除此项目吗？',
    attrs: { role: 'dialog', 'data-state': 'open' },
    children: [confirm, cancel]
  });
  const deleteAction = element({
    text: '删除项目',
    attrs: { role: 'menuitem' },
    onClick: () => { menuVisible = false; confirmVisible = true; }
  });
  const projectMenu = element({
    attrs: { 'aria-label': `打开 ${projectName} 的项目选项` },
    onClick: () => { menuVisible = true; }
  });
  const projectRow = element({
    tagName: 'DIV',
    text: projectName,
    attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_owned_' }
  });
  element({ tagName: 'DIV', children: [projectRow, projectMenu] });

  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return confirmVisible ? [confirmDialog] : [];
      if (selector.includes('[role="menuitem"]')) return menuVisible ? [deleteAction] : [];
      if (selector.includes('[data-sidebar-item="true"]') && selector.includes('[role="button"]')) return deleted ? [] : [projectRow];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return [];
      return [];
    }
  };

  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const result = await manager.deleteProject(projectName);
  assert.equal(projectMenu.clicked, 1);
  assert.equal(deleteAction.clicked, 1);
  assert.equal(cancel.clicked, 0);
  assert.equal(confirm.clicked, 1);
  assert.equal(deleted, true);
  assert.deepEqual(result, { deleted: true, name: projectName });
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

test('setProjectInstructions uses the current Project title action bar More menu in the current ChatGPT UI', async () => {
  let menuVisible = false;
  let settingsVisible = false;
  let saved = false;
  const instructions = element({ tagName: 'TEXTAREA' });
  const save = element({ text: '保存', onClick: () => { saved = true; settingsVisible = false; } });
  const dialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [instructions, save] });
  const settings = element({ text: '项目设置', attrs: { role: 'menuitem' }, onClick: () => { menuVisible = false; settingsVisible = true; } });
  const share = element({ text: '分享', attrs: { 'aria-label': '分享' } });
  const more = element({ attrs: { 'aria-label': 'More' }, onClick: () => { menuVisible = true; } });
  const heading = element({ tagName: 'H1', text: 'test' });
  element({ tagName: 'DIV', children: [heading, share, more] });
  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return settingsVisible ? [dialog] : [];
      if (selector.includes('[role="menuitem"]')) return menuVisible ? [settings] : [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return menuVisible ? [share, more, settings] : [share, more];
      if (selector.includes('h1') || selector.includes('h2') || selector.includes('h3') || selector.includes('[role="heading"]')) return [heading];
      if (selector.includes('header') || selector.includes('[role="banner"]')) return [];
      return [];
    }
  };
  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const result = await manager.setProjectInstructions('完整规则', { projectName: 'test' });
  assert.equal(more.clicked, 1);
  assert.equal(settings.clicked, 1);
  assert.equal(instructions.value, '完整规则');
  assert.equal(save.clicked, 1);
  assert.equal(saved, true);
  assert.deepEqual(result, { saved: true });
});

test('deleteProject uses the owned sidebar Project row menu even when that Project is currently open', async () => {
  let menuVisible = false;
  let confirmVisible = false;
  let deleted = false;
  const projectName = 'test';
  const confirm = element({ text: '删除项目', onClick: () => { deleted = true; confirmVisible = false; } });
  const confirmDialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [confirm] });
  const deleteAction = element({ text: '删除项目', attrs: { role: 'menuitem' }, onClick: () => { menuVisible = false; confirmVisible = true; } });
  const sidebarMore = element({ attrs: { 'aria-label': `打开 ${projectName} 的项目选项` }, onClick: () => { menuVisible = true; } });
  const projectRow = element({ tagName: 'DIV', text: projectName, attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_project_' } });
  element({ tagName: 'DIV', children: [projectRow, sidebarMore] });

  // The current Project page also has its own heading and header More menu. Cleanup must
  // still target the exact owned sidebar row shown in the current ChatGPT UI.
  const headerMore = element({ attrs: { 'aria-label': 'More' } });
  const heading = element({ tagName: 'H1', text: projectName });
  element({ tagName: 'DIV', children: [heading, headerMore] });

  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return confirmVisible ? [confirmDialog] : [];
      if (selector.includes('[role="menuitem"]')) return menuVisible ? [deleteAction] : [];
      if (selector.includes('[data-sidebar-item="true"]') && selector.includes('[role="button"]')) return deleted ? [] : [projectRow];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return [];
      if (selector.includes('h1') || selector.includes('h2') || selector.includes('h3') || selector.includes('[role="heading"]')) return [heading];
      return [];
    }
  };
  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const result = await manager.deleteProject(projectName);
  assert.equal(sidebarMore.clicked, 1);
  assert.equal(headerMore.clicked, 0);
  assert.equal(deleteAction.clicked, 1);
  assert.equal(confirm.clicked, 1);
  assert.equal(deleted, true);
  assert.deepEqual(result, { deleted: true, name: projectName });
});

test('current ChatGPT DOM uses aria-label 新项目 even when the Projects header has other trailing actions', async () => {
  let dialogVisible = false;
  let created = false;
  const nameInput = element({ tagName: 'INPUT', attrs: { id: 'project-name', name: 'projectName', type: 'text' } });
  const createButton = element({ text: '创建项目', attrs: { type: 'submit' }, onClick: () => { created = true; dialogVisible = false; } });
  const dialog = element({ tagName: 'DIV', attrs: { role: 'dialog', 'data-testid': 'modal-new-project-enhanced' }, children: [nameInput, createButton] });
  const newProject = element({ attrs: { 'aria-label': '新项目', 'data-trailing-button': '' }, onClick: () => { dialogVisible = true; } });
  const organize = element({ attrs: { 'aria-label': '整理聊天', 'data-trailing-button': '' } });
  const collapse = element({ text: '项目', attrs: { 'aria-expanded': 'true' } });
  const projectsHeading = element({ tagName: 'H2', text: '项目' });
  const header = element({ tagName: 'DIV', children: [collapse, projectsHeading, newProject, organize] });
  const projectRow = element({ tagName: 'DIV', text: 'browserplguin2026081919', attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_project_' } });
  const rowMenu = element({ attrs: { 'aria-label': '打开 browserplguin2026081919 的项目选项' } });
  element({ tagName: 'DIV', children: [projectRow, rowMenu] });

  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialogVisible ? [dialog] : [];
      if (selector.includes('[data-sidebar-item="true"]') && selector.includes('[role="button"]')) return created ? [projectRow] : [];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [collapse, newProject, organize, rowMenu];
      if (selector.includes('h1') || selector.includes('h2') || selector.includes('h3') || selector.includes('div') || selector.includes('span')) return [projectsHeading, header];
      return [];
    }
  };

  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  const result = await manager.createProject({ projectName: 'browserplguin2026081919' });
  assert.equal(newProject.clicked, 1);
  assert.equal(nameInput.value, 'browserplguin2026081919');
  assert.equal(createButton.clicked, 1);
  assert.deepEqual(result, { name: 'browserplguin2026081919', href: null });
});

test('current ChatGPT sidebar Project rows are resolved from data-sidebar-item role=button entries', () => {
  const projectRow = element({ tagName: 'DIV', text: 'test2', attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_project_' } });
  const rowMenu = element({ attrs: { 'aria-label': '打开 test2 的项目选项' } });
  element({ tagName: 'DIV', children: [projectRow, rowMenu] });
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('[data-sidebar-item="true"]') && selector.includes('[role="button"]')) return [projectRow];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return [];
      return [];
    }
  };
  const manager = new ProjectManager(root);
  assert.deepEqual(manager.listVisibleProjects().map(({ name, href }) => ({ name, href })), [{ name: 'test2', href: null }]);
});

test('current ChatGPT Project header menu is identified by aria-label 显示项目详情', () => {
  const heading = element({ tagName: 'H1', text: 'test2' });
  const share = element({ attrs: { 'aria-label': '分享' } });
  const details = element({ attrs: { 'aria-label': '显示项目详情', 'aria-haspopup': 'menu' } });
  const row = element({ tagName: 'DIV', children: [heading, share, details] });
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('h1') || selector.includes('h2') || selector.includes('h3') || selector.includes('[role="heading"]')) return [heading];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [share, details];
      return [];
    }
  };
  const manager = new ProjectManager(root);
  assert.equal(manager.findProjectMenuNearHeading('test2'), details);
  assert.equal(row.children.length, 3);
});

test('current ChatGPT Project header details control wins over title and icon buttons', () => {
  const titleButton = element({ text: 'test2', attrs: { name: 'project-title', 'aria-label': '编辑“test2”的标题' } });
  const heading = element({ tagName: 'H1', text: 'test2', children: [titleButton] });
  const icon = element({ attrs: { 'aria-label': '打开项目图标和颜色菜单。所选图标：文件夹。', 'data-testid': 'project-modal-trigger' } });
  const share = element({ attrs: { 'aria-label': '分享' } });
  const details = element({ attrs: { 'aria-label': '显示项目详情', 'aria-haspopup': 'menu' } });
  element({ tagName: 'DIV', children: [icon, heading, share, details] });
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('h1') || selector.includes('h2') || selector.includes('h3') || selector.includes('[role="heading"]')) return [heading];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [titleButton, icon, share, details];
      return [];
    }
  };
  const manager = new ProjectManager(root);
  assert.equal(manager.findProjectMenuNearHeading('test2'), details);
});

test('current ChatGPT Project settings selects textarea aria-label 指令 when other editors exist', () => {
  const instructions = element({ tagName: 'TEXTAREA', attrs: { id: 'instructions', 'aria-label': '指令' } });
  const unrelated = element({ tagName: 'TEXTAREA', attrs: { 'aria-label': '备注' } });
  const dialog = element({ tagName: 'DIV', attrs: { role: 'dialog' }, children: [instructions, unrelated] });
  const manager = new ProjectManager(dialog);
  assert.equal(manager.findInstructionsEditor(dialog), instructions);
});

test('current ChatGPT createProject recognizes the native open dialog used by the live create-project modal', async () => {
  let dialogVisible = false;
  let created = false;
  const projectName = 'browserplguin2026081920';
  const nameInput = element({
    tagName: 'INPUT',
    attrs: { id: 'project-name', name: 'projectName', type: 'text', placeholder: '哥本哈根之旅' }
  });
  const createButton = element({
    text: '创建项目',
    attrs: { type: 'submit' },
    onClick: () => { created = true; dialogVisible = false; }
  });
  const openDialog = element({
    tagName: 'DIALOG',
    attrs: { open: '', 'aria-labelledby': 'dialog-title-create' },
    children: [nameInput, createButton]
  });
  const newProject = element({
    attrs: { 'aria-label': '新项目', 'data-trailing-button': '' },
    onClick: () => { dialogVisible = true; }
  });
  const projectRow = element({
    tagName: 'DIV',
    text: projectName,
    attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_project_native_dialog_' }
  });
  const rowMenu = element({ attrs: { 'aria-label': `打开 ${projectName} 的项目选项` } });
  element({ tagName: 'DIV', children: [projectRow, rowMenu] });

  const root = {
    querySelectorAll(selector) {
      // The live create-project modal is a native <dialog open> and has no role="dialog".
      if (selector === '[role="dialog"]') return [];
      if (selector === 'dialog[open]') return dialogVisible ? [openDialog] : [];
      if (selector.includes('[data-sidebar-item="true"]') && selector.includes('[role="button"]')) return created ? [projectRow] : [];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [newProject, rowMenu];
      return [];
    }
  };

  const manager = new ProjectManager(root, { sleep: async () => {}, pollMs: 1, timeoutMs: 5 });
  const result = await manager.createProject({ projectName });
  assert.equal(newProject.clicked, 1);
  assert.equal(nameInput.value, projectName);
  assert.equal(createButton.clicked, 1);
  assert.deepEqual(result, { name: projectName, href: null });
});

test('current ChatGPT createProject waits for the project-name input to become visible after the native dialog opens', async () => {
  let dialogVisible = false;
  let inputVisible = false;
  let created = false;
  const projectName = 'browserplguin2026081921';
  const nameInput = element({
    tagName: 'INPUT',
    attrs: { id: 'project-name', name: 'projectName', type: 'text', placeholder: '哥本哈根之旅' }
  });
  nameInput.getBoundingClientRect = () => inputVisible
    ? { width: 320, height: 36 }
    : { width: 0, height: 0 };
  const createButton = element({
    text: '创建项目',
    attrs: { type: 'submit' },
    onClick: () => { created = true; dialogVisible = false; }
  });
  const openDialog = element({
    tagName: 'DIALOG',
    attrs: { open: '', 'aria-labelledby': 'dialog-title-create' },
    children: [nameInput, createButton]
  });
  const newProject = element({
    attrs: { 'aria-label': '新项目', 'data-trailing-button': '' },
    onClick: () => { dialogVisible = true; }
  });
  const projectRow = element({
    tagName: 'DIV',
    text: projectName,
    attrs: { role: 'button', 'data-sidebar-item': 'true', 'aria-controls': '_r_project_delayed_input_' }
  });
  const rowMenu = element({ attrs: { 'aria-label': `打开 ${projectName} 的项目选项` } });
  element({ tagName: 'DIV', children: [projectRow, rowMenu] });

  const root = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return [];
      if (selector === 'dialog[open]') return dialogVisible ? [openDialog] : [];
      if (selector.includes('[data-sidebar-item="true"]') && selector.includes('[role="button"]')) return created ? [projectRow] : [];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [newProject, rowMenu];
      return [];
    }
  };

  const manager = new ProjectManager(root, {
    sleep: async () => { inputVisible = true; },
    pollMs: 1,
    timeoutMs: 5
  });
  const result = await manager.createProject({ projectName });
  assert.equal(nameInput.focused, 1);
  assert.equal(nameInput.value, projectName);
  assert.equal(createButton.clicked, 1);
  assert.deepEqual(result, { name: projectName, href: null });
});

test('current ChatGPT nested Project header skips the icon-color menu and reaches the outer project details control', () => {
  const titleButton = element({ text: 'browserplguin2026081921', attrs: { name: 'project-title', 'aria-label': '编辑“browserplguin2026081921”的标题' } });
  const heading = element({ tagName: 'H1', text: 'browserplguin2026081921', children: [titleButton] });
  const iconMenu = element({ attrs: {
    'aria-label': '打开项目图标和颜色菜单。所选图标：文件夹。所选图标颜色：默认颜色，浅色模式下为黑色，深色模式下为白色。',
    'data-testid': 'project-modal-trigger',
    'aria-haspopup': 'menu'
  } });
  const titleRow = element({ tagName: 'DIV', children: [iconMenu, heading] });
  const share = element({ attrs: { 'aria-label': '分享' } });
  const details = element({ attrs: { 'aria-label': '显示项目详情', 'aria-haspopup': 'menu' } });
  element({ tagName: 'DIV', children: [titleRow, share, details] });

  const root = {
    querySelectorAll(selector) {
      if (selector.includes('h1') || selector.includes('h2') || selector.includes('h3') || selector.includes('[role="heading"]')) return [heading];
      return [];
    }
  };

  const manager = new ProjectManager(root);
  assert.equal(manager.findProjectMenuNearHeading('browserplguin2026081921'), details);
});
