export const WORKSPACE_MODES = Object.freeze({
  PROJECT: 'project',
  CHAT: 'chat'
});

export function normalizeWorkspaceMode(value) {
  return value === WORKSPACE_MODES.CHAT ? WORKSPACE_MODES.CHAT : WORKSPACE_MODES.PROJECT;
}

export function resolveWorkspaceMode(state = {}) {
  if (state?.workspace_mode != null) return normalizeWorkspaceMode(state.workspace_mode);
  if (state?.task_workspace?.mode != null) return normalizeWorkspaceMode(state.task_workspace.mode);
  return WORKSPACE_MODES.PROJECT;
}
