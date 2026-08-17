import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { beginRecoveryAction, clearRecoveryState } from '../shared/execution-state.js';

const GPT_STALL_SIGNAL = 'GPT_RESPONSE_STALLED';

function requirePositiveSeconds(value, field) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RunnerError(ERROR_CODES.RECOVERY_POLICY_INVALID, `${field} must be a positive number`);
  }
  return seconds;
}

function findRule(policy, signal) {
  const rule = policy?.rules?.find(item => item?.signal === signal);
  if (!rule) return null;
  if (!Array.isArray(rule.actions)) {
    throw new RunnerError(ERROR_CODES.RECOVERY_POLICY_INVALID, `Recovery rule ${rule.id ?? signal} must define actions`);
  }
  return rule;
}

function actionOf(rule, type) {
  return rule.actions.find(action => action?.type === type) ?? null;
}

function maxAttempts(action) {
  const value = Number(action?.max_attempts ?? 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function timeoutMs(rule, action = null) {
  return requirePositiveSeconds(
    action?.observation_timeout_seconds ?? rule?.observation_timeout_seconds,
    `${action?.type ?? rule?.id ?? 'recovery'}.observation_timeout_seconds`
  ) * 1000;
}

function isResponseTimeout(error) {
  return error?.code === ERROR_CODES.MODEL_RESPONSE_TIMEOUT;
}

export class RecoveryPolicyEngine {
  constructor({ page, taskStore, now = () => new Date() }) {
    this.page = page;
    this.taskStore = taskStore;
    this.now = now;
  }

  observationTimeoutMs(policy) {
    const rule = findRule(policy, GPT_STALL_SIGNAL);
    return rule ? timeoutMs(rule) : null;
  }

  #isoNow() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  async #saveAction(state, rule, action, attempt, observationTimeoutMs) {
    const startedAt = this.#isoNow();
    const nextCheckAt = new Date(Date.parse(startedAt) + observationTimeoutMs).toISOString();
    const next = beginRecoveryAction(state, {
      signal: rule.signal,
      ruleId: rule.id,
      action: action.type,
      attempt,
      observationStartedAt: startedAt,
      lastMeaningfulProgressAt: state.last_meaningful_progress_at ?? state.recovery_state?.last_meaningful_progress_at ?? null,
      nextCheckAt
    });
    await this.taskStore.save(next);
    return next;
  }

  async #runOperation(operation, state, observationTimeoutMs, recover) {
    try {
      return await operation({ state, observationTimeoutMs, recover });
    } catch (error) {
      if (error?.durableExecutionState) state = error.durableExecutionState;
      if (!isResponseTimeout(error)) throw error;
      return { timeout: true, state, error };
    }
  }

  async execute({ task, state, policy, operation }) {
    const rule = findRule(policy, GPT_STALL_SIGNAL);
    if (!rule) {
      return operation({ state, observationTimeoutMs: null, recover: Boolean(state.recovery_state) });
    }

    const initialTimeoutMs = timeoutMs(rule);
    let current = state;
    let outcome = await this.#runOperation(operation, current, initialTimeoutMs, Boolean(current.recovery_state));
    if (!outcome?.timeout) {
      const clean = clearRecoveryState(outcome.state ?? current);
      if (clean !== outcome.state) await this.taskStore.save(clean);
      return { state: clean, result: outcome.result };
    }
    current = outcome.state;

    const prior = current.recovery_state?.signal === rule.signal ? current.recovery_state : null;
    const reloadAction = actionOf(rule, 'RELOAD_PAGE');
    const reopenAction = actionOf(rule, 'REOPEN_WORKSPACE');
    const healthAction = actionOf(rule, 'HEALTH_CHECK');
    let reloadDone = prior?.action === 'RELOAD_PAGE' ? Number(prior.attempt) || 0
      : prior?.action === 'REOPEN_WORKSPACE' || prior?.action === 'ESCALATE' ? maxAttempts(reloadAction) : 0;
    let reopenDone = prior?.action === 'REOPEN_WORKSPACE' ? Number(prior.attempt) || 0
      : prior?.action === 'ESCALATE' ? maxAttempts(reopenAction) : 0;

    if (!prior && healthAction && typeof this.page.healthCheck === 'function') {
      await this.page.healthCheck({ task, state: current });
    }

    while (reloadAction && reloadDone < maxAttempts(reloadAction)) {
      reloadDone += 1;
      const waitMs = timeoutMs(rule, reloadAction);
      current = await this.#saveAction(current, rule, reloadAction, reloadDone, waitMs);
      await this.page.reloadPage({ task, state: current });
      outcome = await this.#runOperation(operation, current, waitMs, true);
      if (!outcome?.timeout) {
        const clean = clearRecoveryState(outcome.state ?? current);
        await this.taskStore.save(clean);
        return { state: clean, result: outcome.result };
      }
      current = outcome.state;
    }

    while (reopenAction && reopenDone < maxAttempts(reopenAction)) {
      reopenDone += 1;
      const waitMs = timeoutMs(rule, reopenAction);
      current = await this.#saveAction(current, rule, reopenAction, reopenDone, waitMs);
      await this.page.reopenWorkspace({ task, state: current });
      outcome = await this.#runOperation(operation, current, waitMs, true);
      if (!outcome?.timeout) {
        const clean = clearRecoveryState(outcome.state ?? current);
        await this.taskStore.save(clean);
        return { state: clean, result: outcome.result };
      }
      current = outcome.state;
    }

    const escalateAction = actionOf(rule, 'ESCALATE') ?? { type: 'ESCALATE' };
    current = await this.#saveAction(current, rule, escalateAction, 1, initialTimeoutMs);
    const error = new RunnerError(ERROR_CODES.RECOVERY_EXHAUSTED, 'ChatGPT response recovery policy was exhausted', {
      signal: rule.signal,
      rule_id: rule.id,
      task_id: task?.task_id ?? current.task_id ?? null
    });
    error.durableExecutionState = current;
    throw error;
  }
}
