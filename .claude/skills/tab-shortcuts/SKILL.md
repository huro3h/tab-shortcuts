---
name: tab-shortcuts
description: Tab Shortcuts (タブ操作と選択テキスト検索にショートカットを与える Chrome 拡張) を改修・デバッグするときに使う。commands API の制約、統合処理でタブグループを壊さない理由、却下した実装案、実機での確認手順を記録している。
---

# Tab Shortcuts 開発メモ

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | MV3。コマンド定義がこの拡張の仕様そのものなので、まずここを読む |
| `planner.js` | **chrome API に触れない純粋関数だけ**。何を閉じ、何を動かし、何を検索するかを決める |
| `background.js` | service worker。`planner.js` が決めた結果を chrome API で実行するだけの薄い層 |
| `test/planner.test.mjs` | `node --test test/planner.test.mjs`。Chrome を起動せずロジックを検証する |
| `icons/icon.svg` | アイコンの原本。キーキャップ + シェブロンの線画1枚。PNG はここから書き出す |

判断を `planner.js` に寄せているのは `stray-tab-closer/rules.js` と同じ考え方。
**新しいコマンドを足すときも、分岐や条件は `planner.js` に書いてテストを付ける**こと。
`background.js` に条件分岐を増やすとテストできない領域が広がる。

## commands API の制約 (ここを踏み外すと無言で壊れる)

### コマンド名の `01_` 〜 `06_` プレフィックスは必須

`chrome://extensions/shortcuts` の表示順は **manifest の記述順でも `description` 順でもなく
キー名のソート順**で決まる。プレフィックスを外すと `01_close-other-tabs` が
`06_search-background` より後に並ぶ、といった意図しない順序になる
(`yt-quick-filter` で踏んだ落とし穴)。コマンドを追加するときは連番を続けること。

### `suggested_key` は拡張あたり最大4つ

コマンド数の上限ではなく、**プリセットを付けられるコマンド数**の上限。
5つ目を書くと Chrome の manifest 検証で弾かれる。現在の割り当て:

| コマンド | プリセット |
| --- | --- |
| `01_close-other-tabs` | `Alt+Shift+O` |
| `02_close-right-tabs` | `Alt+Shift+R` |
| `03_toggle-pin` | `Alt+Shift+P` |
| `05_search-foreground` | `Alt+S` |
| `04_merge-windows` / `06_search-background` | なし (枠が尽きたため) |

### この拡張は「プリセットを付けない」方針の例外

ワークスペースの通常方針は **`suggested_key` を付けない**
(他拡張と衝突し、衝突すると無言で割り当てが入らないため。`zoom_all_tabs` は全コマンド未割り当て)。
この拡張だけ例外にしているのは、**既存拡張から同じ指の動きを引き継ぐ**ため:

- `⌥⇧O` / `⌥⇧R` / `⌥⇧P` … Keyboard Shortcuts to Close Other/Right Tabs (`dkoadhojigekhckndaehenfbhcgfeepl`)
- `⌥S` … Shortcut keys for selection search (`emceciddhgnjkmjmpjoahmdhibmifohp`)

**移行元の拡張を先にアンインストールしないとプリセットは入らない。**
Chrome は重複を許さず、しかもエラーを出さずに割り当てを空のままにする。
README のインストール手順にこの順序を書いてあるのは、それが原因の「動かない」を防ぐため。

## 中心にある設計判断

### 統合でタブグループを解体しない

タブグループは**ウィンドウ単位の概念**なので、グループ所属タブを `chrome.tabs.move()` で
別ウィンドウへ動かすと**グループから外れて解体される**。グループを保ったまま移すには
`chrome.tabGroups.move(groupId, { windowId })` を使う必要がある。

そのため `planMergeWindows()` は移動対象を3つに分けて返す:

1. `pinnedTabIds` … ピン留めタブ。移動後にピン留めを付け直す (下記)
2. `groupIds` … グループ。`tabGroups.move` で丸ごと動かす
3. `plainTabIds` … どちらでもない通常タブ。最後に末尾へ積む

Chrome ではピン留めタブをグループに入れられないので、1 と 2 は排他になる。

### `tabs.move` はウィンドウを跨ぐとピン留めを落とす

**実機で確認して分かった挙動**。`chrome.tabs.move(id, { windowId: 別ウィンドウ })` すると、
ピン留めタブは移動先で**ピン留めが外れた普通のタブになる**。ドキュメントに明記がなく、
当初は「ピン留め状態は維持されて配置だけ強制される」と想定していたが誤りだった。

`movePinnedTabsToWindow()` が移動後に `chrome.tabs.update(id, { pinned: true })` で
付け直しているのはこのため。**この2行を「冗長だ」と思って消さないこと。**
付け直すとタブは自動でピン留め領域 (タブバー左端) へ寄るので、位置の調整は要らない。

一方 `chrome.tabGroups.move()` はグループ名・色・所属タブをすべて保つ (これも実機で確認済み)。

### 統合から除外するもの

| 対象 | 理由 |
| --- | --- |
| `windowType !== "normal"` | `window.open()` で切り出されたポップアップを吸い込まない |
| シークレットが統合先と異なるウィンドウ | この境界を越えるタブ移動は API 自体が失敗する |
| 統合先ウィンドウ自身 | 動かす必要がない |

移動順は「元のウィンドウの並び順 → ウィンドウ内のタブ順」に固定している。
`chrome.tabs.query({})` が返す順に依存させると統合後の並びが予測できなくなるため。

### ピン留めタブは閉じる対象から常に外す

`tabIdsToCloseOthers` / `tabIdsToCloseRight` のどちらも `pinned` で足切りする。
Chrome 本体の右クリックメニューと同じ挙動で、`pinned-tab-lock` を作っている方針とも揃う。

`tabIdsToCloseRight` で「残す」判断を index ではなく `pinned` でやっているのは、
**アクティブタブ自身がピン留めのとき**に右側すべてが対象になりうるため。
通常はピン留めが左端に寄るのでこの差は現れないが、条件としては別物。

### 検索は activeTab + scripting で撮る

`chrome.commands` のショートカット実行は **activeTab を付与する user gesture** として
公式に認められている。そのためホスト権限 (`<all_urls>` など) を一切持たずに、
押した瞬間のアクティブタブにだけ `chrome.scripting.executeScript` で注入できる。
`activeTab` も `scripting` もインストール時の権限警告を出さない。

`chrome.search.query()` を使わなかった理由: `disposition` が `CURRENT_TAB` /
`NEW_TAB` / `NEW_WINDOW` の3つしかなく、**背面タブで開く指定ができない**。
前面/背面の出し分けが要件なので、`chrome.tabs.create({ active })` を自前で呼んでいる。
その代償として検索エンジンは Google 固定になる (デフォルト検索エンジンには追従しない)。

### 元にした拡張から直した点

Shortcut keys for selection search (`emceciddhgnjkmjmpjoahmdhibmifohp`) の実装を読んで、
次の4点を変えている。挙動を戻したくなったときの判断材料として残す:

| 元の挙動 | この拡張 |
| --- | --- |
| 選択が空でも `?q=` の空検索タブを開く | `buildGoogleSearchUrl()` が `null` を返し、タブを開かない |
| `allFrames: false` で iframe 内の選択を取れない | `allFrames: true` + `pickSelectedText()` で最初に中身のあるフレームを採用 |
| 改行だけ除去するので `foo\nbar` が `foobar` になる | `normalizeSelectedText()` が連続空白ごとスペース1つに畳む |
| `index` / `openerTabId` 未指定でタブバー末尾に開き、閉じても元タブに戻らない | 元タブの隣に開き、`openerTabId` で戻れるようにする |

Keyboard Shortcuts to Close Other/Right Tabs (`dkoadhojigekhckndaehenfbhcgfeepl`) は
`tabGroups` 権限を宣言しながら一切使っていなかった。**使わない権限は宣言しない**。

## 実機での確認手順

ロジックは `node --test` で見られるが、以下は実ブラウザでしか確認できない。

### Playwright で自動化する場合の注意

ワークスペース共通の `browser-testing` skill どおり Playwright + Brave Nightly で
未パッケージ拡張として読み込めるが、この拡張特有のハマりどころが2つある。

1. **service worker では動的 `import()` が使えない** (HTML 仕様で禁止)。
   `sw.evaluate()` の中から `import('./planner.js')` はできないので、
   planner.js は Node 側で `await import()` して読み、計画だけを `sw.evaluate` に渡す。
2. **`activeTab` はテストから発動できない**。ショートカット押下という user gesture が
   要るが、Playwright のキー送出は renderer 止まりでブラウザ UI 層のコマンドを起こせない。
   gesture 無しで `executeScript` すると
   `Cannot access contents of url ... must request permission` で拒否される
   (これ自体は仕様どおりの正しい挙動)。注入経路を試すときは、
   **scratchpad に拡張をコピーして `host_permissions: ["<all_urls>"]` を足したものを読み込む**。
   プロジェクト本体に権限を足して戻し忘れる事故を避けるため、必ずコピー側でやること。

### 手で確認する場合

`chrome://extensions` から未パッケージ拡張として読み込んで確認する。

1. `chrome://extensions/shortcuts` で `⌥⇧O` / `⌥⇧R` / `⌥⇧P` / `⌥S` が入っていること、
   `04_merge-windows` と `06_search-background` が空欄であること
2. ピン留めタブを含むウィンドウで「他を閉じる」「右を閉じる」 → ピン留めが残る
3. **統合**: 3ウィンドウ (うち1つにタブグループ、1つにピン留め) を作って実行
   → グループが解体されていないか、ピン留めがピン留めのまま入るか、
   アクティブタブが変わっていないか
4. シークレットウィンドウを開いた状態で統合 → 吸い込まれないこと
5. 検索: 通常ページ / iframe 内 / 選択なし / `chrome://` の4パターン
   (`chrome://` では無反応が正しい。service worker のログに「[想定内]」が出る)

service worker のログは `chrome://extensions` の「Service Worker」リンクから見る。
`[想定内]` プレフィックスのログは握りつぶした例外で、エラーではない。

## バージョン運用

`CHANGELOG.md` (Keep a Changelog + SemVer)。ユーザー向けの変更を入れるたびに
`[Unreleased]` へ1行足す。リリース時は `manifest.json` の `version` を同じ番号に上げ、
注釈付きタグを `v` なしの数字だけ (`1.1.0`) で打って `git push origin 1.1.0`。
