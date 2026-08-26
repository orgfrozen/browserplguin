import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskStatus, decideTaskAction } from '../src/shared/status-protocol.js';

test('parses machine task status markers', () => {
  assert.equal(parseTaskStatus('x <TASK_STATUS>CONTINUE</TASK_STATUS>'), 'CONTINUE');
  assert.equal(parseTaskStatus('<TASK_STATUS>DONE</TASK_STATUS>'), 'DONE');
  assert.equal(parseTaskStatus('<TASK_STATUS>BLOCKED</TASK_STATUS>'), 'BLOCKED');
  assert.equal(parseTaskStatus('no marker'), null);
});

test('model DONE always defers final completion to the server regardless of local patch count', () => {
  assert.equal(decideTaskAction({ status: 'DONE', taskPatchCount: 0, patchGoal: null, fallbackCount: 0, fallbackLimit: 2 }), 'CHECK_COMPLETION');
  assert.equal(decideTaskAction({ status: 'DONE', taskPatchCount: 2, patchGoal: { minimum: 3 }, fallbackCount: 0, fallbackLimit: 2 }), 'CHECK_COMPLETION');
  assert.equal(decideTaskAction({ status: 'DONE', taskPatchCount: 3, patchGoal: { minimum: 3 }, fallbackCount: 0, fallbackLimit: 2 }), 'CHECK_COMPLETION');
});

test('blocked task stops and missing protocol is bounded by an authoritative completion check', () => {
  assert.equal(decideTaskAction({ status: 'BLOCKED', taskPatchCount: 0, patchGoal: null, fallbackCount: 0, fallbackLimit: 2 }), 'BLOCK');
  assert.equal(decideTaskAction({ status: null, taskPatchCount: 0, patchGoal: null, fallbackCount: 0, fallbackLimit: 2 }), 'CONTINUE');
  assert.equal(decideTaskAction({ status: null, taskPatchCount: 0, patchGoal: null, fallbackCount: 2, fallbackLimit: 2 }), 'CHECK_PROTOCOL_COMPLETION');
});

test('missing protocol at the fallback threshold defers to authoritative completion_check instead of becoming terminal', () => {
  assert.equal(decideTaskAction({ status: null, taskPatchCount: 0, patchGoal: null, fallbackCount: 1, fallbackLimit: 2 }), 'CONTINUE');
  assert.equal(decideTaskAction({ status: null, taskPatchCount: 0, patchGoal: null, fallbackCount: 2, fallbackLimit: 2 }), 'CHECK_PROTOCOL_COMPLETION');
});
