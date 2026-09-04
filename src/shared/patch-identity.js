function basename(name) {
  return String(name ?? '').split(/[\\/]/).pop();
}

export function extractPatchIdentity(filename, sessionId) {
  const file = basename(filename);
  if (!file.toLowerCase().endsWith('.patch') || !file.includes(sessionId)) return null;
  const sessionIndex = file.indexOf(sessionId);
  const suffix = sessionIndex >= 0 ? file.slice(sessionIndex + sessionId.length) : '';
  const match = suffix.match(/(?:^|[-_])(\d{3,})(?=(?:[-_].*)?\.patch$)/i);
  return {
    key: file,
    filename: file,
    sessionId,
    sequence: match ? Number.parseInt(match[1], 10) : null
  };
}

export function isCurrentSessionPatch(filename, sessionId) {
  return extractPatchIdentity(filename, sessionId) !== null;
}

export function dedupePatchCandidates(candidates, downloadedKeys, sessionId) {
  const seen = new Set(downloadedKeys);
  const output = [];
  for (const candidate of candidates) {
    const identity = extractPatchIdentity(candidate.filename, sessionId);
    if (!identity || seen.has(identity.key)) continue;
    seen.add(identity.key);
    output.push({ ...candidate, patchIdentity: identity });
  }
  return output;
}

export function latestKnownPatchSequence(state = {}, sessionId) {
  if (!sessionId) return 0;
  const sequences = [];
  const add = filename => {
    const identity = extractPatchIdentity(filename, sessionId);
    if (Number.isInteger(identity?.sequence)) sequences.push(identity.sequence);
  };

  for (const key of state.downloaded_patch_keys ?? []) add(key);
  if (state.patch_delivery?.stage === 'DOWNLOAD_COMPLETED') add(state.patch_delivery?.filename);
  const latestPatch = state.completion_preview?.latest_patch;
  if (latestPatch?.is_terminal === true && latestPatch?.terminal_kind === 'success') add(latestPatch.patch_filename);
  return sequences.length > 0 ? Math.max(...sequences) : 0;
}
