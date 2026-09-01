import { sanitizeCalibrationFingerprints } from './calibration-fingerprint.js';

const SURFACES = Object.freeze([
  'context_limit',
  'patch_candidates',
  'new_chat',
  'project_create',
  'project_settings',
  'resource_input',
  'project_delete',
  'conversation_delete'
]);

export const SELECTOR_CALIBRATION_DELTA_CODES = Object.freeze({
  NO_FINGERPRINT_EVIDENCE: 'NO_FINGERPRINT_EVIDENCE',
  NO_STRUCTURAL_CANDIDATE: 'NO_STRUCTURAL_CANDIDATE',
  MULTIPLE_STRUCTURAL_MATCHES: 'MULTIPLE_STRUCTURAL_MATCHES',
  TAG_MISMATCH: 'TAG_MISMATCH',
  ROLE_MISMATCH: 'ROLE_MISMATCH',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  MACHINE_ID_CATEGORY_CHANGED: 'MACHINE_ID_CATEGORY_CHANGED',
  SEMANTIC_HINT_MISMATCH: 'SEMANTIC_HINT_MISMATCH',
  ANCESTOR_CONTEXT_CHANGED: 'ANCESTOR_CONTEXT_CHANGED'
});

const CONTRACTS = Object.freeze({
  context_limit: Object.freeze({
    tags: Object.freeze(['div', 'section', 'form']),
    roles: Object.freeze(['alert', 'status', 'dialog', 'region']),
    tag_role_mode: 'either',
    semantic_hints: Object.freeze(['context_limit']),
    machine_categories: Object.freeze(['context_limit', 'present_unknown', 'absent'])
  }),
  patch_candidates: Object.freeze({
    tags: Object.freeze(['a', 'button']),
    roles: Object.freeze(['link', 'button']),
    tag_role_mode: 'either',
    semantic_hints: Object.freeze(['patch_download']),
    machine_categories: Object.freeze(['patch_download', 'present_unknown', 'absent'])
  }),
  new_chat: Object.freeze({
    tags: Object.freeze(['a', 'button']),
    roles: Object.freeze(['link', 'button']),
    tag_role_mode: 'either',
    semantic_hints: Object.freeze(['new_chat']),
    machine_categories: Object.freeze(['new_chat', 'present_unknown', 'absent'])
  }),
  project_create: Object.freeze({
    tags: Object.freeze(['button']),
    roles: Object.freeze(['button', 'menuitem']),
    tag_role_mode: 'either',
    semantic_hints: Object.freeze(['new_project']),
    machine_categories: Object.freeze(['new_project', 'present_unknown', 'absent'])
  }),
  project_settings: Object.freeze({
    tags: Object.freeze(['button']),
    roles: Object.freeze(['button', 'menuitem']),
    tag_role_mode: 'either',
    semantic_hints: Object.freeze(['project_settings', 'menu']),
    machine_categories: Object.freeze(['project_settings', 'menu', 'present_unknown', 'absent']),
    ancestor_categories: Object.freeze(['menu', 'dialog', 'header', 'banner'])
  }),
  resource_input: Object.freeze({
    tags: Object.freeze(['input']),
    roles: Object.freeze([]),
    types: Object.freeze(['file']),
    tag_role_mode: 'tag',
    semantic_hints: Object.freeze(['attach', 'unknown']),
    machine_categories: Object.freeze(['attach', 'present_unknown', 'absent'])
  }),
  project_delete: Object.freeze({
    tags: Object.freeze(['button']),
    roles: Object.freeze(['button', 'menuitem']),
    tag_role_mode: 'either',
    semantic_hints: Object.freeze(['delete']),
    machine_categories: Object.freeze(['delete']),
    ancestor_categories: Object.freeze(['menu', 'dialog'])
  }),
  conversation_delete: Object.freeze({
    tags: Object.freeze(['button']),
    roles: Object.freeze(['button', 'menuitem']),
    tag_role_mode: 'either',
    semantic_hints: Object.freeze(['delete']),
    machine_categories: Object.freeze(['delete']),
    ancestor_categories: Object.freeze(['menu', 'dialog'])
  })
});

function includes(values, value) {
  return Array.isArray(values) && values.includes(value);
}

function hardDeltaCodes(fingerprint, contract) {
  const codes = [];
  const tagMatch = contract.tags.length === 0 || includes(contract.tags, fingerprint.tag);
  const roleMatch = contract.roles.length === 0 || includes(contract.roles, fingerprint.role);
  let actionMatch = true;
  if (contract.tag_role_mode === 'tag') actionMatch = tagMatch;
  else if (contract.tag_role_mode === 'role') actionMatch = roleMatch;
  else if (contract.tag_role_mode === 'either') actionMatch = tagMatch || roleMatch;

  if (!actionMatch) {
    if (!tagMatch && contract.tags.length > 0) codes.push(SELECTOR_CALIBRATION_DELTA_CODES.TAG_MISMATCH);
    if (!roleMatch && contract.roles.length > 0) codes.push(SELECTOR_CALIBRATION_DELTA_CODES.ROLE_MISMATCH);
  }
  if (contract.types?.length > 0 && !includes(contract.types, fingerprint.type)) {
    codes.push(SELECTOR_CALIBRATION_DELTA_CODES.TYPE_MISMATCH);
  }
  return codes;
}

function softDeltaCodes(fingerprint, contract) {
  const codes = [];
  if (contract.semantic_hints?.length > 0 && !includes(contract.semantic_hints, fingerprint.semantic_hint)) {
    codes.push(SELECTOR_CALIBRATION_DELTA_CODES.SEMANTIC_HINT_MISMATCH);
  }

  if (contract.machine_categories?.length > 0) {
    const machineMatch = includes(contract.machine_categories, fingerprint.test_id_category)
      || includes(contract.machine_categories, fingerprint.name_category);
    if (!machineMatch) codes.push(SELECTOR_CALIBRATION_DELTA_CODES.MACHINE_ID_CATEGORY_CHANGED);
  }

  if (contract.ancestor_categories?.length > 0) {
    const ancestorMatch = fingerprint.ancestor_roles.some(value => includes(contract.ancestor_categories, value));
    if (!ancestorMatch) codes.push(SELECTOR_CALIBRATION_DELTA_CODES.ANCESTOR_CONTEXT_CHANGED);
  }
  return codes;
}

function uniqueCodes(codes) {
  const result = [];
  for (const code of codes) if (!result.includes(code)) result.push(code);
  return result;
}

function buildSurface(source, contract) {
  const fingerprints = sanitizeCalibrationFingerprints(source?.fingerprints ?? source?.latest_fingerprints);
  if (fingerprints.length === 0) {
    return {
      result: 'missing_evidence',
      candidate_count: 0,
      structural_match_count: 0,
      delta_codes: [SELECTOR_CALIBRATION_DELTA_CODES.NO_FINGERPRINT_EVIDENCE]
    };
  }

  const analyses = fingerprints.map(fingerprint => {
    const hard = hardDeltaCodes(fingerprint, contract);
    return { fingerprint, hard, soft: softDeltaCodes(fingerprint, contract) };
  });
  const matches = analyses.filter(item => item.hard.length === 0);
  const codes = [];

  if (matches.length === 0) {
    codes.push(SELECTOR_CALIBRATION_DELTA_CODES.NO_STRUCTURAL_CANDIDATE);
    for (const item of analyses) codes.push(...item.hard);
    return {
      result: 'incompatible',
      candidate_count: fingerprints.length,
      structural_match_count: 0,
      delta_codes: uniqueCodes(codes)
    };
  }

  for (const item of matches) codes.push(...item.soft);
  if (matches.length > 1) codes.unshift(SELECTOR_CALIBRATION_DELTA_CODES.MULTIPLE_STRUCTURAL_MATCHES);
  const deltaCodes = uniqueCodes(codes);
  return {
    result: matches.length > 1 ? 'needs_review' : (deltaCodes.length > 0 ? 'compatible_with_changes' : 'compatible'),
    candidate_count: fingerprints.length,
    structural_match_count: matches.length,
    delta_codes: deltaCodes
  };
}

export function buildSelectorCalibrationDelta(calibration, { now = () => new Date() } = {}) {
  const surfaces = {};
  for (const id of SURFACES) {
    surfaces[id] = buildSurface(calibration?.surfaces?.[id], CONTRACTS[id]);
  }
  return {
    version: 1,
    contract_version: 1,
    generated_at: now().toISOString(),
    surfaces
  };
}

export const SELECTOR_CALIBRATION_CONTRACT_VERSION = 1;
