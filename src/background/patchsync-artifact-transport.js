import { RunnerError, ERROR_CODES } from '../shared/errors.js';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(message, details = {}) {
  throw new RunnerError(ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED, message, { retryable: false, ...details });
}

function stripContent(artifact) {
  const { content_base64: _contentBase64, content_bytes: _contentBytes, ...metadata } = artifact ?? {};
  return metadata;
}

export class PatchSyncArtifactTransport {
  constructor({ fileReader } = {}) {
    if (!fileReader || typeof fileReader.read !== 'function') throw new TypeError('fileReader.read is required');
    this.fileReader = fileReader;
  }

  async upload(artifact, { client, projectId, patchSessionId } = {}) {
    if (!client || typeof client.uploadPatch !== 'function') throw new TypeError('PatchSync client.uploadPatch is required');
    if (!nonEmptyString(projectId)) throw new TypeError('projectId is required');
    if (!nonEmptyString(patchSessionId)) throw new TypeError('patchSessionId is required');
    const readable = nonEmptyString(artifact?.content_base64) ? artifact : await this.fileReader.read(artifact);
    const receipt = await client.uploadPatch(readable);
    if (receipt?.accepted !== true) fail('PatchSync did not accept the Patch', { filename: artifact?.filename ?? null });
    if (receipt.project_id !== projectId) fail('PatchSync receipt project does not match the active Task', { expected: projectId, actual: receipt?.project_id });
    if (receipt.session_id !== patchSessionId) fail('PatchSync receipt session does not match the active Patch Session', { expected: patchSessionId, actual: receipt?.session_id });
    if (receipt.filename !== artifact?.filename) fail('PatchSync receipt filename does not match the downloaded Patch', { expected: artifact?.filename, actual: receipt?.filename });
    if (nonEmptyString(readable.sha256) && nonEmptyString(receipt.sha256) && readable.sha256.toLowerCase() !== receipt.sha256.toLowerCase()) {
      fail('PatchSync receipt SHA-256 does not match the downloaded Patch', { filename: artifact?.filename });
    }
    return { artifact: stripContent(readable), receipt };
  }
}
