import { ProjectManager } from './project-manager.js';
import { ConversationManager } from './conversation-manager.js';
import { Composer } from './composer.js';
import { readComposerState } from './model-state-observer.js';
import { classifyChatGptPageAccess, assertChatGptPageAccessible } from './page-access-guard.js';

export class ChatGptAdapter {
  constructor({ root = document, projectManager, conversationManager, composer, location = globalThis.location, titleProvider } = {}) {
    this.root = root;
    this.location = location;
    this.titleProvider = titleProvider ?? (() => root?.title ?? globalThis.document?.title ?? '');
    this.projects = projectManager ?? new ProjectManager(root);
    this.conversations = conversationManager ?? new ConversationManager(root);
    this.composer = composer ?? new Composer(root);
  }

  getPageAccessState() { return classifyChatGptPageAccess({ root: this.root, location: this.location, title: this.titleProvider() }); }
  assertPageAccessible() { return assertChatGptPageAccessible({ root: this.root, location: this.location, title: this.titleProvider() }); }
  listProjects() { return this.projects.listVisibleProjects().map(({ name, href }) => ({ name, href })); }
  resolveProject(name) { return this.projects.resolveProject(name); }
  resolvePrimaryChat() { return this.conversations.resolvePrimaryChat(); }
  createProject(input) { return this.projects.createProject(input); }
  deleteProject(name) { return this.projects.deleteProject(name); }
  setProjectInstructions(text, options) { return this.projects.setProjectInstructions(text, options); }
  attachResource(resource) { return this.composer.attachResource(resource); }
  sendPrompt(text) { return this.composer.sendPrompt(text); }
  getLatestAssistantSnapshot() { return this.conversations.getLatestAssistantSnapshot(); }
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
