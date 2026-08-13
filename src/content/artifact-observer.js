import { dedupePatchCandidates, isCurrentSessionPatch } from '../shared/patch-identity.js';

export function extractPatchCandidatesFromElement(element) {
  if (!element) return [];
  const nodes = [...element.querySelectorAll('a[href], button')];
  return nodes.map((node, index) => {
    const label = node.textContent?.trim() ?? '';
    const href = node.getAttribute?.('href') ?? null;
    const download = node.getAttribute?.('download') ?? '';
    const filenameMatch = `${download} ${label} ${href ?? ''}`.match(/([^\s/?#]+\.patch)\b/i);
    const filename = filenameMatch ? filenameMatch[1] : null;
    const isPatchControl = Boolean(filename) || /下载\s*Patch|download\s*patch/i.test(label);
    if (!isPatchControl) return null;
    return {
      filename,
      url: href,
      label,
      discoveryKey: filename ?? `control:${index}:${href ?? ''}:${label}`,
      element: node
    };
  }).filter(Boolean);
}

export function discoverNewPatches(latestAssistantElement, downloadedKeys, sessionId) {
  const candidates = extractPatchCandidatesFromElement(latestAssistantElement);
  const withNames = dedupePatchCandidates(candidates.filter(x => x.filename), downloadedKeys, sessionId);
  const seen = new Set(downloadedKeys);
  const clickOnly = candidates.filter(x => !x.filename).flatMap(candidate => {
    const controlKey = `${sessionId}:${candidate.discoveryKey}`;
    if (seen.has(controlKey)) return [];
    seen.add(controlKey);
    return [{ ...candidate, control_key: controlKey }];
  });
  return [...withNames, ...clickOnly];
}
