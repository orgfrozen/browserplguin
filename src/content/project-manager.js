import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { getActiveSelectorProfile } from '../shared/selector-registry.js';
import { findUniqueSemantic, isElementVisible, normalizeUiText } from './ui-semantics.js';

const SELECTOR_PROFILE = getActiveSelectorProfile();
const PROJECT_PATTERNS = SELECTOR_PROFILE.patterns.project;
const PROJECT_SELECTORS = SELECTOR_PROFILE.selectors;

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function setControlValue(element, value) {
  element.focus?.();
  if ('value' in element) {
    let proto = Object.getPrototypeOf(element);
    let descriptor = null;
    while (proto && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      proto = Object.getPrototypeOf(proto);
    }
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  } else {
    element.textContent = value;
  }
  const EventCtor = globalThis.InputEvent ?? globalThis.Event;
  if (EventCtor && element.dispatchEvent) {
    try {
      element.dispatchEvent(new EventCtor('input', { bubbles: true, inputType: 'insertText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      element.dispatchEvent({ type: 'input' });
    }
  }
}

export function chooseExactProjectCandidate(candidates, expectedName) {
  const expected = cleanName(expectedName);
  const exact = candidates.filter(candidate => cleanName(candidate.name) === expected);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, `Multiple exact ChatGPT Projects named ${expected}`, { candidates: exact });
  }
  throw new RunnerError(ERROR_CODES.PROJECT_NOT_FOUND, `ChatGPT Project not found: ${expected}`, {
    visibleNames: candidates.map(x => cleanName(x.name)).filter(Boolean)
  });
}

export class ProjectManager {
  constructor(root = document, {
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollMs = 200,
    timeoutMs = 8000
  } = {}) {
    this.root = root;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
  }

  async waitFor(read, { label = 'ChatGPT UI', timeoutMs = this.timeoutMs } = {}) {
    const attempts = Math.max(1, Math.ceil(timeoutMs / this.pollMs));
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const value = read();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await this.sleep(this.pollMs);
    }
    if (lastError) throw lastError;
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, `${label} did not appear before timeout`);
  }

  listVisibleProjects() {
    const nodes = [...this.root.querySelectorAll(PROJECT_SELECTORS.projectAnchors)];
    return nodes.map(node => ({
      name: cleanName(node.textContent),
      href: node.getAttribute?.('href') ?? null,
      element: node
    })).filter(x => x.name && x.href && isElementVisible(x.element));
  }

  resolveProject(projectName) {
    return chooseExactProjectCandidate(this.listVisibleProjects(), projectName);
  }

  async openProject(projectName) {
    const candidate = this.resolveProject(projectName);
    candidate.element?.click?.();
    return { name: candidate.name, href: candidate.href };
  }

  findProjectNameInput(dialog) {
    const inputs = [...dialog.querySelectorAll('input, textarea')].filter(isElementVisible);
    const semantic = inputs.filter(input => {
      const value = normalizeUiText([
        input.getAttribute?.('aria-label'),
        input.getAttribute?.('placeholder'),
        input.getAttribute?.('name')
      ].filter(Boolean).join(' '));
      return PROJECT_PATTERNS.projectName.some(pattern => pattern.test(value));
    });
    if (semantic.length === 1) return semantic[0];
    if (semantic.length > 1) {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project name input is ambiguous');
    }
    const textInputs = inputs.filter(input => !input.getAttribute?.('type') || /^(?:text|search)$/i.test(input.getAttribute('type')));
    if (textInputs.length === 1) return textInputs[0];
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project name input was not found uniquely');
  }

  async createProject({ projectName }) {
    if (!cleanName(projectName)) {
      throw new RunnerError(ERROR_CODES.PROJECT_CREATE_FAILED, 'Project name is required');
    }
    const entry = findUniqueSemantic(
      this.root,
      PROJECT_SELECTORS.semanticButtons,
      PROJECT_PATTERNS.newProject,
      { label: 'New project entry' }
    );
    entry.click?.();

    const dialog = await this.waitFor(() => {
      const dialogs = [...this.root.querySelectorAll(PROJECT_SELECTORS.dialogs)].filter(isElementVisible);
      if (dialogs.length === 1) return dialogs[0];
      if (dialogs.length > 1) {
        const matching = dialogs.filter(item => {
          const text = cleanName(item.textContent).toLowerCase();
          return /project|项目|プロジェクト/.test(text);
        });
        if (matching.length === 1) return matching[0];
        throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project creation dialog is ambiguous');
      }
      return null;
    }, { label: 'Project creation dialog' });

    const input = this.findProjectNameInput(dialog);
    setControlValue(input, projectName);
    const create = findUniqueSemantic(
      dialog,
      PROJECT_SELECTORS.semanticButtons,
      PROJECT_PATTERNS.createProject,
      { label: 'Create project confirmation' }
    );
    create.click?.();

    const candidate = await this.waitFor(() => {
      try { return this.resolveProject(projectName); }
      catch (error) {
        if (error.code === ERROR_CODES.PROJECT_NOT_FOUND) return null;
        throw error;
      }
    }, { label: `Created Project ${projectName}` });
    return { name: candidate.name, href: candidate.href };
  }

  findNearbyProjectMenu(projectElement) {
    let scope = projectElement?.parentElement ?? null;
    for (let depth = 0; scope && depth < 4; depth += 1, scope = scope.parentElement) {
      const buttons = [...scope.querySelectorAll(PROJECT_SELECTORS.semanticButtons)].filter(isElementVisible);
      const semantic = buttons.filter(button => PROJECT_PATTERNS.projectMenu.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(normalizeUiText([
          button.getAttribute?.('aria-label'),
          button.getAttribute?.('title'),
          button.textContent
        ].filter(Boolean).join(' ')));
      }));
      if (semantic.length === 1) return semantic[0];
      if (semantic.length > 1) throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Owned Project menu is ambiguous');

      const more = buttons.filter(button => PROJECT_PATTERNS.more.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(normalizeUiText([
          button.getAttribute?.('aria-label'),
          button.getAttribute?.('title'),
          button.textContent
        ].filter(Boolean).join(' ')));
      }));
      if (more.length === 1) return more[0];
      if (more.length > 1) throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Owned Project More menu is ambiguous');
      if (buttons.length === 1) return buttons[0];
    }
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Owned Project menu was not found near the exact Project link');
  }

  async deleteProject(projectName) {
    const candidate = this.resolveProject(projectName);
    const menuButton = this.findNearbyProjectMenu(candidate.element);
    menuButton.click?.();

    const deleteAction = await this.waitFor(() => findUniqueSemantic(
      this.root,
      '[role="menuitem"], button, [role="button"]',
      PROJECT_PATTERNS.deleteProject,
      { required: false, label: 'Delete project action' }
    ), { label: 'Delete project action' });
    deleteAction.click?.();

    const dialog = await this.waitFor(() => {
      const dialogs = [...this.root.querySelectorAll(PROJECT_SELECTORS.dialogs)].filter(isElementVisible);
      if (dialogs.length === 1) return dialogs[0];
      if (dialogs.length > 1) throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Delete Project confirmation dialog is ambiguous');
      return null;
    }, { label: 'Delete Project confirmation dialog' });

    const confirm = findUniqueSemantic(dialog, PROJECT_SELECTORS.semanticButtons, PROJECT_PATTERNS.confirmDelete, { label: 'Delete Project confirmation' });
    confirm.click?.();

    await this.waitFor(() => {
      const remains = this.listVisibleProjects().some(project => cleanName(project.name) === cleanName(projectName));
      return remains ? null : true;
    }, { label: `Project deletion ${projectName}` });
    return { deleted: true, name: projectName };
  }

  findProjectMenuButton() {
    const headers = [...this.root.querySelectorAll('header, [role="banner"]')].filter(isElementVisible);
    if (headers.length === 1) {
      const scopedProjectMenu = findUniqueSemantic(
        headers[0],
        PROJECT_SELECTORS.semanticButtons,
        PROJECT_PATTERNS.projectMenu,
        { required: false, label: 'Project header options menu' }
      );
      if (scopedProjectMenu) return scopedProjectMenu;
      const more = findUniqueSemantic(headers[0], PROJECT_SELECTORS.semanticButtons, PROJECT_PATTERNS.more, { required: false, label: 'Project header more menu' });
      if (more) return more;
    } else if (headers.length > 1) {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project header/banner scope is ambiguous');
    }

    const direct = findUniqueSemantic(
      this.root,
      PROJECT_SELECTORS.semanticButtons,
      PROJECT_PATTERNS.projectMenu,
      { required: false, label: 'Project options menu' }
    );
    if (direct) return direct;
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project options menu was not found uniquely');
  }

  findInstructionsEditor(dialog) {
    const candidates = [...dialog.querySelectorAll('textarea, [contenteditable="true"]')].filter(node => {
      if (!isElementVisible(node)) return false;
      const tag = String(node.tagName ?? '').toLowerCase();
      return tag === 'textarea' || node.getAttribute?.('contenteditable') === 'true';
    });
    const semantic = candidates.filter(node => {
      const label = normalizeUiText([
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('placeholder'),
        node.getAttribute?.('name')
      ].filter(Boolean).join(' '));
      return PROJECT_PATTERNS.projectInstructions.some(pattern => pattern.test(label));
    });
    if (semantic.length === 1) return semantic[0];
    if (semantic.length > 1) throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project instructions editor is ambiguous');
    if (candidates.length === 1) return candidates[0];
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project instructions editor was not found uniquely');
  }

  async setProjectInstructions(text) {
    const menuButton = this.findProjectMenuButton();
    menuButton.click?.();

    const settings = await this.waitFor(() => findUniqueSemantic(
      this.root,
      '[role="menuitem"], button, [role="button"]',
      PROJECT_PATTERNS.projectSettings,
      { required: false, label: 'Project settings action' }
    ), { label: 'Project settings action' });
    settings.click?.();

    const dialog = await this.waitFor(() => {
      const dialogs = [...this.root.querySelectorAll(PROJECT_SELECTORS.dialogs)].filter(isElementVisible);
      if (dialogs.length === 1) return dialogs[0];
      if (dialogs.length > 1) throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project settings dialog is ambiguous');
      return null;
    }, { label: 'Project settings dialog' });

    const editor = this.findInstructionsEditor(dialog);
    setControlValue(editor, text);
    const save = findUniqueSemantic(dialog, PROJECT_SELECTORS.semanticButtons, PROJECT_PATTERNS.save, { label: 'Project settings Save button' });
    save.click?.();

    await this.waitFor(() => {
      const visibleDialogs = [...this.root.querySelectorAll(PROJECT_SELECTORS.dialogs)].filter(isElementVisible);
      return visibleDialogs.length === 0 ? true : null;
    }, { label: 'Project settings save completion' });
    return { saved: true };
  }
}
