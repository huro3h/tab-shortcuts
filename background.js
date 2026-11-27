import {
  tabIdsToCloseOthers,
  tabIdsToCloseRight,
  tabIdToActivateBeside,
  planMergeWindows,
  tabIdsToReloadAll,
  pickSelectedText,
  buildGoogleSearchUrl,
  DEFAULT_SETTINGS,
  resolveSettings,
} from './planner.js';

const COMMAND_CLOSE_OTHER_TABS = '01_close-other-tabs';
const COMMAND_CLOSE_RIGHT_TABS = '02_close-right-tabs';
const COMMAND_TOGGLE_PIN = '03_toggle-pin';
const COMMAND_MERGE_WINDOWS = '04_merge-windows';
const COMMAND_SEARCH_FOREGROUND = '05_search-foreground';
const COMMAND_SEARCH_BACKGROUND = '06_search-background';
const COMMAND_RELOAD_TAB = '07_reload-tab';
const COMMAND_RELOAD_ALL_TABS = '08_reload-all-tabs';
const COMMAND_TOGGLE_MUTE = '09_toggle-mute';
const COMMAND_NEXT_TAB = '10_next-tab';
const COMMAND_PREVIOUS_TAB = '11_previous-tab';
const COMMAND_NEXT_TAB_ALT = '12_next-tab-alt';
const COMMAND_PREVIOUS_TAB_ALT = '13_previous-tab-alt';

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

async function toggleMute(activeTab) {
  await chrome.tabs.update(activeTab.id, { muted: !activeTab.mutedInfo?.muted });
}

async function reloadTab(activeTab) {
  await chrome.tabs.reload(activeTab.id);
}

async function activateTabBeside(activeTab, direction) {
  const [tabs, collapsedGroups] = await Promise.all([
    chrome.tabs.query({ windowId: activeTab.windowId }),
    chrome.tabGroups.query({ windowId: activeTab.windowId, collapsed: true }),
  ]);

  const tabId = tabIdToActivateBeside(
    tabs,
    activeTab.id,
    direction,
    collapsedGroups.map((group) => group.id)
  );
  if (tabId === null) {
    return;
  }

  await chrome.tabs.update(tabId, { active: true });
}

async function mergeWindows(activeTab) {
  const targetWindowId = activeTab.windowId;

  const [windows, tabs, groups] = await Promise.all([
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
  ]);

  const plan = planMergeWindows(windows, tabs, groups, targetWindowId);

  await movePinnedTabsToWindow(plan.pinnedTabIds, targetWindowId);
  await moveGroupsToWindow(plan.groupIds, targetWindowId);
  await moveTabsToWindow(plan.plainTabIds, targetWindowId);

}

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

  const tabs = await chrome.tabs.query({ windowType: 'normal' });

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

function readSelectionFromPage() {
  return window.getSelection()?.toString() ?? '';
}

async function readSelectedText(activeTab) {
  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      injectImmediately: true,
      func: readSelectionFromPage,
    });
    return pickSelectedText(injectionResults);
  } catch (injectionBlocked) {
    console.log('[想定内] このページからは選択テキストを取得できません。', injectionBlocked.message);
    return '';
  }
}

async function loadSettings() {
  return resolveSettings(await chrome.storage.sync.get(DEFAULT_SETTINGS));
}

let clipboardQueue = Promise.resolve();

async function writeToClipboardViaOffscreen(text) {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: '選択テキスト検索の検索語をクリップボードにコピーするため',
    });
  }

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'copy-to-clipboard',
      text,
    });
    if (!response?.copied) {
      console.log('[想定内] クリップボードへのコピーが拒否されました。');
    }
  } finally {
    await chrome.offscreen.closeDocument();
  }
}

function copyToClipboard(text) {
  clipboardQueue = clipboardQueue
    .then(() => writeToClipboardViaOffscreen(text))
    .catch((error) => {
      console.error('クリップボードへのコピーに失敗しました:', error);
    });
  return clipboardQueue;
}

async function searchSelection(activeTab, openInForeground) {
  const [selectedText, settings] = await Promise.all([
    readSelectedText(activeTab),
    loadSettings(),
  ]);

  const searchUrl = buildGoogleSearchUrl(selectedText);
  if (!searchUrl) {
    return;
  }

  await chrome.tabs.create({
    url: searchUrl,
    active: openInForeground,
    index: activeTab.index + 1,
    openerTabId: activeTab.id,
    windowId: activeTab.windowId,
  });

  if (settings.copySelectionOnSearch) {
    await copyToClipboard(selectedText);
  }
}

chrome.commands.onCommand.addListener(async (command, tabFromCommand) => {
  try {
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
      case COMMAND_TOGGLE_MUTE:
        await toggleMute(activeTab);
        break;
      case COMMAND_RELOAD_TAB:
        await reloadTab(activeTab);
        break;
      case COMMAND_NEXT_TAB:
      case COMMAND_NEXT_TAB_ALT:
        await activateTabBeside(activeTab, 1);
        break;
      case COMMAND_PREVIOUS_TAB:
      case COMMAND_PREVIOUS_TAB_ALT:
        await activateTabBeside(activeTab, -1);
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
