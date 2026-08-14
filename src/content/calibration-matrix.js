import { getActiveSelectorProfile, getActiveSelectorProfileMetadata } from '../shared/selector-registry.js';
import { classifyChatGptPageAccess } from './page-access-guard.js';
import { classifyComposerState } from './model-state-observer.js';
import { describeButton } from './selectors.js';
import { extractPatchCandidatesFromElement } from './artifact-observer.js';
import { isElementVisible, elementSemanticText } from './ui-semantics.js';
import { ConversationManager } from './conversation-manager.js';

export const CALIBRATION_CHECK_IDS = Object.freeze([
  'access',
  'composer',
  'model_state',
  'latest_assistant',
  'patch_candidates',
  'context_limit',
  'project_create',
  'project_settings',
  'project_delete',
  'resource_input'
]);

function result(id, status, evidence = {}) {
  return { id, status, evidence };
}

function visibleNodes(root, selector) {
  return [...(root?.querySelectorAll?.(selector) ?? [])].filter(isElementVisible);
}

function matchesAny(text, patterns) {
  return patterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function semanticMatches(root, selector, patterns) {
  return visibleNodes(root, selector).filter(node => matchesAny(elementSemanticText(node), patterns));
}

function uniqueStatus(id, count, evidence = {}) {
  if (count === 1) return result(id, 'pass', { ...evidence, candidate_count: 1 });
  if (count === 0) return result(id, 'unavailable', { ...evidence, candidate_count: 0 });
  return result(id, 'incompatible', { ...evidence, candidate_count: count });
}

function pageCategory(location, accessState) {
  if (accessState?.status === 'LOGIN_REQUIRED') return 'login';
  if (accessState?.status === 'CHALLENGE_REQUIRED') return 'challenge';
  const path = String(location?.pathname ?? '');
  if (/^\/(?:g|project)(?:\/|$)/i.test(path)) return 'project';
  if (/^\/c(?:\/|$)/i.test(path)) return 'chat';
  if (path === '' || path === '/') return 'home';
  return 'other';
}

function probeAccess(root, context) {
  const state = classifyChatGptPageAccess({ root, ...context });
  return {
    state,
    check: result('access', state.status === 'READY' ? 'pass' : 'unavailable', { access_status: state.status })
  };
}

function probeComposer(root, profile) {
  const editors = visibleNodes(root, profile.selectors.editor);
  return uniqueStatus('composer', editors.length);
}

function probeModelState(root, profile) {
  const buttons = visibleNodes(root, profile.selectors.composerButtons.join(',')).map(describeButton);
  const state = classifyComposerState(buttons);
  if (state === 'READY' || state === 'GENERATING') return result('model_state', 'pass', { state });
  return result('model_state', 'unavailable', { state: 'UNKNOWN' });
}

function latestAssistantElement(root) {
  const nodes = [...(root?.querySelectorAll?.('[data-message-author-role="assistant"]') ?? [])];
  return nodes.at(-1) ?? null;
}

function probeLatestAssistant(root) {
  const count = [...(root?.querySelectorAll?.('[data-message-author-role="assistant"]') ?? [])].length;
  return result('latest_assistant', count > 0 ? 'pass' : 'unavailable', { candidate_count: count });
}

function probePatchCandidates(root) {
  const latest = latestAssistantElement(root);
  if (!latest) return result('patch_candidates', 'unavailable', { candidate_count: 0 });
  const count = extractPatchCandidatesFromElement(latest).length;
  return result('patch_candidates', count > 0 ? 'pass' : 'unavailable', { candidate_count: count });
}

function probeContextLimit(root) {
  const detected = new ConversationManager(root).detectContextLengthLimit();
  return result('context_limit', detected ? 'pass' : 'unavailable', { detected: Boolean(detected) });
}

function probeProjectCreate(root, profile) {
  const matches = semanticMatches(root, profile.selectors.semanticButtons, profile.patterns.project.newProject);
  return uniqueStatus('project_create', matches.length);
}

function probeProjectSettings(root, profile, category) {
  const actions = semanticMatches(root, '[role="menuitem"], button, [role="button"]', profile.patterns.project.projectSettings);
  if (actions.length > 1) return result('project_settings', 'incompatible', { stage: 'settings_action', candidate_count: actions.length });
  if (actions.length === 1) return result('project_settings', 'pass', { stage: 'settings_action', candidate_count: 1 });
  if (category !== 'project') return result('project_settings', 'unavailable', { stage: 'project_page_required', candidate_count: 0 });

  const headers = visibleNodes(root, 'header, [role="banner"]');
  if (headers.length > 1) return result('project_settings', 'incompatible', { stage: 'header_scope', candidate_count: headers.length });
  const scope = headers[0] ?? root;
  const menus = [
    ...semanticMatches(scope, profile.selectors.semanticButtons, profile.patterns.project.projectMenu),
    ...semanticMatches(scope, profile.selectors.semanticButtons, profile.patterns.project.more)
  ];
  const unique = new Set(menus);
  return uniqueStatus('project_settings', unique.size, { stage: 'menu_entry' });
}

function visibleProjectAnchors(root) {
  return visibleNodes(root, 'a[href*="/g/"], a[href*="/project"]');
}

function findRowMenuCount(projectElement, profile) {
  let scope = projectElement?.parentElement ?? null;
  for (let depth = 0; scope && depth < 4; depth += 1, scope = scope.parentElement) {
    const menus = [
      ...semanticMatches(scope, profile.selectors.semanticButtons, profile.patterns.project.projectMenu),
      ...semanticMatches(scope, profile.selectors.semanticButtons, profile.patterns.project.more)
    ];
    const count = new Set(menus).size;
    if (count > 0) return count;
  }
  return 0;
}

function probeProjectDelete(root, profile) {
  const actions = semanticMatches(root, '[role="menuitem"], button, [role="button"]', profile.patterns.project.deleteProject);
  if (actions.length > 1) return result('project_delete', 'incompatible', { stage: 'delete_action', candidate_count: actions.length });
  if (actions.length === 1) return result('project_delete', 'pass', { stage: 'delete_action', candidate_count: 1 });

  const projects = visibleProjectAnchors(root);
  if (projects.length === 0) return result('project_delete', 'unavailable', { stage: 'project_row', candidate_count: 0 });
  let readyRows = 0;
  for (const project of projects) {
    const count = findRowMenuCount(project, profile);
    if (count > 1) return result('project_delete', 'incompatible', { stage: 'row_menu', candidate_count: count });
    if (count === 1) readyRows += 1;
  }
  return result('project_delete', readyRows > 0 ? 'pass' : 'unavailable', { stage: 'row_menu', candidate_count: readyRows });
}

function probeResourceInput(root, profile) {
  const count = [...(root?.querySelectorAll?.(profile.selectors.fileInputs.join(',')) ?? [])].length;
  return uniqueStatus('resource_input', count);
}

function safeProbe(id, probe) {
  try {
    return probe();
  } catch (error) {
    return result(id, 'incompatible', { error_code: error?.code ?? 'UNEXPECTED' });
  }
}

export function collectCalibrationMatrix(root = document, {
  location = globalThis.location,
  title = root?.title ?? ''
} = {}) {
  const profile = getActiveSelectorProfile();
  const { state: accessState, check: accessCheck } = probeAccess(root, { location, title });
  const category = pageCategory(location, accessState);
  const checks = [
    accessCheck,
    safeProbe('composer', () => probeComposer(root, profile)),
    safeProbe('model_state', () => probeModelState(root, profile)),
    safeProbe('latest_assistant', () => probeLatestAssistant(root)),
    safeProbe('patch_candidates', () => probePatchCandidates(root)),
    safeProbe('context_limit', () => probeContextLimit(root)),
    safeProbe('project_create', () => probeProjectCreate(root, profile)),
    safeProbe('project_settings', () => probeProjectSettings(root, profile, category)),
    safeProbe('project_delete', () => probeProjectDelete(root, profile)),
    safeProbe('resource_input', () => probeResourceInput(root, profile))
  ];
  const summary = { pass: 0, unavailable: 0, incompatible: 0 };
  for (const check of checks) summary[check.status] += 1;
  return {
    selector_profile: getActiveSelectorProfileMetadata(),
    page: { category, access_status: accessState.status },
    summary,
    checks
  };
}
