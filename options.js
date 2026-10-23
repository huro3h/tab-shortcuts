// 項目がチェックボックス1つなので、保存ボタンは置かず変更した瞬間に保存する。
import { DEFAULT_SETTINGS, resolveSettings } from './planner.js';

const copySelectionOnSearch = document.getElementById('copySelectionOnSearch');
const status = document.getElementById('status');

let statusTimer;

function showStatus(message) {
  status.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ''), 1800);
}

async function load() {
  const settings = resolveSettings(await chrome.storage.sync.get(DEFAULT_SETTINGS));
  copySelectionOnSearch.checked = settings.copySelectionOnSearch;
}

copySelectionOnSearch.addEventListener('change', async () => {
  await chrome.storage.sync.set({
    copySelectionOnSearch: copySelectionOnSearch.checked,
  });
  showStatus('保存しました');
});

load();
