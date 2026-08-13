const statusEl = document.getElementById('status');

function show(value) {
  statusEl.textContent = JSON.stringify(value, null, 2);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  show(response);
  return response;
}

async function refresh() {
  await send({ type: 'GET_RUNNER_STATUS' });
}

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('runMock').addEventListener('click', async () => {
  const taskId = document.getElementById('mockTaskId').value.trim() || null;
  await send({ type: 'RUN_MOCK_ONCE', taskId });
});
document.getElementById('runReal').addEventListener('click', async () => {
  await send({ type: 'RUN_REAL_ONCE' });
});
document.getElementById('inspectUi').addEventListener('click', async () => {
  await send({ type: 'INSPECT_CHATGPT_UI' });
});
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
refresh().catch(error => show({ ok: false, error: error.message }));
