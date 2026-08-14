const SURFACES = Object.freeze([
  'context_limit',
  'patch_candidates',
  'project_create',
  'project_settings',
  'resource_input',
  'project_delete'
]);

export const SELECTOR_REMEDIATION_ACTIONS = Object.freeze({
  COLLECT_MORE_EVIDENCE: 'COLLECT_MORE_EVIDENCE',
  REVIEW_SURFACE_CONTRACT: 'REVIEW_SURFACE_CONTRACT',
  RETUNE_TAG_FILTER: 'RETUNE_TAG_FILTER',
  RETUNE_ROLE_FILTER: 'RETUNE_ROLE_FILTER',
  RETUNE_TYPE_FILTER: 'RETUNE_TYPE_FILTER',
  RETUNE_MACHINE_ID_FILTER: 'RETUNE_MACHINE_ID_FILTER',
  RETUNE_SEMANTIC_HINT: 'RETUNE_SEMANTIC_HINT',
  RETUNE_ANCESTOR_CONTEXT: 'RETUNE_ANCESTOR_CONTEXT',
  ADD_DISAMBIGUATION_CONTEXT: 'ADD_DISAMBIGUATION_CONTEXT'
});

const DELTA_TO_ACTION = Object.freeze({
  NO_FINGERPRINT_EVIDENCE: SELECTOR_REMEDIATION_ACTIONS.COLLECT_MORE_EVIDENCE,
  NO_STRUCTURAL_CANDIDATE: SELECTOR_REMEDIATION_ACTIONS.REVIEW_SURFACE_CONTRACT,
  MULTIPLE_STRUCTURAL_MATCHES: SELECTOR_REMEDIATION_ACTIONS.ADD_DISAMBIGUATION_CONTEXT,
  TAG_MISMATCH: SELECTOR_REMEDIATION_ACTIONS.RETUNE_TAG_FILTER,
  ROLE_MISMATCH: SELECTOR_REMEDIATION_ACTIONS.RETUNE_ROLE_FILTER,
  TYPE_MISMATCH: SELECTOR_REMEDIATION_ACTIONS.RETUNE_TYPE_FILTER,
  MACHINE_ID_CATEGORY_CHANGED: SELECTOR_REMEDIATION_ACTIONS.RETUNE_MACHINE_ID_FILTER,
  SEMANTIC_HINT_MISMATCH: SELECTOR_REMEDIATION_ACTIONS.RETUNE_SEMANTIC_HINT,
  ANCESTOR_CONTEXT_CHANGED: SELECTOR_REMEDIATION_ACTIONS.RETUNE_ANCESTOR_CONTEXT
});

const REVIEW_TARGETS = Object.freeze({
  context_limit: Object.freeze([
    'conversation_manager.context_limit_detection',
    'calibration_matrix.context_limit_scope'
  ]),
  patch_candidates: Object.freeze([
    'artifact_observer.patch_candidate_detection',
    'calibration_matrix.patch_candidate_scope'
  ]),
  project_create: Object.freeze([
    'selector_profile.patterns.project.newProject',
    'selector_profile.selectors.semanticButtons'
  ]),
  project_settings: Object.freeze([
    'selector_profile.patterns.project.projectSettings',
    'selector_profile.patterns.project.projectMenu',
    'selector_profile.patterns.project.more',
    'selector_profile.selectors.semanticButtons'
  ]),
  resource_input: Object.freeze([
    'selector_profile.selectors.fileInputs'
  ]),
  project_delete: Object.freeze([
    'selector_profile.patterns.project.deleteProject',
    'selector_profile.patterns.project.confirmDelete',
    'selector_profile.patterns.project.projectMenu',
    'selector_profile.patterns.project.more',
    'selector_profile.selectors.projectAnchors',
    'selector_profile.selectors.semanticButtons'
  ])
});

const HARD_REVIEW_ACTIONS = new Set([
  SELECTOR_REMEDIATION_ACTIONS.REVIEW_SURFACE_CONTRACT,
  SELECTOR_REMEDIATION_ACTIONS.RETUNE_TAG_FILTER,
  SELECTOR_REMEDIATION_ACTIONS.RETUNE_ROLE_FILTER,
  SELECTOR_REMEDIATION_ACTIONS.RETUNE_TYPE_FILTER,
  SELECTOR_REMEDIATION_ACTIONS.ADD_DISAMBIGUATION_CONTEXT
]);

function uniqueActions(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const action = DELTA_TO_ACTION[String(value ?? '')];
    if (action && !result.includes(action)) result.push(action);
  }
  return result;
}

function statusFor(actions) {
  if (actions.length === 0) return 'no_change';
  if (actions.length === 1 && actions[0] === SELECTOR_REMEDIATION_ACTIONS.COLLECT_MORE_EVIDENCE) return 'collect_evidence';
  if (actions.some(action => HARD_REVIEW_ACTIONS.has(action))) return 'review_required';
  return 'actionable';
}

export function buildSelectorRemediationPlan(delta = {}, { now = () => new Date() } = {}) {
  const surfaces = {};
  for (const id of SURFACES) {
    const actions = uniqueActions(delta?.surfaces?.[id]?.delta_codes);
    surfaces[id] = {
      status: statusFor(actions),
      action_codes: actions,
      review_targets: [...REVIEW_TARGETS[id]]
    };
  }
  return {
    version: 1,
    generated_at: now().toISOString(),
    surfaces
  };
}
