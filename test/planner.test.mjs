// planner.js は chrome API に触れないので Node から直接読める。
// node --test test/planner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_GROUP_ID_NONE,
  tabIdsToCloseOthers,
  tabIdsToCloseRight,
  planMergeWindows,
  normalizeSelectedText,
  pickSelectedText,
  buildGoogleSearchUrl,
} from '../planner.js';

// index は配列順から自動で振る。テスト側で連番を書き間違えないようにするため。
const tabsOf = (windowId, specs) =>
  specs.map((spec, index) => ({
    id: spec.id,
    windowId,
    index,
    pinned: spec.pinned ?? false,
    groupId: spec.groupId ?? TAB_GROUP_ID_NONE,
  }));

const normalWindow = (id, over = {}) => ({
  id,
  type: 'normal',
  incognito: false,
  ...over,
});

test('tabIdsToCloseOthers: アクティブタブとピン留めタブを残す', () => {
  const tabs = tabsOf(1, [
    { id: 10, pinned: true },
    { id: 11 },
    { id: 12 },
    { id: 13 },
  ]);

  assert.deepEqual(tabIdsToCloseOthers(tabs, 12), [11, 13]);
});

test('tabIdsToCloseOthers: 閉じる相手がいなければ空', () => {
  const tabs = tabsOf(1, [{ id: 10 }]);

  assert.deepEqual(tabIdsToCloseOthers(tabs, 10), []);
});

test('tabIdsToCloseOthers: ピン留めだけが残っている場合も閉じない', () => {
  const tabs = tabsOf(1, [
    { id: 10, pinned: true },
    { id: 11, pinned: true },
    { id: 12 },
  ]);

  assert.deepEqual(tabIdsToCloseOthers(tabs, 12), []);
});

test('tabIdsToCloseRight: アクティブタブより右だけを閉じる', () => {
  const tabs = tabsOf(1, [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }]);

  assert.deepEqual(tabIdsToCloseRight(tabs, 11), [12, 13]);
});

test('tabIdsToCloseRight: 右端がアクティブなら空', () => {
  const tabs = tabsOf(1, [{ id: 10 }, { id: 11 }]);

  assert.deepEqual(tabIdsToCloseRight(tabs, 11), []);
});

test('tabIdsToCloseRight: アクティブがピン留めでも他のピン留めは閉じない', () => {
  const tabs = tabsOf(1, [
    { id: 10, pinned: true },
    { id: 11, pinned: true },
    { id: 12 },
    { id: 13 },
  ]);

  assert.deepEqual(tabIdsToCloseRight(tabs, 10), [12, 13]);
});

test('tabIdsToCloseRight: アクティブタブが見つからなければ空', () => {
  const tabs = tabsOf(1, [{ id: 10 }, { id: 11 }]);

  assert.deepEqual(tabIdsToCloseRight(tabs, 99), []);
});

test('planMergeWindows: 他ウィンドウの通常タブを集める', () => {
  const windows = [normalWindow(1), normalWindow(2)];
  const tabs = [
    ...tabsOf(1, [{ id: 10 }]),
    ...tabsOf(2, [{ id: 20 }, { id: 21 }]),
  ];

  const plan = planMergeWindows(windows, tabs, [], 1);

  assert.deepEqual(plan, {
    targetWindowId: 1,
    pinnedTabIds: [],
    groupIds: [],
    plainTabIds: [20, 21],
  });
});

test('planMergeWindows: ウィンドウが1つなら何も動かさない', () => {
  const windows = [normalWindow(1)];
  const tabs = tabsOf(1, [{ id: 10 }, { id: 11 }]);

  const plan = planMergeWindows(windows, tabs, [], 1);

  assert.deepEqual(plan.plainTabIds, []);
  assert.deepEqual(plan.pinnedTabIds, []);
  assert.deepEqual(plan.groupIds, []);
});

test('planMergeWindows: 統合先が一覧に無ければ何も動かさない', () => {
  const windows = [normalWindow(1), normalWindow(2)];
  const tabs = [...tabsOf(1, [{ id: 10 }]), ...tabsOf(2, [{ id: 20 }])];

  const plan = planMergeWindows(windows, tabs, [], 99);

  assert.deepEqual(plan.plainTabIds, []);
});

test('planMergeWindows: ポップアップウィンドウは吸い込まない', () => {
  const windows = [normalWindow(1), normalWindow(2, { type: 'popup' })];
  const tabs = [...tabsOf(1, [{ id: 10 }]), ...tabsOf(2, [{ id: 20 }])];

  const plan = planMergeWindows(windows, tabs, [], 1);

  assert.deepEqual(plan.plainTabIds, []);
});

test('planMergeWindows: シークレットが違うウィンドウは吸い込まない', () => {
  const windows = [normalWindow(1), normalWindow(2, { incognito: true })];
  const tabs = [...tabsOf(1, [{ id: 10 }]), ...tabsOf(2, [{ id: 20 }])];

  const plan = planMergeWindows(windows, tabs, [], 1);

  assert.deepEqual(plan.plainTabIds, []);
});

test('planMergeWindows: シークレット同士なら統合する', () => {
  const windows = [
    normalWindow(1, { incognito: true }),
    normalWindow(2, { incognito: true }),
    normalWindow(3),
  ];
  const tabs = [
    ...tabsOf(1, [{ id: 10 }]),
    ...tabsOf(2, [{ id: 20 }]),
    ...tabsOf(3, [{ id: 30 }]),
  ];

  const plan = planMergeWindows(windows, tabs, [], 1);

  assert.deepEqual(plan.plainTabIds, [20]);
});

test('planMergeWindows: ピン留め・グループ・通常を振り分ける', () => {
  const windows = [normalWindow(1), normalWindow(2)];
  const tabs = [
    ...tabsOf(1, [{ id: 10 }]),
    ...tabsOf(2, [
      { id: 20, pinned: true },
      { id: 21, groupId: 100 },
      { id: 22, groupId: 100 },
      { id: 23 },
    ]),
  ];
  const groups = [{ id: 100, windowId: 2 }];

  const plan = planMergeWindows(windows, tabs, groups, 1);

  assert.deepEqual(plan.pinnedTabIds, [20]);
  assert.deepEqual(plan.groupIds, [100]);
  // グループ所属タブは tabGroups.move 側で動くので、こちらには入れない
  assert.deepEqual(plan.plainTabIds, [23]);
});

test('planMergeWindows: 統合先のグループは動かさない', () => {
  const windows = [normalWindow(1), normalWindow(2)];
  const tabs = [
    ...tabsOf(1, [{ id: 10, groupId: 100 }]),
    ...tabsOf(2, [{ id: 20, groupId: 200 }]),
  ];
  const groups = [
    { id: 100, windowId: 1 },
    { id: 200, windowId: 2 },
  ];

  const plan = planMergeWindows(windows, tabs, groups, 1);

  assert.deepEqual(plan.groupIds, [200]);
});

test('planMergeWindows: ウィンドウ順 → タブ順で並べる', () => {
  const windows = [normalWindow(1), normalWindow(2), normalWindow(3)];
  const tabs = [
    ...tabsOf(3, [{ id: 30 }, { id: 31 }]),
    ...tabsOf(2, [{ id: 20 }, { id: 21 }]),
    ...tabsOf(1, [{ id: 10 }]),
  ];

  const plan = planMergeWindows(windows, tabs, [], 1);

  // tabs 配列の順ではなく windows 配列の順 (2 → 3) に揃う
  assert.deepEqual(plan.plainTabIds, [20, 21, 30, 31]);
});

test('normalizeSelectedText: 改行を消さずにスペースへ畳む', () => {
  assert.equal(normalizeSelectedText('foo\nbar'), 'foo bar');
  assert.equal(normalizeSelectedText('foo\r\n\tbar   baz'), 'foo bar baz');
});

test('normalizeSelectedText: 前後の空白を落とす', () => {
  assert.equal(normalizeSelectedText('  hello  '), 'hello');
  assert.equal(normalizeSelectedText('   '), '');
});

test('normalizeSelectedText: 文字列以外は空として扱う', () => {
  assert.equal(normalizeSelectedText(undefined), '');
  assert.equal(normalizeSelectedText(null), '');
});

test('pickSelectedText: 中身のある最初のフレームを採用する', () => {
  const results = [
    { result: '' },
    { result: '   ' },
    { result: 'iframe の選択' },
    { result: 'その次' },
  ];

  assert.equal(pickSelectedText(results), 'iframe の選択');
});

test('pickSelectedText: どのフレームにも選択が無ければ空', () => {
  assert.equal(pickSelectedText([{ result: '' }, { result: '\n' }]), '');
  assert.equal(pickSelectedText([]), '');
  assert.equal(pickSelectedText(undefined), '');
});

test('buildGoogleSearchUrl: 検索語をエンコードして組み立てる', () => {
  assert.equal(
    buildGoogleSearchUrl('hello world'),
    'https://www.google.com/search?q=hello%20world'
  );
  assert.equal(
    buildGoogleSearchUrl('C++ & Rust'),
    'https://www.google.com/search?q=C%2B%2B%20%26%20Rust'
  );
});

test('buildGoogleSearchUrl: 選択が空なら null (空検索タブを開かない)', () => {
  assert.equal(buildGoogleSearchUrl(''), null);
  assert.equal(buildGoogleSearchUrl('  \n  '), null);
  assert.equal(buildGoogleSearchUrl(undefined), null);
});
