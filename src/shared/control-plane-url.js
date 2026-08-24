export const LEGACY_CONTROL_PLANE_URL = 'https://patchsync-status.zyhfrozen.workers.dev';
export const CANONICAL_CONTROL_PLANE_URL = 'https://patchsyncstatus.zyhfronzen.com';

export function normalizeControlPlaneUrl(value) {
  if (typeof value !== 'string') return value;
  const normalized = value.replace(/\/+$/, '');
  return normalized === LEGACY_CONTROL_PLANE_URL ? CANONICAL_CONTROL_PLANE_URL : value;
}
