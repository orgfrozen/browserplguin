import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiagnosticScreenshotPolicy,
  evaluateDiagnosticScreenshotRequest
} from '../src/shared/diagnostic-screenshot-policy.js';

test('diagnostic screenshot policy v1 is explicit opt-in, redaction-first, and capture-disabled', () => {
  assert.deepEqual(buildDiagnosticScreenshotPolicy(), {
    version: 1,
    capture_enabled: false,
    consent_required: true,
    eligible_error_codes: ['UI_SELECTOR_INCOMPATIBLE'],
    required_access_status: 'READY',
    eligible_page_categories: ['chat'],
    capture_scope: 'semantic_control_regions_only',
    allowed_region_categories: ['target_control', 'nearest_container', 'navigation_control', 'dialog_control'],
    max_regions: 4,
    redaction_required: true,
    allowed_redaction_modes: ['solid_mask'],
    full_page_allowed: false,
    arbitrary_coordinates_allowed: false,
    ocr_allowed: false,
    text_extraction_allowed: false,
    persistence_allowed: false,
    export_allowed: false,
    upload_allowed: false
  });
});

test('eligible future request still cannot capture until a separate implementation explicitly enables capture', () => {
  assert.deepEqual(evaluateDiagnosticScreenshotRequest({
    consent: true,
    error_code: 'UI_SELECTOR_INCOMPATIBLE',
    access_status: 'READY',
    page_category: 'chat',
    capture_scope: 'semantic_control_regions_only',
    region_categories: ['target_control', 'dialog_control'],
    redaction_mode: 'solid_mask'
  }), {
    policy_version: 1,
    eligible_for_future_capture: true,
    capture_allowed: false,
    blockers: ['CAPTURE_NOT_IMPLEMENTED']
  });
});

test('screenshot request fails closed on consent, login/challenge, full-page/free-region, or non-selector errors without echoing hostile input', () => {
  const result = evaluateDiagnosticScreenshotRequest({
    consent: false,
    error_code: 'LOGIN_OR_CHALLENGE_REQUIRED',
    access_status: 'CHALLENGE_REQUIRED',
    page_category: 'challenge',
    capture_scope: 'full_page secret-project-name',
    region_categories: ['arbitrary-secret-region', 'target_control', 'target_control', 'target_control', 'target_control', 'dialog_control'],
    redaction_mode: 'blur-secret-token',
    prompt: 'TOP SECRET PROMPT',
    url: 'https://chatgpt.com/c/secret?token=abc'
  });

  assert.equal(result.policy_version, 1);
  assert.equal(result.eligible_for_future_capture, false);
  assert.equal(result.capture_allowed, false);
  assert.deepEqual(result.blockers, [
    'CONSENT_REQUIRED',
    'ERROR_NOT_ELIGIBLE',
    'ACCESS_NOT_READY',
    'PAGE_NOT_ELIGIBLE',
    'SCOPE_NOT_ALLOWED',
    'REGION_POLICY_VIOLATION',
    'REDACTION_REQUIRED',
    'CAPTURE_NOT_IMPLEMENTED'
  ]);
  const serialized = JSON.stringify(result);
  for (const secret of ['secret-project-name', 'arbitrary-secret-region', 'blur-secret-token', 'TOP SECRET PROMPT', 'token=abc']) {
    assert.equal(serialized.includes(secret), false, `policy result leaked ${secret}`);
  }
});
