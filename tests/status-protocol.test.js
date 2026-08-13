import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskStatus, decideTaskAction } from '../src/shared/status-protocol.js';

test('parses machine task status markers', () => {
  assert.equal(parseTaskStatus('x <TASK_STATUS>CONTINUE</TASK_STATUS>'), 'CONTINUE');
  assert.equal(parseTaskStatus('<TASK_STATUS>DONE</TASK_STATUS>'), 'DONE');
  assert.equal(parseTaskStatus('<TASK_STATUS>BLOCKED</TASK_STATUS>'), 'BLOCKED');
  assert.equal(parseTaskStatus('no marker'), null);
});

test('normal task can complete regardless of patch count', () => {
  assert.equal(decideTaskAction({ status: 'DONE', taskPatchCount: 0, patchGoal: null, fallbackCount: 0, fallbackLimit: 2 }), 'COMPLETE');
  assert.equal(decideTaskAction({ status: 'DONE', taskPatchCount: 1, patchGoal: null, fallbackCount: 0, fallbackLimit: 2 }), 'COMPLETE');
});

test('patch-goal task continues when model says done before minimum', () => {
  assert.equal(decideTaskAction({ status: 'DONE', taskPatchCount: 2, patchGoal: { minimum: 3 }, fallbackCount: 0, fallbackLimit: 2 }), 'CONTINUE');
});

test('patch-goal task completes when minimum is met', () => {
  assert.equal(decideTaskAction({ status: 'DONE', taskPatchCount: 3, patchGoal: { minimum: 3 }, fallbackCount: 0, fallbackLimit: 2 }), 'COMPLETE');
});

test('blocked task stops and missing protocol is bounded', () => {
  assert.equal(decideTaskAction({ status: 'BLOCKED', taskPatchCount: 0, patchGoal: null, fallbackCount: 0, fallbackLimit: 2 }), 'BLOCK');
  assert.equal(decideTaskAction({ status: null, taskPatchCount: 0, patchGoal: null, fallbackCount: 0, fallbackLimit: 2 }), 'CONTINUE');
  assert.equal(decideTaskAction({ status: null, taskPatchCount: 0, patchGoal: null, fallbackCount: 2, fallbackLimit: 2 }), 'PROTOCOL_ERROR');
});
