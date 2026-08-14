export async function runLiveCalibration(tabManager, evidenceLedger = null) {
  const tab = await tabManager.findChatGptTab();
  const matrix = await tabManager.send(tab.id, { type: 'CHATGPT_CALIBRATION_MATRIX' });
  if (evidenceLedger?.record) {
    try {
      await evidenceLedger.record(matrix);
    } catch {
      // Calibration remains usable when local evidence persistence fails.
    }
  }
  return matrix;
}
