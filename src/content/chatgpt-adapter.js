import { ProjectManager } from './project-manager.js';
import { ConversationManager } from './conversation-manager.js';
import { Composer } from './composer.js';
import { readComposerState } from './model-state-observer.js';
import { classifyChatGptPageAccess, assertChatGptPageAccessible } from './page-access-guard.js';
import { ResponseRecovery } from './response-recovery.js';
import { InteractionPacing } from '../shared/interaction-pacing.js';

export class ChatGptAdapter {
  constructor({ root = document, projectManager, conversationManager, composer, responseRecovery, interactionPacing, location = globalThis.location, titleProvider } = {}) {
    this.root = root;
    this.location = location;
    this.titleProvider = titleProvider ?? (() => root?.title ?? globalThis.document?.title ?? '');
    this.interactionPacing = interactionPacing ?? new InteractionPacing({ baseMs: 0 });
    this.projects = projectManager ?? new ProjectManager(root, { interactionPacing: this.interactionPacing });
    this.conversations = conversationManager ?? new ConversationManager(root, { interactionPacing: this.interactionPacing });
    this.composer = composer ?? new Composer(root, { interactionPacing: this.interactionPacing });
    this.responseRecovery = responseRecovery ?? new ResponseRecovery(root, { interactionPacing: this.interactionPacing });
  }

  configureInteractionPacing(config = {}) { return this.interactionPacing.configure(config); }
  paceInteraction(action) { return this.interactionPacing.wait(action); }

  getPageAccessState() { return classifyChatGptPageAccess({ root: this.root, location: this.location, title: this.titleProvider() }); }
  assertPageAccessible() { return assertChatGptPageAccessible({ root: this.root, location: this.location, title: this.titleProvider() }); }
  listProjects() {
    const sidebarProjects = this.projects.listVisibleSidebarProjects?.() ?? [];
    const projects = sidebarProjects.length > 0 ? sidebarProjects : this.projects.listVisibleProjects();
    return projects.map(({ name, href }) => ({ name, href }));
  }
  resolveProject(name) { return this.projects.resolveProject(name); }
  resolvePrimaryChat() { return this.conversations.resolvePrimaryChat(); }
  prepareNewChat() { return this.conversations.prepareNewChat(); }
  currentConversationIdentity() { return this.conversations.currentConversationIdentity(this.location?.href); }
  deleteConversation(conversationId) { return this.conversations.deleteConversationById(conversationId); }
  createProject(input) { return this.projects.createProject(input); }
  deleteProject(name) { return this.projects.deleteProject(name); }
  setProjectInstructions(text, options) { return this.projects.setProjectInstructions(text, options); }
  attachResource(resource, options = {}) { return this.composer.attachResource(resource, options); }
  sendPrompt(text, options = {}) { return this.composer.sendPrompt(text, options); }
  getLatestAssistantSnapshot() { return this.conversations.getLatestAssistantSnapshot(); }
  getResponseFailureState() { return this.responseRecovery.getFailureState(); }
  retryLatestResponse() { return this.responseRecovery.retryLatestResponse(); }
  getRoundSnapshot() {
    return {
      ...this.conversations.getRoundSnapshot(),
      state: this.getComposerState(),
      contextLimit: this.detectContextLengthLimit()
    };
  }
  detectContextLengthLimit() { return this.conversations.detectContextLengthLimit(); }
  getComposerState() { return readComposerState(this.root); }
}
