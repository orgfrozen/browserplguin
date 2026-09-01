export const DEFAULT_INTERACTION_PACING_MS = 350;
export const MAX_INTERACTION_PACING_MS = 5000;

export const INTERACTION_PACING_ACTION_MULTIPLIERS = Object.freeze({
  click: 0.7,
  input: 0.6,
  menu: 0.8,
  dialog: 0.9,
  upload: 1.4,
  navigation: 1.5
});

export function normalizeInteractionPacingMs(value, fallback = DEFAULT_INTERACTION_PACING_MS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    const fallbackNumeric = Number(fallback);
    if (!Number.isFinite(fallbackNumeric)) return DEFAULT_INTERACTION_PACING_MS;
    return Math.min(MAX_INTERACTION_PACING_MS, Math.max(0, Math.round(fallbackNumeric)));
  }
  return Math.min(MAX_INTERACTION_PACING_MS, Math.max(0, Math.round(numeric)));
}

export function interactionPacingPressureMultiplier(state = {}) {
  const level = String(state?.pressure_level ?? state?.state ?? 'normal').toLowerCase();
  if (level === 'cooldown') return 2;
  if (level === 'throttled') return 1.5;
  if (level === 'recovering' || level === 'cautious') return 1.35;
  return 1;
}

function normalizePressureMultiplier(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.min(3, Math.max(1, numeric));
}

function clampUnit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(1, Math.max(0, numeric));
}

export function interactionPacingProfile(baseMs) {
  const normalized = normalizeInteractionPacingMs(baseMs, 0);
  if (normalized === 0) return 'off';
  if (normalized <= 200) return 'fast';
  if (normalized <= 450) return 'balanced';
  if (normalized <= 700) return 'conservative';
  return 'custom';
}

export class InteractionPacing {
  constructor({
    baseMs = 0,
    pressureMultiplier = 1,
    random = Math.random,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  } = {}) {
    this.random = typeof random === 'function' ? random : Math.random;
    this.sleep = typeof sleep === 'function' ? sleep : (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.configure({ baseMs, pressureMultiplier });
  }

  configure({ baseMs = this.baseMs, pressureMultiplier = this.pressureMultiplier } = {}) {
    this.baseMs = normalizeInteractionPacingMs(baseMs, 0);
    this.pressureMultiplier = normalizePressureMultiplier(pressureMultiplier);
    return this.snapshot();
  }

  get enabled() {
    return this.baseMs > 0;
  }

  snapshot() {
    return {
      baseMs: this.baseMs,
      pressureMultiplier: this.pressureMultiplier,
      enabled: this.enabled,
      profile: interactionPacingProfile(this.baseMs)
    };
  }

  delayFor(action = 'click', { randomValue } = {}) {
    if (!this.enabled) return 0;
    const actionMultiplier = INTERACTION_PACING_ACTION_MULTIPLIERS[action] ?? 1;
    const sample = randomValue === undefined ? clampUnit(this.random()) : clampUnit(randomValue);
    const jitterMultiplier = 0.8 + (sample * 0.4);
    return Math.max(0, Math.round((this.baseMs * actionMultiplier * this.pressureMultiplier * jitterMultiplier) + 1e-9));
  }

  async wait(action = 'click') {
    if (!this.enabled) return 0;
    const delayMs = this.delayFor(action);
    if (delayMs <= 0) return 0;
    await this.sleep(delayMs);
    return delayMs;
  }
}
