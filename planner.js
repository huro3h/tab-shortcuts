// chrome API に触れない純粋関数だけを置く。ここに判断を寄せることで Node から直接テストできる。
// background.js は「ここが決めた結果を実行するだけ」に保つ。

// chrome.tabGroups.TAB_GROUP_ID_NONE と同値。service worker 以外からも参照するため定数で持つ。
export const TAB_GROUP_ID_NONE = -1;

/**
 * 「他のタブを閉じる」の対象。アクティブタブとピン留めタブは残す。
 * @param {Array<{id:number, pinned:boolean}>} tabs 対象ウィンドウのタブ
 * @param {number} activeTabId
 * @returns {number[]}
 */
export function tabIdsToCloseOthers(tabs, activeTabId) {
  return tabs
    .filter((tab) => tab.id !== activeTabId && !tab.pinned)
    .map((tab) => tab.id);
}

/**
 * 「右のタブを閉じる」の対象。アクティブタブより右にある非ピン留めタブ。
 *
 * ピン留めは常にタブバーの左端に寄るので、通常はアクティブタブより右に来ない。
 * ただしアクティブタブ自身がピン留めのときは右側すべてが対象になりうるため、
 * 「残す」判断は index ではなく pinned で行う (Chrome 本体と同じ挙動)。
 *
 * @param {Array<{id:number, index:number, pinned:boolean}>} tabs 対象ウィンドウのタブ
 * @param {number} activeTabId
 * @returns {number[]}
 */
export function tabIdsToCloseRight(tabs, activeTabId) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab) {
    return [];
  }

  return tabs
    .filter((tab) => tab.index > activeTab.index && !tab.pinned)
    .map((tab) => tab.id);
}

/**
 * 統合の対象にしてよいウィンドウか。
 *
 * - `normal` 以外 … window.open() で切り出されたポップアップやアプリウィンドウを吸い込まない
 * - シークレットの不一致 … 通常⇔シークレットのタブ移動は API 自体が失敗する
 * - 統合先自身 … 動かす必要がない
 */
function isMergeableWindow(win, targetWindow) {
  return (
    win.id !== targetWindow.id &&
    win.type === 'normal' &&
    win.incognito === targetWindow.incognito
  );
}

/**
 * 「すべてのウィンドウを現在のウィンドウに統合」の移動計画を立てる。
 *
 * ピン留め / タブグループ / 通常タブ を分けて返すのは、それぞれ移動手段が違うため。
 * 特にグループは、所属タブを tabs.move で個別に動かすと解体されてしまうので、
 * 実行側で tabGroups.move を使い分ける必要がある (SKILL.md 参照)。
 *
 * @param {Array<{id:number, type:string, incognito:boolean}>} windows
 * @param {Array<{id:number, windowId:number, index:number, pinned:boolean, groupId:number}>} tabs
 * @param {Array<{id:number, windowId:number}>} groups
 * @param {number} targetWindowId
 * @returns {{targetWindowId:number, pinnedTabIds:number[], groupIds:number[], plainTabIds:number[]}}
 */
export function planMergeWindows(windows, tabs, groups, targetWindowId) {
  const emptyPlan = {
    targetWindowId,
    pinnedTabIds: [],
    groupIds: [],
    plainTabIds: [],
  };

  const targetWindow = windows.find((win) => win.id === targetWindowId);
  if (!targetWindow) {
    return emptyPlan;
  }

  const sourceWindowIds = windows
    .filter((win) => isMergeableWindow(win, targetWindow))
    .map((win) => win.id);
  if (sourceWindowIds.length === 0) {
    return emptyPlan;
  }

  // 元のウィンドウの並び順 → ウィンドウ内のタブ順、で移動する。統合後の並びを予測可能にするため。
  const windowOrder = new Map(sourceWindowIds.map((id, order) => [id, order]));
  const sourceTabs = tabs
    .filter((tab) => windowOrder.has(tab.windowId))
    .sort((a, b) => {
      const byWindow = windowOrder.get(a.windowId) - windowOrder.get(b.windowId);
      return byWindow !== 0 ? byWindow : a.index - b.index;
    });

  // Chrome ではピン留めタブをグループに入れられないので、この2つは排他になる。
  const pinnedTabIds = sourceTabs
    .filter((tab) => tab.pinned)
    .map((tab) => tab.id);

  const groupIds = groups
    .filter((group) => windowOrder.has(group.windowId))
    .sort((a, b) => windowOrder.get(a.windowId) - windowOrder.get(b.windowId))
    .map((group) => group.id);

  const plainTabIds = sourceTabs
    .filter((tab) => !tab.pinned && tab.groupId === TAB_GROUP_ID_NONE)
    .map((tab) => tab.id);

  return { targetWindowId, pinnedTabIds, groupIds, plainTabIds };
}

const GOOGLE_SEARCH_BASE_URL = 'https://www.google.com/search?q=';

/**
 * ページから取った選択テキストを検索語に整える。
 *
 * 改行だけを消すと単語が繋がってしまう (「foo\nbar」→「foobar」) ので、
 * 改行もタブも連続空白もまとめて半角スペース1つに畳んでから前後を落とす。
 *
 * @param {string} rawSelection
 * @returns {string}
 */
export function normalizeSelectedText(rawSelection) {
  if (typeof rawSelection !== 'string') {
    return '';
  }

  return rawSelection.replace(/\s+/g, ' ').trim();
}

/**
 * 複数フレームから返ってきた選択テキストのうち、最初に中身のあるものを選ぶ。
 * allFrames で拾うと、選択のないフレームからも空文字が返ってくるため。
 *
 * @param {Array<{result?: string}>} injectionResults
 * @returns {string}
 */
export function pickSelectedText(injectionResults) {
  if (!Array.isArray(injectionResults)) {
    return '';
  }

  for (const injectionResult of injectionResults) {
    const text = normalizeSelectedText(injectionResult?.result);
    if (text !== '') {
      return text;
    }
  }

  return '';
}

/**
 * Google の検索 URL を組み立てる。検索語が空なら null を返し、
 * 呼び出し側が「タブを開かない」を選べるようにする
 * (元にした拡張は空選択でも `?q=` の空検索タブを開いてしまっていた)。
 *
 * @param {string} searchText
 * @returns {string|null}
 */
export function buildGoogleSearchUrl(searchText) {
  const normalized = normalizeSelectedText(searchText);
  if (normalized === '') {
    return null;
  }

  return GOOGLE_SEARCH_BASE_URL + encodeURIComponent(normalized);
}
