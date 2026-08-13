import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectName, buildProjectInstructions } from '../src/shared/project-naming.js';

test('project name uses project id and local yyyyMMddHH', () => {
  const date = new Date('2026-08-13T14:15:00+08:00');
  assert.equal(makeProjectName('vetatool', date, 1, 'Asia/Shanghai'), 'vetatool2026081314');
  assert.equal(makeProjectName('vetatool', date, 2, 'Asia/Shanghai'), 'vetatool2026081314-02');
});

test('project instructions establish session-local patch numbering', () => {
  const text = buildProjectInstructions({ sessionId: 'b81ac90277', projectConstraints: '不要无关重构' });
  assert.match(text, /b81ac90277/);
  assert.match(text, /001/);
  assert.match(text, /不要无关重构/);
  assert.match(text, /<TASK_STATUS>CONTINUE<\/TASK_STATUS>/);
  assert.match(text, /达到.*最大长度.*Task.*结束/);
  assert.match(text, /不做迁移/);
  assert.doesNotMatch(text, /新 Session/);
});

test('session id is a stable 12-character hex token derived from UUID', async () => {
  const { makeSessionId } = await import('../src/shared/project-naming.js');
  assert.equal(makeSessionId('b81ac902-77aa-4abc-8def-123456789000'), 'b81ac90277aa');
});

test('project collision selection increments same-hour suffix', async () => {
  const { makeAvailableProjectName } = await import('../src/shared/project-naming.js');
  const date = new Date('2026-08-13T15:10:00+08:00');
  const name = makeAvailableProjectName('vetatool', ['vetatool2026081315', 'vetatool2026081315-02'], date, 'Asia/Shanghai');
  assert.equal(name, 'vetatool2026081315-03');
});
