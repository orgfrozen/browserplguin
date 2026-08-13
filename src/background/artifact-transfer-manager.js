import { RunnerError, ERROR_CODES } from '../shared/errors.js';

export class ArtifactTransferManager {
  constructor({ mode = 'local', remoteTransport = null } = {}) {
    this.mode = mode;
    this.remoteTransport = remoteTransport;
  }

  async transfer(artifact) {
    if (this.mode === 'local') return { mode: 'local', artifact };
    if (this.mode === 'remote' && this.remoteTransport) {
      return { mode: 'remote', remote: await this.remoteTransport.upload(artifact), artifact };
    }
    throw new RunnerError(
      ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED,
      'Remote artifact transfer requires a configured transport or Native Helper',
      { filename: artifact?.filename }
    );
  }
}
