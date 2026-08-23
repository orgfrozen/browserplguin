import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectName, buildProjectInstructions } from '../src/shared/project-naming.js';

test('project name uses fixed ewan namespace and local yyyyMMddHHmm', () => {
  const date = new Date('2026-08-13T14:15:00+08:00');
  assert.equal(makeProjectName('vetatool', date, 1, 'Asia/Shanghai'), 'vetatool_ewan_202608131415');
  assert.equal(makeProjectName('vetatool', date, 2, 'Asia/Shanghai'), 'vetatool_ewan_202608131415-02');
});

test('project instructions keep project and PatchSync context but do not expose the concrete Task before the formal Task prompt', () => {
  const llmRules = '# PATCH_SYNC_VERSION=1\n# PATCH_SESSION_ID=ps-20260817-abc123\n# PATCH_SYNC_END\n\nOnly emit applicable Git patches.';
  const text = buildProjectInstructions({
    project: { project_id: 'vetatool', name: 'VetaTool', description: '海外工具站', goal: '持续提升自然搜索流量' },
    task: {
      task_id: 'task-1', title: '修复后台登录', goal: '让登录和导航稳定',
      instructions: ['保持现有架构', '不要无关重构'],
      acceptance: { min_successful_patches: 3 }
    },
    llmRules
  });
  assert.match(text, /VetaTool/);
  assert.match(text, /海外工具站/);
  assert.match(text, /持续提升自然搜索流量/);
  assert.doesNotMatch(text, /修复后台登录/);
  assert.doesNotMatch(text, /让登录和导航稳定/);
  assert.doesNotMatch(text, /不要无关重构/);
  assert.doesNotMatch(text, /min_successful_patches/);
  assert.match(text, /正式 Task Prompt/);
  assert.match(text, /初始化分析阶段不得修改文件或生成 Git Patch/);
  assert.ok(text.includes(llmRules));
  assert.match(text, /<TASK_STATUS>CONTINUE<\/TASK_STATUS>/);
  assert.match(text, /<TASK_STATUS>DONE<\/TASK_STATUS>/);
  assert.doesNotMatch(text, /当前执行 Session ID/);
});

test('project naming no longer exports a browser-generated Patch session id factory', async () => {
  const module = await import('../src/shared/project-naming.js');
  assert.equal(typeof module.makeSessionId, 'undefined');
});

test('project collision selection increments same-hour suffix', async () => {
  const { makeAvailableProjectName } = await import('../src/shared/project-naming.js');
  const date = new Date('2026-08-13T15:10:00+08:00');
  const name = makeAvailableProjectName('vetatool', ['vetatool_ewan_202608131510', 'vetatool_ewan_202608131510-02'], date, 'Asia/Shanghai');
  assert.equal(name, 'vetatool_ewan_202608131510-03');
});

test('project instructions tell the model to make routine decisions autonomously instead of asking for confirmation', () => {
  const text = buildProjectInstructions({ project: { project_id: 'vetatool' }, llmRules: 'rules' });
  assert.match(text, /不需要等待人工确认/);
  assert.match(text, /专业经验/);
  assert.match(text, /不要.*(?:伪造|编造).*(?:密钥|Token|密码|验证码)/);
});
