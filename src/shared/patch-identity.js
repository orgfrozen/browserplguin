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
