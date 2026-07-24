# storiff データ契約

storiff.js(Node単一ファイル)とビューア、skill が共有する契約。

## 用語
- 変更ID: 差分中の変更行(add/del)に振る通し番号。1始まり、差分の出現順。context行にはIDなし
- step: 紙芝居の1コマ。意図・ビジネスロジック単位で変更IDをまとめたもの

## storiff.js の使い方
- `node storiff.js prep <dir> [--repo P [範囲]]...` : `git diff` を解析し `<dir>/changes.json` と `<dir>/changes.txt` と `<dir>/files.txt` を書き出す。引数なしでカレントの作業差分。範囲(`main...HEAD` など)を後ろに付けられる。`--repo <path> [範囲]` を並べると複数リポジトリを1つにまとめ変更IDを通し番号にする。変更なしなら何も書かない
- `node storiff.js check <dir>` : `steps.json` を検算し、抜けID・重複ID・不明ファイルを表示する。ok なら何も無い
- `node storiff.js reply <dir> <コメント番号> <本文>` : comments.json の指定コメント(並び順1始まり)の `replies` に AI の返信を追記する
- `node storiff.js serve <dir> [--port N] [--host H]` : changes.json と steps.json を読みビューアを配信しブラウザを開く。`<dir>/close.flag` で終了する(`done.flag` では止まらない)。バインド先は既定 127.0.0.1、`--host 0.0.0.0` で外部からホスト名で見られる
- バインド先は `~/.storiff/config.json` の `host` でも指定できる(`{"host": "0.0.0.0"}`)。CLI の `--host` が優先

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
- repo はそのファイルが属するリポジトリのパス。単一リポジトリなら "."。複数でも変更IDは全体で通し番号

## changes.txt(prep が生成、story作成時に読むスリム版)
コンテキスト行を落とし、変更行(add と del)だけを持つ。
```
=== src/user.js (modified) ===
-[1]   return db.find(id)
+[2]   const user = db.find(id)
```
- `-[id] ` または `+[id] ` 始まりが変更行。id は changes.json の change_ids と対応する
- 複数リポジトリのときは見出しに repo が付く。例 `=== /path/to/repoB src/user.js (modified) ===`
- ロックファイルやビルド成果物などのノイズは prep が除外する。既定は `*.lock` `package-lock.json` `*.min.js` `*.map` 等。`~/.storiff/config.json` の `exclude` で追加できる

## files.txt(prep が生成、ファイル1行の地図)
ファイルごとに変更IDの範囲と件数を1行で持つ。
```
F1 [1-18] (18) modified README.md
F2 [19-52] (34) modified docs/story-schema.md
F3 [53-236] (184) modified storiff.js
```
- `F番号` そのファイルの短い識別子。owns にそのまま入れるとファイル1つ丸ごとを所有できる
- `[開始id-終了id]` そのファイルが持つ変更IDの範囲。ファイル内のIDは連続する
- `(件数)` 変更行の数
- 続けて status、repo(単一リポジトリなら省略)、パス

## steps.json(skill が生成)
```json
{
  "title": "ユーザー取得の安全性強化と削除機能の追加",
  "steps": [
    {"order": 1, "title": "入力の安全性を固める", "narration": "まず `getUser` に...\n- null を弾く\n- **例外**を投げる", "owns": [1, 2], "refs": []},
    {"order": 2, "title": "削除できるようにする", "narration": "次に...", "owns_files": ["src/user.js"], "refs": [2], "file_notes": {"src/user.js": "`deleteUser` を追加"}}
  ]
}
```
- owns: このstepが所有する変更ID。全stepの owns を合わせると change_ids に一致し、各IDはちょうど1回(不変条件)。次の3種を混ぜて書ける
  - F番号 `"F12"` そのファイル1つ丸ごと
  - 範囲 `"53-90"` id の範囲。ファイルの一部を切り出す
  - 整数 `12` 単独の変更ID
- owns_files: そのファイルの全変更IDを丸ごと所有する。同名ファイルが複数リポジトリにあるときは `repo::file` で書き分ける。owns と併用できる。並び順がビューアのファイル表示順になる
- file_notes: そのファイルへの一言説明。`{"パス": "短い説明"}`。同名ファイルが複数リポジトリにあるときだけ `repo::パス`。任意
- refs: 既出コードの再言及。所有ではないので不変条件の対象外
- narration と file_notes は簡易 markdown が効く。`code`・**強調**・改行・行頭 - の箇条書き。生HTMLは書けない
- narration の言語は固定しない。生成時に会話している言語を使う

## stepの分け方

作業の種類(新設・テスト追加・削除など)やファイルの場所を軸にした固定ルールで機械的に分けない。軸は差分ごとに違うので毎回想像し直す。実際の作業順が分かるなら想像せずそれを使う。

1. この差分を一から作るとしたら、どういう順番・どういうまとまりで進めたかを想像する
2. その作業の単位ごとに1step。対象を丸ごと片づける単位のこともあれば、決断の積み重ねの単位のこともある。差分に合う単位を探す
3. 1stepは一区切り(おおよそ最大1時間、変更行80行程度まで)。step数は差分に比例し、大きい差分は10個20個に増える
4. 行数だけで割らない。薄く広い機械的変更(参照差し替えなど)は目安を超えても1step。密な実装は関数や処理のまとまりで割る
5. 移設は追加(移設先)と削除(移設元)を必ず同じstepに対で入れる。作業の種類で割らない
6. owns_files で丸ごと1stepにしてよいのは、小さいファイルか不可分な追加(自動生成物など)だけ。変更行が多いファイルは changes.txt を読んで割る
7. タイトル一覧が「新設」「削除」のように種類先行で並んだら割り直す
8. narration には背景と理由を書く。そのstepだけで他人に説明できる分量にする。一文で終わらせない
9. `node storiff.js check <dir>` で確認する。大きく複数ファイルにまたがるstepは ng になるので分割する

## story.json(serve が配信 = changes + steps をマージ)
```json
{
  "title": "...",
  "files": [ ... ],
  "change_ids": [ ... ],
  "steps": [ ... ],
  "validation": {"ok": true, "missing": [], "duplicated": []},
  "comments": [ ... ]
}
```
- serve は owns の和集合が change_ids と一致するか検算し validation に入れる。不一致でも配信はする

## HTTP API(serve)
| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | / | ビューアHTML(storiff.js に埋め込み) |
| GET | /story.json | マージ済み story + validation + comments |
| POST | /comments | 行コメント追記。`<dir>/comments.json` に追記 |
| POST | /done | `<dir>/done.flag` を書く。skill はこれを合図に返信する。serve は止めない |
| POST | /close | `<dir>/close.flag` を書く。serve はこれで終了する |

POST /comments の body
```json
{"change_id": 2, "file": "src/user.js", "line": 3, "step_order": 1, "body": "ここなぜ?"}
```
comments.json は上記に `replies` と `at`(ISO文字列)を足した配列。1つの返信は `{"author": "ai", "body": "...", "at": "..."}`。

## ビューアの振る舞い
- 左に固定サイドバー(目次)。全stepを縦リストで並べ現在stepを強調。クリックでジャンプ
- 上部に固定ヘッダー。Step X / N、前/次、レビュー完了、終了、title と narration。左右矢印キーでも前後移動
- そのstepの owns を含むファイルだけ差分表示。owns行を強調、他の変更行は淡く、refs行は副次強調。離れた無変更行は「⋯ N 行 ⋯」に畳む
- 差分は左右並列(split)が既定。統合(unified)と切り替えるトグルがあり、選択はstep移動後も保つ
- ファイル見出しにパスと status。複数リポジトリのときは repo をタグ表示。file_notes は見出しの下に出す
- 行クリックでコメント欄。送信で POST /comments。AIの返信は各コメントの下にスレッドで積む
- /story.json を数秒ごとに取得し、コメントや返信が増えたときだけ再描画する。コメント欄を開いている間は再描画しない
- 「レビュー完了」で POST /done、「終了」で POST /close
- validation.ok が false なら missing/duplicated/unknown_files を警告バナー表示
- add=緑、del=赤の配色で、OSの設定に合わせてダークモードにも切り替わる
- コードは highlight.js(cdnjs から読み込み)でハイライトする。表示にネット接続が要る
