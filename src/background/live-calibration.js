import { RunnerError, ERROR_CODES } from '../shared/errors.js';
export async function runLiveCalibration(tabManager, evidenceLedger = null) {
  const tab = await tabManager.findChatGptTab();
  const matrix = await tabManager.send(tab.id, { type: 'CHATGPT_CALIBRATION_MATRIX' });
  if (matrix?.ok === false) {
    throw new RunnerError(matrix.error?.code ?? ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, matrix.error?.message ?? 'ChatGPT calibration failed', matrix.error);
  }
  if (evidenceLedger?.record) {
    try {
      await evidenceLedger.record(matrix);
    } catch {
      // Calibration remains usable when local evidence persistence fails.
    }
  }
  return matrix;
}
