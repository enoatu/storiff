# storiff データ契約

storiff.js(Node単一ファイル)とビューア、skill が共有する契約。

## 用語
- 変更ID: 差分中の変更行(add/del)に振る通し番号。1始まり、差分の出現順。context行にはIDなし
- step: 紙芝居の1コマ。意図・ビジネスロジック単位でClaudeが変更IDをまとめたもの

## storiff.js の使い方
- `node storiff.js check <dir>` : `steps.json` を展開して不変条件を検算し、抜けID・重複ID・不明ファイルを表示する。ok なら何も無い。serve する前の自己確認に使う
- `node storiff.js merge <dir>` : `<dir>/notes-<order>.json`(並列で作った各stepの narration と file_notes)を steps.json に反映する。owns と owns_files は変えない。story作成を骨組みと詳細の並列に分けるときに使う
- `node storiff.js prep <dir> [--repo P [範囲]]...` : `git diff`(作業差分)を解析し `<dir>/changes.json` と `<dir>/changes.txt` と `<dir>/files.txt` を書き出す。`--repo` を複数渡すと、そのリポジトリすべての差分を1つにまとめて変更IDを通し番号にする。`--repo <path>` の直後に範囲(`main...HEAD` など)を書くと、そのリポジトリだけ別の範囲になる。ベースが違うリポジトリ(submodule など)を混ぜるときに使う。範囲を書かなければ全体のデフォルト範囲を使う。`--repo` なしはカレント1リポジトリ。変更なしなら何もせず終了
- `node storiff.js serve <dir> [--port N] [--host H]` : `<dir>/changes.json` と `<dir>/steps.json` を読み、ビューアを配信しブラウザを開く。`<dir>/done.flag` ができるまで動く。バインド先は既定 127.0.0.1 で、`--host 0.0.0.0` を付けたときだけ外部からホスト名で見られる形になる。0.0.0.0 は届く人全員に差分とコメントが見えるので一時的な用途に限る
- バインド先の既定値は `~/.storiff/config.json` の `host` でも指定できる。`{"host": "0.0.0.0"}` と書けば、以降 `--host` を付けずに serve するだけで常に 0.0.0.0 になる。CLI の `--host` を指定した場合はそちらが優先される

依存は Node 組み込みのみ(http, fs, child_process, path, url)。Node 20+。

## changes.json(prep が生成)
```json
{
  "diff_target": "working tree",
  "repos": ["."],
  "files": [
    {
      "repo": ".",
      "file": "src/user.js",
      "status": "modified",
      "lines": [
        {"kind": "context", "old": 1, "new": 1, "text": "function getUser(id) {"},
        {"kind": "del", "old": 2, "new": null, "text": "  return db.find(id)", "id": 1},
        {"kind": "add", "old": null, "new": 2, "text": "  const user = db.find(id)", "id": 2}
      ]
    }
  ],
  "change_ids": [1, 2]
}
```
- text は行頭の +/-/空白マーカーを除いた本文
- status は modified と added と deleted と renamed のどれか
- repo はそのファイルが属するリポジトリのパス。単一リポジトリなら "."。複数リポジトリでも変更IDは全体で通し番号になる

## changes.txt(prep が生成、story作成時にClaudeが読む軽量版)
changes.json と同じ情報を、1行ごとの整形JSONでなく行単位のテキストで持つ。生diffとほぼ同じサイズで済むため、story作成の手順3ではこちらを読む。
```
=== src/user.js (modified) ===
  function getUser(id) {
-[1]   return db.find(id)
+[2]   const user = db.find(id)
```
- `  `(空白2つ)始まりは context 行
- `-[id] ` または `+[id] ` 始まりは変更行。id は changes.json の change_ids と対応する
- 複数リポジトリのときは見出しに repo が付く。例 `=== /path/to/repoB src/user.js (modified) ===`

## files.txt(prep が生成、ファイル1行の地図)
ファイルごとに変更IDの範囲と件数を1行で持つ。中身の行までは持たないので極小。大差分では、まずこれを読んでどのファイルをどの固まりにするかを決め、owns_files で割り振る。
```
[1-18] (18) modified README.md
[19-52] (34) modified docs/story-schema.md
[53-236] (184) modified storiff.js
```
- `[開始id-終了id]` そのファイルが持つ変更IDの範囲。ファイル内のIDは連続する
- `(件数)` 変更行の数
- 続けて status、repo(単一リポジトリなら省略)、パス

## steps.json(Claude=skill が生成)
```json
{
  "title": "ユーザー取得の安全性強化と削除機能の追加",
  "steps": [
    {"order": 1, "title": "入力の安全性を固める", "narration": "まず `getUser` に...\n- null を弾く\n- **例外**を投げる", "owns": [1, 2], "refs": []},
    {"order": 2, "title": "削除できるようにする", "narration": "次に...", "owns_files": ["src/user.js"], "refs": [2], "file_notes": {"src/user.js": "`deleteUser` を追加"}}
  ]
}
```
- owns: このstepが所有する変更ID。整数のほか、`"53-236"` のような範囲文字列も書ける。範囲は files.txt の `[開始-終了]` をそのまま入れられる。全stepの owns を合わせると change_ids に一致し、各IDはちょうど1回(不変条件)
- 複数リポジトリでパスが衝突する場合、owns_files の `repo::path` より owns の id 範囲の方が扱いやすい。id は全リポジトリ通しで一意なので衝突しない
- owns_files: そのファイルの全変更IDを丸ごと所有する。IDを1個ずつ列挙する代わりに使うと出力が短くて済む。同名ファイルが複数リポジトリにある場合は `repo::file` の形で書き分ける。owns と併用でき、細かく割りたいファイルだけ owns で個別指定する
- owns_files の並び順がビューアでのファイル表示順になる。実際に手を動かした順に並べる。owns_files に無く整数 owns だけで含まれるファイルは、最初に登場する変更IDの順で後ろに続く
- file_notes: そのファイルへの一言説明。形式は {"パス": "短い説明"} で、ビューアはファイル見出しカードの下に出す。同名ファイルが複数リポジトリにあるときだけ `repo::パス` にする。任意
- refs: 既出コードの再言及。所有ではないので不変条件の対象外
- narration と file_notes は簡易 markdown が効く。`code`(バッククオート)で <code>、**強調** で太字、改行でそのまま改行、行頭 - で箇条書きになる。必ず先にHTMLエスケープしてから整形するので生HTMLは書けない
- narration の言語は固定しない。生成時にClaudeが会話している言語を使う
- 大差分では、まず `files.txt`(ファイル1行の地図。ID範囲と件数付き)を読んでファイルを固まりに割り振り、owns_files で指定する。全行を読まずに済む。書き終えたら `node storiff.js check <dir>` で抜けや重複や不明ファイルを確認する

## stepの分け方

「新設」「テスト追加」「削除」のような作業の種類や、ファイルの場所を軸にした固定ルールで機械的に分けない。軸は差分ごとに違うので、毎回想像し直す。

実際にどの順番で何を変更したかが分かっている場合(この差分を作った本人から伝えられた場合など)は、想像せずその実際の順序をそのまま使う。想像はあくまで、実際の順序が分からないときの次善策。

1. この差分を書いた本人になったつもりで、実際に手を動かして一からこれを作るとしたら、どういう順番で、どういうまとまりで進めたかを想像する
2. その想像した作業の単位ごとに1つのstepにする。ある対象(クラスや機能)ひとつを丸ごと片づけてから次に移ることもあれば、時系列の決断の積み重ねでまとまることもある。決めつけず、その差分に合う単位を探す
3. 1stepは、人が一区切りで手を動かす量、おおよそ最大1時間分にする。目安は変更行で数十行(80行程度)まで。step数は差分の大きさに比例して増える。大きい差分が7個や8個のstepに収まることはない。10個20個と増えて当然
4. ただし行数だけで割らない。参照の差し替えのように、変更が多くのファイルへ薄く広がる機械的な作業は、行数が目安を超えても1つの区切りとして1stepでよい。逆に密な実装が1つのファイルや数ファイルに固まっているなら、関数や処理のまとまりごとに割る
5. 大きい対象を割るときは、より細かいサブ対象で割る。移設なら、同じ対象の追加(移設先)と削除(移設元)は必ず同じstepに対で入れる。追加と削除など作業の種類で割ってはいけない。「追加のstep」「削除のstep」に分けると移動の物語が見えなくなる
6. owns_files で丸ごと1stepにしてよいのは、小さいファイルや、1つの不可分な追加(自動生成物など)だけ。変更行が多いファイルは changes.txt を読んで割る
7. stepを作り終えたら、タイトル一覧を見返す。「新設」「テスト追加」「削除」のように作業の種類が先に立ち、対象だけ変えて同じ言葉のstepが並んでいたら、想像が浅く機械的な分類に逃げている証拠。想像をやり直し、対象単位や決断単位に組み直す
8. narration には、その時その人が何を考えてその作業をしたか(背景・理由)を書く。読み手がそのstepだけで他人に説明できる分量にする。一文で終わらせない
9. `node storiff.js check <dir>` で確認する。明らかに大きく複数ファイルにまたがるstepは ng になるので分割する。目安を少し超える程度や、浅く広い機械的変更や、単一ファイルの自動生成物は ok のまま参考表示される

## story.json(serve が配信 = changes + steps をマージ)
```json
{
  "title": "...",
  "files": [ ... ],
  "change_ids": [ ... ],
  "steps": [ ... ],
  "validation": {"ok": true, "missing": [], "duplicated": []}
}
```
- serve は owns の和集合が change_ids と一致するか検算し validation に入れる。不一致でも配信はする

## HTTP API(serve)
| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | / | ビューアHTML(storiff.js に埋め込み) |
| GET | /story.json | マージ済み story + validation |
| POST | /comments | 行コメント追記。body は下記。`<dir>/comments.json` に追記 |
| POST | /done | `<dir>/done.flag` を書く。skill はこれを検知 |

POST /comments の body
```json
{"change_id": 2, "file": "src/user.js", "line": 3, "step_order": 1, "body": "ここなぜ?"}
```
comments.json は上記に `at`(ISO文字列)を足した配列。

## ビューアの振る舞い
- /story.json を取得して紙芝居表示
- 左に固定サイドバー(目次)。全stepを縦リストで並べ現在stepを強調。クリックでジャンプ。本文は残り全幅を使う可変レイアウト
- 上部に固定ヘッダー。現在stepの Step X / N、前/次、レビュー完了、title と narration。左右矢印キーでも前後に移動できる
- そのstepの owns を含むファイルだけ差分表示。表示順は owns_files の並び、残りは最初の変更ID順で後ろに続く。owns行を強調、他の変更行は淡く、context行は通常、refs行は副次強調
- owns行と refs行の周囲だけ表示し、離れた無変更行は「⋯ N 行 ⋯」に畳む。クリックで開く
- 差分は左右並列(split)が既定。統合(unified)と切り替えるトグルがあり、選択はstep移動後も保つ
- ファイル見出しカードにパスと status を出す。複数リポジトリのときは repo をタグ表示。file_notes があれば見出しの下に出す
- narration と file_notes は簡易 markdown(`code`、**強調**、改行、行頭 - の箇条書き)で描画する
- 行クリックでコメント欄。送信で POST /comments(その行の change_id/file/line と現在の step_order)。既存コメントは行下にインライン表示
- 「レビュー完了」ボタンで POST /done。完了メッセージを出す
- validation.ok が false なら missing/duplicated/unknown_files を警告バナー表示
- UIは日本語。add=緑/del=赤の簡易配色。外部リソース不使用(オフライン完結)
