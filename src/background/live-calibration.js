export async function runLiveCalibration(tabManager) {
  const tab = await tabManager.findChatGptTab();
  return tabManager.send(tab.id, { type: 'CHATGPT_CALIBRATION_MATRIX' });
}
