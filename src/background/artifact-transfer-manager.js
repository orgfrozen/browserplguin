import { RunnerError, ERROR_CODES } from '../shared/errors.js';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stripTransferContent(artifact) {
  const { content_base64: _contentBase64, content_bytes: _contentBytes, ...metadata } = artifact ?? {};
  return metadata;
}

function localReceipt(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Completed Patch artifact is required for local transfer');
  }
  if (!Number.isInteger(artifact.download_id) || artifact.download_id < 0) {
    throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Completed Patch download id is required for local transfer', { filename: artifact.filename ?? null });
  }
  if (!nonEmptyString(artifact.filename)) {
    throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Completed Patch filename is required for local transfer');
  }
  if (!nonEmptyString(artifact.local_path)) {
    throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Completed Patch local path is required for local transfer', { filename: artifact.filename });
  }
  return {
    download_id: artifact.download_id,
    filename: artifact.filename,
    local_path: artifact.local_path,
    source_url: artifact.source_url ?? null
  };
}

export class ArtifactTransferManager {
  constructor({ mode = 'local', remoteTransport = null, remoteFileReader = null, patchSyncTransport = null } = {}) {
    this.mode = mode;
    this.remoteTransport = remoteTransport;
    this.remoteFileReader = remoteFileReader;
    this.patchSyncTransport = patchSyncTransport;
  }

  async transfer(artifact, context = {}) {
    if (context.patchSyncClient && this.patchSyncTransport) {
      const submitted = await this.patchSyncTransport.upload(artifact, {
        client: context.patchSyncClient,
        projectId: context.projectId,
        patchSessionId: context.patchSessionId
      });
      return { mode: 'patchsync', artifact: submitted.artifact, receipt: submitted.receipt };
    }
    if (this.mode === 'local') {
      return { mode: 'local', artifact, receipt: localReceipt(artifact) };
    }
    if (this.mode === 'remote' && this.remoteTransport) {
      const uploadArtifact = !nonEmptyString(artifact?.content_base64) && this.remoteFileReader
        ? await this.remoteFileReader.read(artifact)
        : artifact;
      const remote = await this.remoteTransport.upload(uploadArtifact);
      return { mode: 'remote', remote, receipt: remote, artifact: stripTransferContent(uploadArtifact) };
    }
    throw new RunnerError(
      ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED,
      'Remote artifact transfer requires a configured transport or Native Helper',
      { filename: artifact?.filename }
    );
  }
}
