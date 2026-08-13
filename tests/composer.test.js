import test from 'node:test';
import assert from 'node:assert/strict';
import { Composer } from '../src/content/composer.js';

function editor({ contenteditable = false } = {}) {
  return {
    tagName: contenteditable ? 'DIV' : 'TEXTAREA',
    value: '',
    textContent: '',
    focused: 0,
    events: [],
    focus() { this.focused += 1; },
    getAttribute(name) {
      if (name === 'contenteditable') return contenteditable ? 'true' : null;
      return null;
    },
    dispatchEvent(event) { this.events.push(event?.type ?? 'unknown'); return true; }
  };
}

function button(attrs = {}) {
  return {
    clicked: 0,
    textContent: attrs.text ?? '',
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { width: 10, height: 10 }; },
    click() { this.clicked += 1; }
  };
}

test('sendPrompt recognizes send button from data-testid and dispatches input', async () => {
  const input = editor();
  const send = button({ 'data-testid': 'send-button' });
  const root = {
    querySelector() { return input; },
    querySelectorAll() { return [send]; }
  };
  await new Composer(root).sendPrompt('修复 sitemap bug');
  assert.equal(input.value, '修复 sitemap bug');
  assert.ok(input.events.includes('input'));
  assert.equal(send.clicked, 1);
});

test('sendPrompt supports contenteditable composer', async () => {
  const input = editor({ contenteditable: true });
  delete input.value;
  const send = button({ 'aria-label': 'Send prompt' });
  const root = {
    querySelector() { return input; },
    querySelectorAll() { return [send]; }
  };
  await new Composer(root).sendPrompt('继续');
  assert.equal(input.textContent, '继续');
  assert.equal(send.clicked, 1);
});
