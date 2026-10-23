// offscreen ドキュメント。service worker から頼まれた文字列をクリップボードに書くだけ。
// navigator.clipboard.writeText は文書にフォーカスが要り、offscreen ドキュメントは
// フォーカスを持てないので失敗する。そのため execCommand('copy') を使う
// (Chrome 公式サンプル cookbook.offscreen-clipboard-write と同じ方法)。

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
  // オプション画面など他の拡張ページ宛てのメッセージには反応しない
  if (message?.target !== 'offscreen' || message.type !== 'copy-to-clipboard') {
    return;
  }

  sendResponse({ copied: writeToClipboard(message.text) });
});
