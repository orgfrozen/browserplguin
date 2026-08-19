import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { getActiveSelectorProfile } from '../shared/selector-registry.js';
import { elementSemanticText, findUniqueSemantic, isElementVisible, normalizeUiText } from './ui-semantics.js';

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

  listVisibleDialogs() {
    const nodes = [
      ...this.root.querySelectorAll(PROJECT_SELECTORS.dialogs),
      ...this.root.querySelectorAll('dialog[open]')
    ];
    return [...new Set(nodes)].filter(isElementVisible);
  }

  isCurrentSidebarProjectRow(node) {
    if (!node || !isElementVisible(node)) return false;
    const name = cleanName(node.textContent);
    if (!name) return false;
    for (let scope = node.parentElement, depth = 0; scope && depth < 3; scope = scope.parentElement, depth += 1) {
      const buttons = [...scope.querySelectorAll(PROJECT_SELECTORS.semanticButtons)].filter(isElementVisible);
      const projectMenus = buttons.filter(button => PROJECT_PATTERNS.projectMenu.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(elementSemanticText(button));
      }));
      if (projectMenus.length === 1) return true;
      if (projectMenus.length > 1) return false;
    }
    return false;
  }

  listVisibleProjects() {
    const sidebarRows = [...this.root.querySelectorAll('[data-sidebar-item="true"][role="button"][aria-controls]')]
      .filter(node => this.isCurrentSidebarProjectRow(node))
      .map(node => ({ name: cleanName(node.textContent), href: null, element: node }))
      .filter(x => x.name && isElementVisible(x.element));
    if (sidebarRows.length > 0) return sidebarRows;

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

  findNewProjectEntry({ required = true } = {}) {
    return findUniqueSemantic(
      this.root,
      PROJECT_SELECTORS.semanticButtons,
      PROJECT_PATTERNS.newProject,
      { required, label: 'New project entry' }
    );
  }

  findProjectSectionMarker() {
    const nodes = [...this.root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], div, span')].filter(isElementVisible);
    const matches = nodes.filter(node => {
      const text = normalizeUiText(node.textContent);
      return PROJECT_PATTERNS.projectSection.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(text);
      });
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => cleanName(a.textContent).length - cleanName(b.textContent).length);
    return matches[0];
  }

  revealProjectCreateControl(marker) {
    const eventTypes = ['pointerover', 'mouseover', 'mouseenter'];
    for (let scope = marker, depth = 0; scope && depth < 3; scope = scope.parentElement, depth += 1) {
      for (const type of eventTypes) {
        try {
          const EventCtor = globalThis.MouseEvent ?? globalThis.Event;
          scope.dispatchEvent?.(EventCtor ? new EventCtor(type, { bubbles: true }) : { type });
        } catch {
          scope.dispatchEvent?.({ type });
        }
      }
    }
  }

  findProjectSectionCreateControl(marker) {
    for (let scope = marker?.parentElement ?? null, depth = 0; scope && depth < 4; scope = scope.parentElement, depth += 1) {
      const buttons = [...scope.querySelectorAll(PROJECT_SELECTORS.semanticButtons)].filter(isElementVisible);
      if (buttons.length === 0 || buttons.length > 4) continue;

      const semanticCreate = buttons.filter(button => PROJECT_PATTERNS.newProject.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(elementSemanticText(button));
      }));
      if (semanticCreate.length === 1) return semanticCreate[0];
      if (semanticCreate.length > 1) {
        throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Projects header create action is ambiguous');
      }

      const nonMenuActions = buttons.filter(button => {
        const semantic = elementSemanticText(button);
        return ![...PROJECT_PATTERNS.projectMenu, ...PROJECT_PATTERNS.more].some(pattern => {
          pattern.lastIndex = 0;
          return pattern.test(semantic);
        });
      });
      if (nonMenuActions.length === 1) return nonMenuActions[0];
    }
    return null;
  }

  async resolveProjectCreateEntry() {
    const direct = this.findNewProjectEntry({ required: false });
    if (direct) return direct;
    const marker = this.findProjectSectionMarker();
    if (!marker) {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Projects section was not found while resolving the create action', { stage: 'project_section' });
    }

    const headerAction = this.findProjectSectionCreateControl(marker);
    if (headerAction) return headerAction;

    this.revealProjectCreateControl(marker);
    return this.waitFor(
      () => this.findNewProjectEntry({ required: false }) ?? this.findProjectSectionCreateControl(marker),
      { label: 'Projects header create action after revealing Projects section', timeoutMs: Math.min(this.timeoutMs, 2500) }
    );
  }

  async createProject({ projectName }) {
    if (!cleanName(projectName)) {
      throw new RunnerError(ERROR_CODES.PROJECT_CREATE_FAILED, 'Project name is required');
    }
    const entry = await this.resolveProjectCreateEntry();
    entry.click?.();

    const dialog = await this.waitFor(() => {
      const dialogs = this.listVisibleDialogs();
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

    const input = await this.waitFor(
      () => this.findProjectNameInput(dialog),
      { label: 'Project name input' }
    );
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

  findCurrentProjectHeading(projectName) {
    const expected = cleanName(projectName);
    if (!expected) return null;
    const headings = [...this.root.querySelectorAll('h1, h2, h3, [role="heading"]')].filter(isElementVisible);
    const exact = headings.filter(node => cleanName(node.textContent) === expected);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, `Current Project heading is ambiguous for ${expected}`);
    }
    return null;
  }

  findProjectMenuNearHeading(projectName) {
    const heading = this.findCurrentProjectHeading(projectName);
    if (!heading) return null;

    const scopes = [];
    for (let scope = heading.parentElement, depth = 0; scope && depth < 4; scope = scope.parentElement, depth += 1) {
      scopes.push(scope);
    }

    // Prefer the explicit Project details control across the whole title/header ancestry
    // before considering broader "project menu" fallbacks. In the live ChatGPT DOM the
    // closer project icon/color control also contains "项目...菜单" in its aria-label.
    for (const scope of scopes) {
      const buttons = [...scope.querySelectorAll(PROJECT_SELECTORS.semanticButtons)].filter(isElementVisible);
      const detailsMenus = buttons.filter(button => PROJECT_PATTERNS.projectDetails.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(elementSemanticText(button));
      }));
      if (detailsMenus.length === 1) return detailsMenus[0];
      if (detailsMenus.length > 1) {
        throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Current Project details menu is ambiguous');
      }
    }

    for (const scope of scopes) {
      const buttons = [...scope.querySelectorAll(PROJECT_SELECTORS.semanticButtons)].filter(isElementVisible);
      const semanticMenus = buttons.filter(button => [...PROJECT_PATTERNS.projectMenu, ...PROJECT_PATTERNS.more].some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(elementSemanticText(button));
      }));
      if (semanticMenus.length === 1) return semanticMenus[0];
      if (semanticMenus.length > 1) {
        throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Current Project header menu is ambiguous');
      }

      const nonShare = buttons.filter(button => !PROJECT_PATTERNS.share.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(elementSemanticText(button));
      }));
      if (nonShare.length === 1) return nonShare[0];
    }
    return null;
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
      const dialogs = this.listVisibleDialogs();
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

  findProjectMenuButton(projectName = null) {
    const current = this.findProjectMenuNearHeading(projectName);
    if (current) return current;
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

  async openProjectSettings(projectName = null) {
    const menuButton = this.findProjectMenuButton(projectName);
    menuButton.click?.();
    const settings = await this.waitFor(() => findUniqueSemantic(
      this.root,
      '[role="menuitem"], button, [role="button"]',
      PROJECT_PATTERNS.projectSettings,
      { required: false, label: 'Project settings action' }
    ), { label: 'Project settings action' });
    settings.click?.();
    return this.waitFor(() => {
      const dialogs = this.listVisibleDialogs();
      const matching = dialogs.filter(dialog => PROJECT_PATTERNS.projectSettings.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(normalizeUiText(dialog.textContent));
      }));
      if (matching.length === 1) return matching[0];
      if (matching.length > 1) throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project settings dialog is ambiguous');
      if (dialogs.length === 1) return dialogs[0];
      if (dialogs.length > 1) throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project settings dialog is ambiguous');
      return null;
    }, { label: 'Project settings dialog' });
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

  async setProjectInstructions(text, { projectName = null } = {}) {
    const dialog = await this.openProjectSettings(projectName);
    const editor = this.findInstructionsEditor(dialog);
    setControlValue(editor, text);
    const save = findUniqueSemantic(dialog, PROJECT_SELECTORS.semanticButtons, PROJECT_PATTERNS.save, { label: 'Project settings Save button' });
    save.click?.();

    await this.waitFor(() => {
      const visibleDialogs = this.listVisibleDialogs();
      return visibleDialogs.length === 0 ? true : null;
    }, { label: 'Project settings save completion' });
    return { saved: true };
  }
}
