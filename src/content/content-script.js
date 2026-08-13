import { ChatGptAdapter } from './chatgpt-adapter.js';
import { discoverNewPatches } from './artifact-observer.js';
import { collectErrorDomDiagnostics, collectUiDiagnostics } from './ui-semantics.js';
import { getActiveSelectorProfileMetadata } from '../shared/selector-registry.js';

export function installContentScript({ runtime = chrome.runtime, root = document, location = globalThis.location, title } = {}) {
  const titleProvider = () => title ?? root?.title ?? globalThis.document?.title ?? '';
  const adapter = new ChatGptAdapter({ root, location, titleProvider });
  const clickTargets = new Map();
  let nextClickToken = 1;

  function serializePatchCandidates(candidates) {
    return candidates.map(candidate => {
      const clickToken = `patch-click-${nextClickToken++}`;
      if (candidate.element) clickTargets.set(clickToken, candidate.element);
      return { filename: candidate.filename, url: candidate.url, clickToken };
    });
  }

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message.type?.startsWith?.('CHATGPT_') && !['CHATGPT_UI_DIAGNOSTICS', 'CHATGPT_ACCESS_STATE'].includes(message.type)) {
        adapter.assertPageAccessible();
      }
      switch (message.type) {
        case 'CHATGPT_UI_DIAGNOSTICS': return { selectorProfile: getActiveSelectorProfileMetadata(), controls: collectUiDiagnostics(root) };
        case 'CHATGPT_ACCESS_STATE': return adapter.getPageAccessState();
        case 'CHATGPT_LIST_PROJECTS': return adapter.listProjects();
        case 'CHATGPT_RESOLVE_PROJECT': return adapter.resolveProject(message.projectName);
        case 'CHATGPT_CREATE_PROJECT': return adapter.createProject({ projectName: message.projectName });
        case 'CHATGPT_SET_PROJECT_INSTRUCTIONS': return adapter.setProjectInstructions(message.text);
        case 'CHATGPT_DELETE_PROJECT': return adapter.deleteProject(message.projectName);
        case 'CHATGPT_OPEN_PROJECT': return adapter.projects.openProject(message.projectName);
        case 'CHATGPT_RESOLVE_CHAT': return adapter.resolvePrimaryChat();
        case 'CHATGPT_ATTACH_RESOURCE': return adapter.attachResource(message.resource);
        case 'CHATGPT_SEND_PROMPT': await adapter.sendPrompt(message.text); return { ok: true };
        case 'CHATGPT_STATE': return { state: adapter.getComposerState(), contextLimit: adapter.detectContextLengthLimit() };
        case 'CHATGPT_ROUND_SNAPSHOT': return adapter.getRoundSnapshot();
        case 'CHATGPT_LATEST_RESPONSE': {
          const snapshot = adapter.getLatestAssistantSnapshot();
          return { text: snapshot.text };
        }
        case 'CHATGPT_DISCOVER_PATCHES': {
          const snapshot = adapter.getLatestAssistantSnapshot();
          return serializePatchCandidates(discoverNewPatches(snapshot.element, new Set(message.downloadedKeys ?? []), message.sessionId));
        }
        case 'CHATGPT_CLICK_PATCH': {
          const target = clickTargets.get(message.clickToken);
          if (!target) return { ok: false, error: 'CLICK_TARGET_NOT_FOUND' };
          target.click();
          clickTargets.delete(message.clickToken);
          return { ok: true };
        }
        default: return { ok: false, error: 'UNKNOWN_COMMAND' };
      }
    })().then(sendResponse).catch(error => {
      let diagnostics = null;
      try {
        diagnostics = collectErrorDomDiagnostics(root, {
          location,
          title: titleProvider(),
          accessState: adapter.getPageAccessState(),
          selectorProfile: getActiveSelectorProfileMetadata(),
          errorCode: error.code ?? 'UNEXPECTED'
        });
      } catch {
        diagnostics = {
          error_code: error.code ?? 'UNEXPECTED',
          selector_profile: getActiveSelectorProfileMetadata(),
          access_state: null,
          page: { hostname: String(location?.hostname ?? '').toLowerCase(), pathname: '/', title_category: 'unknown' },
          control_count: 0,
          controls: []
        };
      }
      sendResponse({ ok: false, error: { code: error.code ?? 'UNEXPECTED', message: error.message, diagnostics } });
    });
    return true;
  });
}
