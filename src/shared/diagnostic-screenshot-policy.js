const POLICY = Object.freeze({
  version: 1,
  capture_enabled: false,
  consent_required: true,
  eligible_error_codes: Object.freeze(['UI_SELECTOR_INCOMPATIBLE']),
  required_access_status: 'READY',
  eligible_page_categories: Object.freeze(['chat']),
  capture_scope: 'semantic_control_regions_only',
  allowed_region_categories: Object.freeze(['target_control', 'nearest_container', 'navigation_control', 'dialog_control']),
  max_regions: 4,
  redaction_required: true,
  allowed_redaction_modes: Object.freeze(['solid_mask']),
  full_page_allowed: false,
  arbitrary_coordinates_allowed: false,
  ocr_allowed: false,
  text_extraction_allowed: false,
  persistence_allowed: false,
  export_allowed: false,
  upload_allowed: false
});

function clonePolicy() {
  return {
    ...POLICY,
    eligible_error_codes: [...POLICY.eligible_error_codes],
    eligible_page_categories: [...POLICY.eligible_page_categories],
    allowed_region_categories: [...POLICY.allowed_region_categories],
    allowed_redaction_modes: [...POLICY.allowed_redaction_modes]
  };
}

export function buildDiagnosticScreenshotPolicy() {
  return clonePolicy();
}

export function evaluateDiagnosticScreenshotRequest(input = {}) {
  const blockers = [];
  const consent = input?.consent === true;
  const errorCode = String(input?.error_code ?? '');
  const accessStatus = String(input?.access_status ?? '');
  const pageCategory = String(input?.page_category ?? '');
  const captureScope = String(input?.capture_scope ?? '');
  const redactionMode = String(input?.redaction_mode ?? '');
  const regions = Array.isArray(input?.region_categories) ? input.region_categories : [];

  if (!consent) blockers.push('CONSENT_REQUIRED');
  if (!POLICY.eligible_error_codes.includes(errorCode)) blockers.push('ERROR_NOT_ELIGIBLE');
  if (accessStatus !== POLICY.required_access_status) blockers.push('ACCESS_NOT_READY');
  if (!POLICY.eligible_page_categories.includes(pageCategory)) blockers.push('PAGE_NOT_ELIGIBLE');
  if (captureScope !== POLICY.capture_scope) blockers.push('SCOPE_NOT_ALLOWED');
  if (
    regions.length < 1 ||
    regions.length > POLICY.max_regions ||
    regions.some(region => !POLICY.allowed_region_categories.includes(String(region ?? '')))
  ) blockers.push('REGION_POLICY_VIOLATION');
  if (!POLICY.allowed_redaction_modes.includes(redactionMode)) blockers.push('REDACTION_REQUIRED');

  const eligibleForFutureCapture = blockers.length === 0;
  blockers.push('CAPTURE_NOT_IMPLEMENTED');
  return {
    policy_version: POLICY.version,
    eligible_for_future_capture: eligibleForFutureCapture,
    capture_allowed: false,
    blockers
  };
}
