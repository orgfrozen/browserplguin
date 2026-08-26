function normalizeSnapshot(value) {
  return {
    state: typeof value?.state === 'string' && value.state ? value.state : 'UNKNOWN',
    contextLimit: value?.contextLimit === true,
    responseFailure: value?.responseFailure
      ? {
          failed: value.responseFailure.failed === true,
          retryAvailable: value.responseFailure.retryAvailable === true
        }
      : null
  };
}

function snapshotKey(snapshot) {
  return JSON.stringify(snapshot);
}

export function installTabStateReporter({
  runtime = globalThis.chrome?.runtime,
  root = globalThis.document,
  readState,
  MutationObserverCtor = globalThis.MutationObserver,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
  heartbeatMs = 15000,
  now = () => new Date()
} = {}) {
  if (!runtime || typeof runtime.sendMessage !== 'function' || typeof readState !== 'function' || !root || typeof MutationObserverCtor !== 'function') {
    return { flush: async () => {}, disconnect() {} };
  }

  let lastStateKey = null;
  let pending = Promise.resolve();
  let disconnected = false;

  const send = (type, { force = false } = {}) => {
    if (disconnected) return pending;
    const snapshot = normalizeSnapshot(readState());
    const key = snapshotKey(snapshot);
    if (!force && type === 'CHATGPT_SLOT_STATE' && key === lastStateKey) return pending;
    if (type === 'CHATGPT_SLOT_STATE') lastStateKey = key;
    const message = { type, ...snapshot, observedAt: now().toISOString() };
    pending = pending.then(async () => {
      try { await runtime.sendMessage(message); } catch { /* best effort; background heartbeat is the fallback */ }
    });
    return pending;
  };

  const observer = new MutationObserverCtor(() => { send('CHATGPT_SLOT_STATE'); });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title', 'disabled', 'data-testid']
  });

  const intervalId = setIntervalFn(() => { send('CHATGPT_SLOT_HEARTBEAT', { force: true }); }, heartbeatMs);
  send('CHATGPT_SLOT_STATE', { force: true });

  return {
    flush: () => pending,
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      observer.disconnect();
      clearIntervalFn(intervalId);
    }
  };
}
