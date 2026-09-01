import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InteractionPacing,
  interactionPacingPressureMultiplier,
  normalizeInteractionPacingMs
} from '../src/shared/interaction-pacing.js';

test('interaction pacing uses configured base, action multiplier, pressure multiplier, and bounded jitter', async () => {
  const sleeps = [];
  const pacing = new InteractionPacing({
    baseMs: 350,
    pressureMultiplier: 1.5,
    random: () => 0.5,
    sleep: async ms => { sleeps.push(ms); }
  });

  const delay = await pacing.wait('click');
  assert.equal(delay, 368);
  assert.deepEqual(sleeps, [368]);

  pacing.configure({ pressureMultiplier: 1 });
  assert.equal(pacing.delayFor('click', { randomValue: 0 }), 196);
  assert.equal(pacing.delayFor('click', { randomValue: 1 }), 294);
});

test('interaction pacing base 0 is a hard off switch with no sleep or jitter work', async () => {
  let randomReads = 0;
  let sleepCalls = 0;
  const pacing = new InteractionPacing({
    baseMs: 0,
    pressureMultiplier: 2,
    random: () => { randomReads += 1; return 0.5; },
    sleep: async () => { sleepCalls += 1; }
  });

  assert.equal(pacing.enabled, false);
  assert.equal(pacing.delayFor('upload'), 0);
  assert.equal(await pacing.wait('navigation'), 0);
  assert.equal(randomReads, 0);
  assert.equal(sleepCalls, 0);
});

test('interaction pacing normalization and adaptive pressure remain bounded and deterministic', () => {
  assert.equal(normalizeInteractionPacingMs(0, 350), 0);
  assert.equal(normalizeInteractionPacingMs('600', 350), 600);
  assert.equal(normalizeInteractionPacingMs(-1, 350), 0);
  assert.equal(normalizeInteractionPacingMs(99999, 350), 5000);
  assert.equal(normalizeInteractionPacingMs('nope', 350), 350);

  assert.equal(interactionPacingPressureMultiplier({ state: 'normal' }), 1);
  assert.equal(interactionPacingPressureMultiplier({ state: 'recovering' }), 1.35);
  assert.equal(interactionPacingPressureMultiplier({ state: 'throttled' }), 1.5);
  assert.equal(interactionPacingPressureMultiplier({ pressure_level: 'cooldown' }), 2);
});
