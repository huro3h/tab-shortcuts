export const TAB_GROUP_ID_NONE = -1;

export function tabIdsToCloseOthers(tabs, activeTabId) {
  return tabs
    .filter((tab) => tab.id !== activeTabId && !tab.pinned)
    .map((tab) => tab.id);
}

export function tabIdsToCloseRight(tabs, activeTabId) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab) {
    return [];
  }

  return tabs
    .filter((tab) => tab.index > activeTab.index && !tab.pinned)
    .map((tab) => tab.id);
}

export function tabIdToActivateBeside(tabs, activeTabId, direction, collapsedGroupIds = []) {
  const collapsed = new Set(collapsedGroupIds);
  const candidates = tabs
    .filter((tab) => tab.id === activeTabId || !collapsed.has(tab.groupId))
    .sort((a, b) => a.index - b.index);

  const activePosition = candidates.findIndex((tab) => tab.id === activeTabId);
  if (activePosition === -1 || candidates.length < 2) {
    return null;
  }

  const nextPosition =
    (activePosition + direction + candidates.length) % candidates.length;
  return candidates[nextPosition].id;
}

function isMergeableWindow(win, targetWindow) {
  return (
    win.id !== targetWindow.id &&
    win.type === 'normal' &&
    win.incognito === targetWindow.incognito
  );
}

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

  const windowOrder = new Map(sourceWindowIds.map((id, order) => [id, order]));
  const sourceTabs = tabs
    .filter((tab) => windowOrder.has(tab.windowId))
    .sort((a, b) => {
      const byWindow = windowOrder.get(a.windowId) - windowOrder.get(b.windowId);
      return byWindow !== 0 ? byWindow : a.index - b.index;
    });

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

export function tabIdsToReloadAll(tabs, incognito = false) {
  return tabs
    .filter((tab) => !tab.discarded && Boolean(tab.incognito) === incognito)
    .map((tab) => tab.id);
}

const GOOGLE_SEARCH_BASE_URL = 'https://www.google.com/search?q=';

export function normalizeSelectedText(rawSelection) {
  if (typeof rawSelection !== 'string') {
    return '';
  }

  return rawSelection.replace(/\s+/g, ' ').trim();
}

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

export function buildGoogleSearchUrl(searchText) {
  const normalized = normalizeSelectedText(searchText);
  if (normalized === '') {
    return null;
  }

  return GOOGLE_SEARCH_BASE_URL + encodeURIComponent(normalized);
}

export const DEFAULT_SETTINGS = Object.freeze({
  copySelectionOnSearch: true,
});

export function resolveSettings(stored) {
  const copySelectionOnSearch = stored?.copySelectionOnSearch;

  return {
    copySelectionOnSearch:
      typeof copySelectionOnSearch === 'boolean'
        ? copySelectionOnSearch
        : DEFAULT_SETTINGS.copySelectionOnSearch,
  };
}
