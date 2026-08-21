import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTONOMY_CONTINUATION_PROMPT, classifyAssistantInteraction } from '../src/shared/model-interaction.js';

test('classifies ordinary confirmation and technical-choice questions for autonomous continuation', () => {
  for (const text of [
    '是否确认这样修改？',
    '你希望方案 A 还是方案 B？',
    '这个业务字段应该删除还是保留？',
    '缺少 API key，请提供。',
    'Should I keep the current schema or migrate it?'
  ]) {
    assert.equal(classifyAssistantInteraction(text), 'AUTONOMY_CONTINUE', text);
  }
});

test('does not override explicit Task status markers or ordinary completed prose', () => {
  assert.equal(classifyAssistantInteraction('是否继续？\n<TASK_STATUS>BLOCKED</TASK_STATUS>'), null);
  assert.equal(classifyAssistantInteraction('修改已经完成。\n<TASK_STATUS>DONE</TASK_STATUS>'), null);
  assert.equal(classifyAssistantInteraction('我已经完成代码修改和验证。'), null);
});

test('autonomy continuation prompt authorizes professional judgment without inventing real credentials', () => {
  assert.match(AUTONOMY_CONTINUATION_PROMPT, /专业经验/);
  assert.match(AUTONOMY_CONTINUATION_PROMPT, /最稳妥|最佳/);
  assert.match(AUTONOMY_CONTINUATION_PROMPT, /不需要等待人工确认/);
  assert.match(AUTONOMY_CONTINUATION_PROMPT, /不得.*(?:密钥|Token|密码|验证码)/);
  assert.match(AUTONOMY_CONTINUATION_PROMPT, /<TASK_STATUS>BLOCKED<\/TASK_STATUS>/);
});
