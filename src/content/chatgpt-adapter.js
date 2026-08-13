import { ProjectManager } from './project-manager.js';
import { ConversationManager } from './conversation-manager.js';
import { Composer } from './composer.js';
import { readComposerState } from './model-state-observer.js';

export class ChatGptAdapter {
  constructor({ root = document, projectManager, conversationManager, composer } = {}) {
    this.root = root;
    this.projects = projectManager ?? new ProjectManager(root);
    this.conversations = conversationManager ?? new ConversationManager(root);
    this.composer = composer ?? new Composer(root);
  }

  listProjects() { return this.projects.listVisibleProjects().map(({ name, href }) => ({ name, href })); }
  resolveProject(name) { return this.projects.resolveProject(name); }
  resolvePrimaryChat() { return this.conversations.resolvePrimaryChat(); }
  createProject(input) { return this.projects.createProject(input); }
  deleteProject(name) { return this.projects.deleteProject(name); }
  setProjectInstructions(text) { return this.projects.setProjectInstructions(text); }
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
