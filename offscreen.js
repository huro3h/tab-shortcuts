const clipboardField = document.getElementById('clipboard');

function writeToClipboard(text) {
  clipboardField.value = text;
  clipboardField.select();
  try {
    return document.execCommand('copy');
  } finally {
    clipboardField.value = '';
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'copy-to-clipboard') {
    return;
  }

  sendResponse({ copied: writeToClipboard(message.text) });
});
