import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUiText, elementSemanticText, findUniqueSemantic, collectUiDiagnostics } from '../src/content/ui-semantics.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

function node({ tagName = 'BUTTON', text = '', attrs = {}, visible = true } = {}) {
  return {
    tagName,
    textContent: text,
    hidden: !visible,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return visible ? { width: 10, height: 10 } : { width: 0, height: 0 }; }
  };
}

function root(nodes) {
  return { querySelectorAll() { return nodes; } };
}

test('normalizes multilingual UI text and semantic attributes', () => {
  assert.equal(normalizeUiText('  新建\n 项目  '), '新建 项目');
  assert.match(elementSemanticText(node({ text: '新建项目', attrs: { 'aria-label': 'New project', title: '新規プロジェクト' } })), /new project/);
  assert.match(elementSemanticText(node({ text: '新建项目', attrs: { 'aria-label': 'New project', title: '新規プロジェクト' } })), /新建项目/);
});

test('finds one semantic candidate and ignores hidden controls', () => {
  const hidden = node({ text: 'New project', visible: false });
  const visible = node({ attrs: { 'aria-label': '新建项目' } });
  const found = findUniqueSemantic(root([hidden, visible]), 'button', [/^new project$/i, /^新建项目$/]);
  assert.equal(found, visible);
});

test('ambiguous semantic matches fail closed', () => {
  assert.throws(
    () => findUniqueSemantic(root([node({ text: 'New project' }), node({ text: '新建项目' })]), 'button', [/project|项目/i]),
    error => error instanceof RunnerError && error.code === ERROR_CODES.UI_SELECTOR_INCOMPATIBLE
  );
});

test('diagnostics exclude conversation text and keep only compact UI metadata', () => {
  const nodes = [
    node({ tagName: 'BUTTON', text: 'New project', attrs: { role: 'button', 'aria-label': 'New project', 'data-testid': 'new-project' } }),
    node({ tagName: 'DIV', text: 'private assistant response with secrets' })
  ];
  const result = collectUiDiagnostics(root(nodes));
  assert.equal(result.length, 1);
  assert.equal(result[0].tag, 'button');
  assert.equal(result[0].ariaLabel, 'New project');
  assert.equal(JSON.stringify(result).includes('private assistant response'), false);
});
