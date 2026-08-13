import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

for (const file of ['src/ui/popup.html','src/ui/popup.js','src/ui/options.html','src/ui/options.js']) {
  test(`${file} exists and is non-empty`, async () => {
    const text = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(text.trim().length > 20);
  });
}

test('options exposes server and execution safety settings', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  for (const id of ['taskApiBaseUrl','taskApiToken','heartbeatIntervalMs','fallbackLimit','maxTaskRounds','patchDownloadTimeoutMs']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('popup exposes safe ChatGPT UI diagnostics action', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']inspectUi["']/);
  assert.match(js, /INSPECT_CHATGPT_UI/);
});

test('popup renders structured active Task observability instead of raw status JSON', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['runnerMode','runnerState','activeTask','activePhase','activeRound','activePatchCount','activePatchGoal','activeProject','activeSession','activeRoundStage','activeLease','lastRecovery']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /GET_RUNNER_STATUS/);
  assert.match(js, /renderRunnerStatus/);
  assert.match(js, /const status = await send\(\{ type: 'GET_RUNNER_STATUS' \}\);\s*renderRunnerStatus\(status\)/);
});
