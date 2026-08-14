import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationEvidenceLedger } from '../src/background/calibration-evidence-ledger.js';

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); }
  };
}

function matrix({ status = 'pass', page = 'chat', secret = 'TOP-SECRET' } = {}) {
  return {
    selector_profile: { id: 'chatgpt-semantic-v1', version: 1 },
    page: { category: page, access_status: 'READY', secret },
    summary: { pass: status === 'pass' ? 1 : 0, unavailable: status === 'unavailable' ? 1 : 0, incompatible: status === 'incompatible' ? 1 : 0 },
    checks: [
      { id: 'composer', status, evidence: { text: secret, url: `https://secret.invalid/?token=${secret}` } },
      { id: 'unknown_surface', status: 'pass', evidence: { secret } },
      { id: 'project_create', status: 'NOT_A_STATUS', evidence: { project: secret } }
    ],
    arbitrary: secret
  };
}

test('calibration evidence ledger stores only fixed safe fields and aggregates surface counts', async () => {
  const storage = memoryStorage();
  const ledger = new CalibrationEvidenceLedger({ storage, now: () => new Date('2026-08-14T03:00:00.000Z') });

  await ledger.record(matrix({ status: 'pass' }));
  await ledger.record(matrix({ status: 'unavailable' }));

  const summary = await ledger.getSummary();
  assert.equal(summary.total_runs, 2);
  assert.equal(summary.recent_runs.length, 2);
  assert.deepEqual(summary.selector_profiles, [{ id: 'chatgpt-semantic-v1', version: 1 }]);
  assert.deepEqual(summary.surfaces.composer, {
    total_runs: 2,
    pass_count: 1,
    unavailable_count: 1,
    incompatible_count: 0,
    latest_status: 'unavailable',
    latest_page_category: 'chat',
    last_seen_at: '2026-08-14T03:00:00.000Z'
  });
  assert.equal(summary.surfaces.project_create.incompatible_count, 2);
  assert.equal('unknown_surface' in summary.surfaces, false);

  const serialized = JSON.stringify(summary).toLowerCase();
  for (const secret of ['top-secret', 'secret.invalid', 'token=', 'arbitrary', 'evidence', 'url']) {
    assert.equal(serialized.includes(secret), false, `ledger leaked ${secret}`);
  }
});

test('calibration evidence ledger bounds recent runs while preserving aggregate counts and serializes concurrent writes', async () => {
  const storage = memoryStorage();
  let tick = 0;
  const ledger = new CalibrationEvidenceLedger({
    storage,
    maxRecentRuns: 3,
    now: () => new Date(Date.UTC(2026, 7, 14, 4, 0, tick++))
  });

  await Promise.all([
    ledger.record(matrix({ status: 'pass', page: 'chat' })),
    ledger.record(matrix({ status: 'pass', page: 'project' })),
    ledger.record(matrix({ status: 'incompatible', page: 'project' })),
    ledger.record(matrix({ status: 'unavailable', page: 'home' }))
  ]);

  const summary = await ledger.getSummary();
  assert.equal(summary.total_runs, 4);
  assert.equal(summary.recent_runs.length, 3);
  assert.equal(summary.surfaces.composer.total_runs, 4);
  assert.equal(summary.surfaces.composer.pass_count, 2);
  assert.equal(summary.surfaces.composer.incompatible_count, 1);
  assert.equal(summary.surfaces.composer.unavailable_count, 1);
});

test('calibration evidence ledger clear removes only its own state', async () => {
  const storage = memoryStorage();
  await storage.set('other', { keep: true });
  const ledger = new CalibrationEvidenceLedger({ storage });
  await ledger.record(matrix());
  await ledger.clear();
  assert.deepEqual(await ledger.getSummary(), { version: 1, total_runs: 0, selector_profiles: [], surfaces: {}, recent_runs: [], last_run: null });
  assert.deepEqual(await storage.get('other'), { keep: true });
});
