import { getActiveSelectorProfile, getActiveSelectorProfileMetadata } from '../shared/selector-registry.js';
import { classifyChatGptPageAccess } from './page-access-guard.js';
import { classifyComposerState } from './model-state-observer.js';
import { describeButton } from './selectors.js';
import { extractPatchCandidatesFromElement } from './artifact-observer.js';
import { isElementVisible, elementSemanticText, buildSafeCalibrationFingerprint } from './ui-semantics.js';
import { ConversationManager } from './conversation-manager.js';
import { ProjectManager } from './project-manager.js';
import { Composer } from './composer.js';

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
  'resource_input',
  'new_chat',
  'conversation_delete'
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

function safeFingerprints(nodes, limit = 3) {
  const result = [];
  const seen = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || result.length >= limit) break;
    try {
      const fingerprint = buildSafeCalibrationFingerprint(node);
      const key = JSON.stringify(fingerprint);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(fingerprint);
    } catch {
      // Fingerprinting is diagnostic-only and must never change calibration status.
    }
  }
  return result;
}

function uniqueStatus(id, count, evidence = {}, nodes = []) {
  const withFingerprints = { ...evidence, candidate_count: count, fingerprints: safeFingerprints(nodes) };
  if (count === 1) return result(id, 'pass', withFingerprints);
  if (count === 0) return result(id, 'unavailable', withFingerprints);
  return result(id, 'incompatible', withFingerprints);
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
  return uniqueStatus('composer', editors.length, {}, editors);
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
  const candidates = extractPatchCandidatesFromElement(latest);
  const nearby = candidates.length > 0 ? candidates.map(candidate => candidate.element) : [...(latest.querySelectorAll?.('a[href], button') ?? [])];
  const count = candidates.length;
  return result('patch_candidates', count > 0 ? 'pass' : 'unavailable', { candidate_count: count, fingerprints: safeFingerprints(nearby) });
}

function probeContextLimit(root) {
  const detected = new ConversationManager(root).detectContextLengthLimit();
  const nearby = visibleNodes(root, '[role="alert"], [role="status"], [role="dialog"]');
  return result('context_limit', detected ? 'pass' : 'unavailable', { detected: Boolean(detected), fingerprints: safeFingerprints(nearby) });
}

function probeNewChat(root, profile) {
  const matches = semanticMatches(root, profile.selectors.conversationControls, profile.patterns.conversation.newChat);
  return uniqueStatus('new_chat', matches.length, { stage: 'semantic_action' }, matches);
}

function probeConversationDelete(root) {
  const specificPatterns = [
    /delete (?:chat|conversation)/i,
    /删除(?:聊天|对话)/,
    /刪除(?:聊天|對話)/,
    /(?:チャット|会話)(?:を)?削除/i
  ];
  const actions = semanticMatches(root, '[role="menuitem"], button, [role="button"]', specificPatterns);
  if (actions.length > 1) return result('conversation_delete', 'incompatible', { stage: 'delete_action', candidate_count: actions.length, fingerprints: safeFingerprints(actions) });
  if (actions.length === 1) return result('conversation_delete', 'pass', { stage: 'delete_action', candidate_count: 1, fingerprints: safeFingerprints(actions) });
  const anchors = visibleNodes(root, 'a[href*="/c/"]');
  return result('conversation_delete', 'unavailable', { stage: 'delete_action', candidate_count: 0, conversation_row_count: anchors.length, fingerprints: safeFingerprints(anchors) });
}

function probeProjectCreate(root, profile) {
  const matches = semanticMatches(root, profile.selectors.semanticButtons, profile.patterns.project.newProject);
  if (matches.length > 0) {
    return uniqueStatus('project_create', matches.length, { stage: 'semantic_action' }, matches);
  }

  const manager = new ProjectManager(root);
  const marker = manager.findProjectSectionMarker();
  const headerAction = marker ? manager.findProjectSectionCreateControl(marker) : null;
  if (headerAction) {
    return uniqueStatus('project_create', 1, { stage: 'projects_header_action' }, [headerAction]);
  }
  return result('project_create', 'unavailable', { stage: marker ? 'projects_header_action' : 'project_section', candidate_count: 0, fingerprints: [] });
}

function probeProjectSettings(root, profile, category) {
  const actions = semanticMatches(root, '[role="menuitem"], button, [role="button"]', profile.patterns.project.projectSettings);
  if (actions.length > 1) return result('project_settings', 'incompatible', { stage: 'settings_action', candidate_count: actions.length, fingerprints: safeFingerprints(actions) });
  if (actions.length === 1) return result('project_settings', 'pass', { stage: 'settings_action', candidate_count: 1, fingerprints: safeFingerprints(actions) });
  if (category !== 'project') return result('project_settings', 'unavailable', { stage: 'project_page_required', candidate_count: 0, fingerprints: [] });

  const headers = visibleNodes(root, 'header, [role="banner"]');
  if (headers.length > 1) return result('project_settings', 'incompatible', { stage: 'header_scope', candidate_count: headers.length, fingerprints: safeFingerprints(headers) });
  const scope = headers[0] ?? root;
  const menus = [
    ...semanticMatches(scope, profile.selectors.semanticButtons, profile.patterns.project.projectMenu),
    ...semanticMatches(scope, profile.selectors.semanticButtons, profile.patterns.project.more)
  ];
  const unique = new Set(menus);
  return uniqueStatus('project_settings', unique.size, { stage: 'menu_entry' }, [...unique]);
}

function visibleProjectAnchors(root) {
  return visibleNodes(root, 'a[href*="/g/"], a[href*="/project"]');
}

function findRowMenus(projectElement, profile) {
  let scope = projectElement?.parentElement ?? null;
  for (let depth = 0; scope && depth < 4; depth += 1, scope = scope.parentElement) {
    const menus = [
      ...semanticMatches(scope, profile.selectors.semanticButtons, profile.patterns.project.projectMenu),
      ...semanticMatches(scope, profile.selectors.semanticButtons, profile.patterns.project.more)
    ];
    const unique = [...new Set(menus)];
    if (unique.length > 0) return unique;
  }
  return [];
}

function probeProjectDelete(root, profile) {
  const actions = semanticMatches(root, '[role="menuitem"], button, [role="button"]', profile.patterns.project.deleteProject);
  if (actions.length > 1) return result('project_delete', 'incompatible', { stage: 'delete_action', candidate_count: actions.length, fingerprints: safeFingerprints(actions) });
  if (actions.length === 1) return result('project_delete', 'pass', { stage: 'delete_action', candidate_count: 1, fingerprints: safeFingerprints(actions) });

  const projects = visibleProjectAnchors(root);
  if (projects.length === 0) return result('project_delete', 'unavailable', { stage: 'project_row', candidate_count: 0, fingerprints: [] });
  let readyRows = 0;
  const readyMenus = [];
  for (const project of projects) {
    const menus = findRowMenus(project, profile);
    if (menus.length > 1) return result('project_delete', 'incompatible', { stage: 'row_menu', candidate_count: menus.length, fingerprints: safeFingerprints(menus) });
    if (menus.length === 1) {
      readyRows += 1;
      readyMenus.push(menus[0]);
    }
  }
  return result('project_delete', readyRows > 0 ? 'pass' : 'unavailable', { stage: 'row_menu', candidate_count: readyRows, fingerprints: safeFingerprints(readyMenus) });
}

function probeResourceInput(root, profile) {
  const editors = visibleNodes(root, profile.selectors.editor);
  const composerScope = editors.length === 1 && typeof editors[0]?.closest === 'function'
    ? (editors[0].closest('form') ?? root)
    : root;
  let inputs = [...(composerScope?.querySelectorAll?.(profile.selectors.fileInputs.join(',')) ?? [])];
  if (inputs.length === 0 && composerScope !== root) {
    inputs = [...(root?.querySelectorAll?.(profile.selectors.fileInputs.join(',')) ?? [])];
  }
  if (inputs.length === 1) return uniqueStatus('resource_input', 1, { stage: 'file_input' }, inputs);
  if (inputs.length > 1) return uniqueStatus('resource_input', inputs.length, { stage: 'file_input' }, inputs);
  if (editors.length !== 1) return result('resource_input', 'unavailable', { stage: 'composer_scope', candidate_count: 0, fingerprints: [] });
  const trigger = new Composer(root).findAttachmentMenuTrigger({ required: false });
  if (trigger) return uniqueStatus('resource_input', 1, { stage: 'attachment_menu' }, [trigger]);
  return result('resource_input', 'unavailable', { stage: 'attachment_menu', candidate_count: 0, fingerprints: [] });
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
    safeProbe('new_chat', () => probeNewChat(root, profile)),
    safeProbe('project_create', () => probeProjectCreate(root, profile)),
    safeProbe('project_settings', () => probeProjectSettings(root, profile, category)),
    safeProbe('project_delete', () => probeProjectDelete(root, profile)),
    safeProbe('resource_input', () => probeResourceInput(root, profile)),
    safeProbe('conversation_delete', () => probeConversationDelete(root))
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
