import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { findUniqueSemantic } from './ui-semantics.js';

const SEND_PATTERNS = [
  /\bsend(?: prompt)?\b/i,
  /send-button/i,
  /发送|傳送/i,
  /送信/i,
  /submit/i
];

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

export class Composer {
  constructor(root = document) { this.root = root; }

  findEditor() {
    const editor = this.root.querySelector('textarea, [contenteditable="true"]');
    if (!editor) throw new RunnerError(ERROR_CODES.COMPOSER_NOT_FOUND, 'ChatGPT composer not found');
    return editor;
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
      'button, [role="button"]',
      SEND_PATTERNS,
      { label: 'ChatGPT Send button' }
    );
    send.click?.();
  }

  async attachResource() {
    throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Resource attachment requires controlled real-page validation');
  }
}
