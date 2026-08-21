import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { getActiveSelectorProfile } from '../shared/selector-registry.js';
import { findUniqueSemantic, elementSemanticText } from './ui-semantics.js';

const SELECTOR_PROFILE = getActiveSelectorProfile();
const COMPOSER_PATTERNS = SELECTOR_PROFILE.patterns.composer;
const COMPOSER_SELECTORS = SELECTOR_PROFILE.selectors;

function compactFingerprint(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

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
    pollMs = 2000,
    timeoutMs = 30000,
    stallTimeoutMs = null,
    readyReadsRequired = 2,
    now = () => Date.now(),
    MutationObserverCtor = globalThis.MutationObserver,
    fileFactory = (bytes, filename, options) => new File([bytes], filename, options),
    dataTransferFactory = () => new DataTransfer()
  } = {}) {
    this.root = root;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.stallTimeoutMs = Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0
      ? stallTimeoutMs
      : 180000;
    this.readyReadsRequired = readyReadsRequired;
    this.now = now;
    this.MutationObserverCtor = MutationObserverCtor;
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

  #nowMs() {
    const value = this.now();
    if (value instanceof Date) return value.getTime();
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Date.now();
  }

  #composerTarget() {
    try { return this.findComposerContainer(); }
    catch { return this.root; }
  }

  async #waitForMutationOrPoll(target, pollMs) {
    const Observer = this.MutationObserverCtor;
    if (typeof Observer !== 'function' || !target) {
      await this.sleep(pollMs);
      return;
    }
    await new Promise(resolve => {
      let settled = false;
      let observer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { observer?.disconnect?.(); } catch {}
        resolve();
      };
      try {
        observer = new Observer(finish);
        observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch {
        observer = null;
      }
      Promise.resolve(this.sleep(pollMs)).then(finish, finish);
    });
  }

  async #waitForProgress(read, {
    label,
    fingerprint,
    target = this.#composerTarget(),
    pollMs = this.pollMs,
    stallTimeoutMs = this.stallTimeoutMs
  }) {
    const effectivePollMs = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : this.pollMs;
    const effectiveStallMs = Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0 ? stallTimeoutMs : this.stallTimeoutMs;
    let lastFingerprint = null;
    let lastProgressAt = this.#nowMs();
    let lastError = null;

    while (true) {
      try {
        const value = read();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }

      let currentFingerprint = null;
      try { currentFingerprint = String(fingerprint?.() ?? ''); } catch { currentFingerprint = 'fingerprint-error'; }
      const nowMs = this.#nowMs();
      if (lastFingerprint === null || currentFingerprint !== lastFingerprint) {
        lastFingerprint = currentFingerprint;
        lastProgressAt = nowMs;
      } else if (nowMs - lastProgressAt >= effectiveStallMs) {
        throw new RunnerError(ERROR_CODES.COMPOSER_STALLED, `${label} made no semantic progress before the local watchdog expired`, {
          stall_timeout_ms: effectiveStallMs,
          poll_ms: effectivePollMs,
          fingerprint: currentFingerprint,
          last_error: lastError ? { code: lastError.code ?? 'UNEXPECTED', message: lastError.message } : null
        });
      }

      await this.#waitForMutationOrPoll(target, effectivePollMs);
    }
  }

  #editorText(editor = this.findEditor()) {
    return String('value' in editor ? editor.value : editor.textContent ?? '').trim();
  }

  #sendCandidate() {
    return findUniqueSemantic(
      this.root,
      COMPOSER_SELECTORS.semanticButtons,
      COMPOSER_PATTERNS.send,
      { required: false, label: 'ChatGPT Send button' }
    );
  }

  #sendEnabled(candidate) {
    if (!candidate) return false;
    if (candidate.disabled === true) return false;
    if (String(candidate.getAttribute?.('aria-disabled') ?? '').toLowerCase() === 'true') return false;
    if (candidate.getAttribute?.('disabled') != null) return false;
    if (candidate.getAttribute?.('data-visually-disabled') != null) return false;
    return true;
  }

  #sendFingerprint(expectedText) {
    let candidate = null;
    let candidateState = 'missing';
    try {
      candidate = this.#sendCandidate();
      candidateState = candidate ? (this.#sendEnabled(candidate) ? 'enabled' : 'disabled') : 'missing';
    } catch {
      candidateState = 'ambiguous';
    }
    let editorState = 'missing';
    try {
      const text = this.#editorText();
      editorState = text === String(expectedText).trim() ? `prompt:${text.length}` : `other:${text.length}`;
    } catch {}
    const attachment = this.#attachmentSummary();
    return `${editorState}|send:${candidateState}|attachment:${attachment}`;
  }

  #attachmentSummary() {
    let container;
    try { container = this.findComposerContainer(); } catch { return 'composer-missing'; }
    const nodes = [...(container?.querySelectorAll?.(COMPOSER_SELECTORS.attachmentNodes) ?? [])];
    const progressCount = (container?.querySelectorAll?.(COMPOSER_SELECTORS.progressBars) ?? []).length;
    const semanticText = nodes.map(node => elementSemanticText(node));
    const pendingCount = semanticText.filter(text => COMPOSER_PATTERNS.uploadPending.some(pattern => pattern.test(text))).length;
    return `${nodes.length}:${pendingCount}:${progressCount}:${compactFingerprint(semanticText.join('|'))}`;
  }

  #attachmentState(filename) {
    const container = this.findComposerContainer();
    const name = String(filename).toLowerCase();
    const nodes = [...(container?.querySelectorAll?.(COMPOSER_SELECTORS.attachmentNodes) ?? [])];
    const matches = nodes.filter(node => elementSemanticText(node).includes(name));
    const pending = matches.some(node => COMPOSER_PATTERNS.uploadPending.some(pattern => pattern.test(elementSemanticText(node))));
    const progressCount = (container?.querySelectorAll?.(COMPOSER_SELECTORS.progressBars) ?? []).length;
    return {
      present: matches.length > 0,
      pending,
      progressCount,
      ready: matches.length > 0 && !pending && progressCount === 0,
      fingerprint: `${matches.length}:${pending ? 1 : 0}:${progressCount}:${compactFingerprint(matches.map(node => elementSemanticText(node)).join('|'))}`
    };
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

  async #waitForAttachmentReady(filename, options = {}) {
    let readyReads = 0;
    await this.#waitForProgress(() => {
      const state = this.#attachmentState(filename);
      if (state.ready) {
        readyReads += 1;
        if (readyReads >= this.readyReadsRequired) return true;
      } else {
        readyReads = 0;
      }
      return null;
    }, {
      label: `ChatGPT resource attachment ${filename}`,
      fingerprint: () => this.#attachmentState(filename).fingerprint,
      pollMs: options.pollMs,
      stallTimeoutMs: options.stallTimeoutMs
    });
  }

  async sendPrompt(text, options = {}) {
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

    const send = await this.#waitForProgress(() => {
      const candidate = this.#sendCandidate();
      return this.#sendEnabled(candidate) ? candidate : null;
    }, {
      label: 'ChatGPT Send button to become enabled',
      fingerprint: () => this.#sendFingerprint(text),
      pollMs: options.pollMs,
      stallTimeoutMs: options.stallTimeoutMs
    });
    send.click?.();
  }

  async attachResource(resource, options = {}) {
    if (!resource?.filename || !resource?.base64) {
      throw new RunnerError(ERROR_CODES.RESOURCE_UPLOAD_FAILED, 'Resource payload is missing filename or base64 data');
    }
    const existingAttachment = this.#attachmentState(resource.filename);
    if (existingAttachment.ready) return { attached: true, filename: resource.filename, reused: true };
    if (existingAttachment.present) {
      await this.#waitForAttachmentReady(resource.filename, options);
      return { attached: true, filename: resource.filename, reused: true };
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
    await this.#waitForAttachmentReady(resource.filename, options);
    return { attached: true, filename: resource.filename };
  }
}
