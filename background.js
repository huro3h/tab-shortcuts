// service worker。chrome API の呼び出しだけを担当し、「何を閉じるか / 何を動かすか」の判断は
// planner.js に任せる。コマンド名の 01_ 〜 07_ は chrome://extensions/shortcuts の表示順を
// 決めるためのもので、意味がある (SKILL.md 参照)。
import {
  tabIdsToCloseOthers,
  tabIdsToCloseRight,
  planMergeWindows,
  tabIdsToReloadAll,
  pickSelectedText,
  buildGoogleSearchUrl,
} from './planner.js';

const COMMAND_CLOSE_OTHER_TABS = '01_close-other-tabs';
const COMMAND_CLOSE_RIGHT_TABS = '02_close-right-tabs';
const COMMAND_TOGGLE_PIN = '03_toggle-pin';
const COMMAND_MERGE_WINDOWS = '04_merge-windows';
const COMMAND_SEARCH_FOREGROUND = '05_search-foreground';
const COMMAND_SEARCH_BACKGROUND = '06_search-background';
const COMMAND_RELOAD_ALL_TABS = '07_reload-all-tabs';

// onCommand はコマンド発火時のアクティブタブを第2引数でくれる。
// 取れなかったときだけ、最後にフォーカスされたウィンドウから引き直す。
async function resolveActiveTab(tabFromCommand) {
  if (tabFromCommand?.id !== undefined) {
    return tabFromCommand;
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return activeTab;
}

async function closeTabs(tabIds) {
  if (tabIds.length === 0) {
    return;
  }

  try {
    await chrome.tabs.remove(tabIds);
  } catch (tabClosedBeforeRemove) {
    console.log('[想定内] 閉じる前に無くなったタブがありました。');
  }
}

// まとめて動かすのが速く順序も保たれるが、途中で閉じられたタブが1つでもあると
// 呼び出し全体が失敗する。そのときだけ1つずつに切り替えて、残りを動かし切る。
async function moveTabsToWindow(tabIds, windowId) {
  if (tabIds.length === 0) {
    return;
  }

  try {
    await chrome.tabs.move(tabIds, { windowId, index: -1 });
  } catch (bulkMoveFailed) {
    for (const tabId of tabIds) {
      try {
        await chrome.tabs.move(tabId, { windowId, index: -1 });
      } catch (tabUnavailable) {
        console.log(`[想定内] タブ(ID: ${tabId}) を移動できませんでした。`);
      }
    }
  }
}

// tabs.move はウィンドウを跨ぐとピン留めを落とす (実機で確認済み) ので、移動後に付け直す。
// 付け直すとタブは自動でピン留め領域 (タブバー左端) へ寄る。
async function movePinnedTabsToWindow(tabIds, windowId) {
  if (tabIds.length === 0) {
    return;
  }

  await moveTabsToWindow(tabIds, windowId);

  for (const tabId of tabIds) {
    try {
      await chrome.tabs.update(tabId, { pinned: true });
    } catch (tabUnavailable) {
      console.log(`[想定内] タブ(ID: ${tabId}) をピン留めし直せませんでした。`);
    }
  }
}

// グループ所属タブを tabs.move で個別に動かすとグループが解体されるため、
// グループごと動かすこちらを使う。
async function moveGroupsToWindow(groupIds, windowId) {
  for (const groupId of groupIds) {
    try {
      await chrome.tabGroups.move(groupId, { windowId, index: -1 });
    } catch (groupUnavailable) {
      console.log(`[想定内] グループ(ID: ${groupId}) を移動できませんでした。`);
    }
  }
}

async function closeOtherTabs(activeTab) {
  const tabs = await chrome.tabs.query({ windowId: activeTab.windowId });
  await closeTabs(tabIdsToCloseOthers(tabs, activeTab.id));
}

async function closeRightTabs(activeTab) {
  const tabs = await chrome.tabs.query({ windowId: activeTab.windowId });
  await closeTabs(tabIdsToCloseRight(tabs, activeTab.id));
}

async function togglePin(activeTab) {
  await chrome.tabs.update(activeTab.id, { pinned: !activeTab.pinned });
}

async function mergeWindows(activeTab) {
  const targetWindowId = activeTab.windowId;

  const [windows, tabs, groups] = await Promise.all([
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
  ]);

  const plan = planMergeWindows(windows, tabs, groups, targetWindowId);

  // ピン留め → グループ → 通常タブ の順。ピン留めは付け直した時点でタブバー左端へ
  // 寄るので、先に片付けておくと後続の index: -1 が素直に末尾へ積める。
  await movePinnedTabsToWindow(plan.pinnedTabIds, targetWindowId);
  await moveGroupsToWindow(plan.groupIds, targetWindowId);
  await moveTabsToWindow(plan.plainTabIds, targetWindowId);

  // タブが全部抜けたウィンドウは Chrome が自動で閉じるので、こちらから閉じる処理は持たない。
}

// 発動元がシークレットかどうか。アクティブタブが取れないときもコマンド自体は
// 動かしたいので、ここでは諦めずウィンドウから引き、それも駄目なら通常側とみなす。
async function resolveIncognitoContext(tabFromCommand) {
  if (typeof tabFromCommand?.incognito === 'boolean') {
    return tabFromCommand.incognito;
  }

  try {
    const lastFocusedWindow = await chrome.windows.getLastFocused();
    return lastFocusedWindow.incognito === true;
  } catch (noWindow) {
    return false;
  }
}

async function reloadAllTabs(tabFromCommand) {
  const incognito = await resolveIncognitoContext(tabFromCommand);

  // windowType を normal に絞って、window.open() で開かれた OAuth や決済のポップアップと、
  // インストール済み PWA のアプリウィンドウを踏み潰さないようにする。
  const tabs = await chrome.tabs.query({ windowType: 'normal' });

  // 全件を並列で投げる。Chrome 側のローダが流量を制御するので、こちらで小分けにすると
  // 遅くなるだけだった (200タブの実測: 全並列は発行480ms/完了750ms、10件ずつのバッチは
  // 発行6.7s/完了1.25s)。「reload() が即座に解決するから」ではなく、この実測が根拠。
  await Promise.all(
    tabIdsToReloadAll(tabs, incognito).map(async (tabId) => {
      try {
        await chrome.tabs.reload(tabId);
      } catch (tabUnavailable) {
        console.log(`[想定内] タブ(ID: ${tabId}) をリロードできませんでした。`);
      }
    })
  );
}

// ページのコンテキストで動く。executeScript に渡すため外部を参照しない自己完結した関数にする。
function readSelectionFromPage() {
  return window.getSelection()?.toString() ?? '';
}

// activeTab 権限はショートカット実行という user gesture で一時的に与えられるので、
// ホスト権限を持たなくてもアクティブタブにだけは注入できる。
async function readSelectedText(activeTab) {
  try {
    const injectionResults = await chrome.scripting.executeScript({
      // iframe 内の選択も拾う。フレームごとに結果が返るので pickSelectedText で絞る。
      target: { tabId: activeTab.id, allFrames: true },
      func: readSelectionFromPage,
    });
    return pickSelectedText(injectionResults);
  } catch (injectionBlocked) {
    // chrome:// / Chrome ウェブストア / PDF ビューア など、拡張が注入できないページ
    console.log('[想定内] このページからは選択テキストを取得できません。');
    return '';
  }
}

async function searchSelection(activeTab, openInForeground) {
  const searchUrl = buildGoogleSearchUrl(await readSelectedText(activeTab));
  if (!searchUrl) {
    // 何も選択されていないときに空の検索タブを開かない
    return;
  }

  await chrome.tabs.create({
    url: searchUrl,
    active: openInForeground,
    // 元のタブの隣に開き、閉じたときに元のタブへ戻れるようにする
    index: activeTab.index + 1,
    openerTabId: activeTab.id,
    windowId: activeTab.windowId,
  });
}

chrome.commands.onCommand.addListener(async (command, tabFromCommand) => {
  try {
    // 一括リロードだけはアクティブタブに依存しないので、先に片付ける。
    // 切り離した DevTools にフォーカスがあるなど、アクティブタブが取れない状況でも
    // 動かしたいため、下の resolveActiveTab の門をくぐらせない。
    if (command === COMMAND_RELOAD_ALL_TABS) {
      await reloadAllTabs(tabFromCommand);
      return;
    }

    const activeTab = await resolveActiveTab(tabFromCommand);
    if (!activeTab) {
      return;
    }

    switch (command) {
      case COMMAND_CLOSE_OTHER_TABS:
        await closeOtherTabs(activeTab);
        break;
      case COMMAND_CLOSE_RIGHT_TABS:
        await closeRightTabs(activeTab);
        break;
      case COMMAND_TOGGLE_PIN:
        await togglePin(activeTab);
        break;
      case COMMAND_MERGE_WINDOWS:
        await mergeWindows(activeTab);
        break;
      case COMMAND_SEARCH_FOREGROUND:
        await searchSelection(activeTab, true);
        break;
      case COMMAND_SEARCH_BACKGROUND:
        await searchSelection(activeTab, false);
        break;
    }
  } catch (error) {
    console.error(`コマンド "${command}" の処理に失敗しました:`, error);
  }
});
