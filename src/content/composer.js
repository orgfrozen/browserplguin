import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { getActiveSelectorProfile } from '../shared/selector-registry.js';
import { findUniqueSemantic, elementSemanticText } from './ui-semantics.js';

const SELECTOR_PROFILE = getActiveSelectorProfile();
const COMPOSER_PATTERNS = SELECTOR_PROFILE.patterns.composer;
const COMPOSER_SELECTORS = SELECTOR_PROFILE.selectors;

function dispatchInput(element, text) {
  if (!element?.dispatchEvent) return;
  const InputCtor = globalThis.InputEvent;
  const EventCtor = globalThis.Event;
  if (InputCtor) {
    element.dispatchEvent(new InputCtor('input', { bubbles: true, inputType: 'insertText', data: text }));
  } else if (EventCtor) {
    element.dispatchEvent(new EventCtor('input', { bubbles: true }));
  } else {
    element.dispatchEvent({ type: 'input' });
  }
}

function dispatchChange(element) {
  if (!element?.dispatchEvent) return;
  const EventCtor = globalThis.Event;
  if (EventCtor) element.dispatchEvent(new EventCtor('change', { bubbles: true }));
  else element.dispatchEvent({ type: 'change' });
}

function decodeBase64(value) {
  const binary = atob(String(value ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fileInputs(container) {
  return [...(container?.querySelectorAll?.(COMPOSER_SELECTORS.fileInputs.join(',')) ?? [])];
}

export class Composer {
  constructor(root = document, {
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollMs = 250,
    timeoutMs = 30000,
    readyReadsRequired = 2,
    fileFactory = (bytes, filename, options) => new File([bytes], filename, options),
    dataTransferFactory = () => new DataTransfer()
  } = {}) {
    this.root = root;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.readyReadsRequired = readyReadsRequired;
    this.fileFactory = fileFactory;
    this.dataTransferFactory = dataTransferFactory;
  }

  findEditor() {
    const preferred = this.root.querySelector('#prompt-textarea[contenteditable="true"], [contenteditable="true"][role="textbox"]');
    if (preferred) return preferred;
    const editor = this.root.querySelector(COMPOSER_SELECTORS.editor);
    if (!editor) throw new RunnerError(ERROR_CODES.COMPOSER_NOT_FOUND, 'ChatGPT composer not found');
    return editor;
  }

  findComposerContainer() {
    const editor = this.findEditor();
    return editor.closest?.('form') ?? this.root;
  }

  findFileInput({ required = true } = {}) {
    const container = this.findComposerContainer();
    let inputs = fileInputs(container);
    if (inputs.length === 0 && container !== this.root) inputs = fileInputs(this.root);
    if (inputs.length === 1) return inputs[0];
    if (inputs.length === 0 && !required) return null;
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'ChatGPT resource file input was not uniquely identified', { matches: inputs.length });
  }

  findAttachmentMenuTrigger({ required = true } = {}) {
    const container = this.findComposerContainer();
    return findUniqueSemantic(
      container,
      COMPOSER_SELECTORS.semanticButtons,
      COMPOSER_PATTERNS.attachMenu,
      { required, label: 'ChatGPT composer attachment menu' }
    );
  }

  findUploadFileAction({ required = true } = {}) {
    return findUniqueSemantic(
      this.root,
      '[role="menuitem"], [role="menuitemradio"], button, [role="button"], label',
      COMPOSER_PATTERNS.uploadFile,
      { required, label: 'Add photos and files action' }
    );
  }

  findAssociatedFileInput(action) {
    const local = fileInputs(action);
    if (local.length === 1) return local[0];
    if (local.length > 1) {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Add photos and files action contains multiple file inputs', { matches: local.length });
    }
    const menu = action?.closest?.('[role="menu"], [role="listbox"], [data-radix-menu-content]') ?? null;
    const scoped = fileInputs(menu);
    if (scoped.length === 1) return scoped[0];
    if (scoped.length > 1) {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Attachment menu contains multiple file inputs', { matches: scoped.length });
    }
    return null;
  }

  async waitFor(read, label) {
    const attempts = Math.max(1, Math.ceil(this.timeoutMs / this.pollMs));
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
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

  async resolveResourceFileInput() {
    try {
      const direct = this.findFileInput({ required: false });
      if (direct) return direct;
    } catch (error) {
      if (error?.code !== ERROR_CODES.UI_SELECTOR_INCOMPATIBLE) throw error;
    }

    const trigger = this.findAttachmentMenuTrigger();
    trigger.click?.();
    const action = await this.waitFor(() => this.findUploadFileAction({ required: false }), 'Add photos and files action');
    const associated = this.findAssociatedFileInput(action);
    if (associated) return associated;

    return this.waitFor(() => {
      try { return this.findFileInput({ required: false }); }
      catch { return null; }
    }, 'ChatGPT resource file input after opening attachment menu');
  }

  #attachmentReady(filename) {
    const container = this.findComposerContainer();
    const name = String(filename).toLowerCase();
    const nodes = [...(container?.querySelectorAll?.(COMPOSER_SELECTORS.attachmentNodes) ?? [])];
    const matches = nodes.filter(node => elementSemanticText(node).includes(name));
    if (matches.length === 0) return false;
    const hasPendingText = matches.some(node => COMPOSER_PATTERNS.uploadPending.some(pattern => pattern.test(elementSemanticText(node))));
    if (hasPendingText) return false;
    if ((container?.querySelectorAll?.(COMPOSER_SELECTORS.progressBars) ?? []).length > 0) return false;
    return true;
  }

  async #waitForAttachmentReady(filename) {
    const maxPolls = Math.max(this.readyReadsRequired, Math.ceil(this.timeoutMs / this.pollMs));
    let readyReads = 0;
    for (let i = 0; i < maxPolls; i += 1) {
      if (this.#attachmentReady(filename)) {
        readyReads += 1;
        if (readyReads >= this.readyReadsRequired) return;
      } else {
        readyReads = 0;
      }
      await this.sleep(this.pollMs);
    }
    throw new RunnerError(ERROR_CODES.RESOURCE_UPLOAD_FAILED, 'ChatGPT resource attachment did not become ready before timeout', { filename });
  }

  async sendPrompt(text) {
    const editor = this.findEditor();
    editor.focus?.();
    if ('value' in editor) {
      let proto = Object.getPrototypeOf(editor);
      let descriptor = null;
      while (proto && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        proto = Object.getPrototypeOf(proto);
      }
      if (descriptor?.set) descriptor.set.call(editor, text);
      else editor.value = text;
    } else {
      editor.textContent = text;
    }
    dispatchInput(editor, text);

    const send = findUniqueSemantic(
      this.root,
      COMPOSER_SELECTORS.semanticButtons,
      COMPOSER_PATTERNS.send,
      { label: 'ChatGPT Send button' }
    );
    send.click?.();
  }

  async attachResource(resource) {
    if (!resource?.filename || !resource?.base64) {
      throw new RunnerError(ERROR_CODES.RESOURCE_UPLOAD_FAILED, 'Resource payload is missing filename or base64 data');
    }
    let bytes;
    try {
      bytes = decodeBase64(resource.base64);
    } catch (error) {
      throw new RunnerError(ERROR_CODES.RESOURCE_UPLOAD_FAILED, 'Resource payload base64 could not be decoded', { cause: error?.message });
    }
    if (resource.size != null && bytes.length !== resource.size) {
      throw new RunnerError(ERROR_CODES.RESOURCE_UPLOAD_FAILED, 'Resource payload size does not match decoded bytes', { expected: resource.size, actual: bytes.length });
    }

    const file = this.fileFactory(bytes, resource.filename, { type: resource.mimeType || 'application/octet-stream' });
    const transfer = this.dataTransferFactory();
    transfer.items.add(file);
    const input = await this.resolveResourceFileInput();
    input.files = transfer.files;
    dispatchChange(input);
    await this.#waitForAttachmentReady(resource.filename);
    return { attached: true, filename: resource.filename };
  }
}
