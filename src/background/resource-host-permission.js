import { RunnerError, ERROR_CODES } from '../shared/errors.js';

function permissionError(reason, originPattern = null) {
  throw new RunnerError(
    ERROR_CODES.RESOURCE_HOST_PERMISSION_REQUIRED,
    'Task resource host permission is required',
    { reason, originPattern }
  );
}

export function resourceOriginPattern(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    permissionError('invalid_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) permissionError('unsupported_scheme');
  if (url.username || url.password) permissionError('credentials_not_allowed');
  return `${url.protocol}//${url.host}/*`;
}

export class ResourceHostPermissionManager {
  constructor({ permissions } = {}) {
    this.permissions = permissions;
  }

  async assertGranted(resourceUrl) {
    const originPattern = resourceOriginPattern(resourceUrl);
    if (!this.permissions?.contains) permissionError('permission_api_unavailable', originPattern);
    let granted = false;
    try {
      granted = await this.permissions.contains({ origins: [originPattern] });
    } catch {
      permissionError('permission_check_failed', originPattern);
    }
    if (!granted) permissionError('not_granted', originPattern);
    return { originPattern };
  }
}
