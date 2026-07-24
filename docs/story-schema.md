# storiff データ契約

storiff.js(Node単一ファイル)とビューア、skill が共有する契約。

## 用語
- 変更ID: 差分中の変更行(add/del)に振る通し番号。1始まり、差分の出現順。context行にはIDなし
- step: 紙芝居の1コマ。意図・ビジネスロジック単位でClaudeが変更IDをまとめたもの

## storiff.js の使い方
- `node storiff.js prep <dir>` : カレントの `git diff`(作業差分)を解析し `<dir>/changes.json` を書き出す。変更なしなら何もせず終了
- `node storiff.js serve <dir> [--port N]` : `<dir>/changes.json` と `<dir>/steps.json` を読み、127.0.0.1 でビューアを配信しブラウザを開く。`<dir>/done.flag` ができるまで動く

依存は Node 組み込みのみ(http, fs, child_process, path, url)。Node 20+。

## changes.json(prep が生成)
```json
{
  "diff_target": "working tree",
  "files": [
    {
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
- status は modified / added / deleted / renamed

## steps.json(Claude=skill が生成)
```json
{
  "title": "ユーザー取得の安全性強化と削除機能の追加",
  "steps": [
    {"order": 1, "title": "入力の安全性を固める", "narration": "まず...", "owns": [1, 2], "refs": []},
    {"order": 2, "title": "削除できるようにする", "narration": "次に...", "owns": [3], "refs": [2]}
  ]
}
```
- owns: このstepが所有する変更ID。全stepの owns を合わせると change_ids に一致し、各IDはちょうど1回(不変条件)
- refs: 既出コードの再言及。所有ではないので不変条件の対象外
- narration の言語は固定しない。生成時にClaudeが会話している言語を使う

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
- step ナビ(前/次、X/N、一覧)。現在stepの title と narration を大きく見せる
- そのstepの owns を含むファイルだけ差分表示。owns行を強調、他の変更行は淡く、context行は通常、refs行は副次強調
- 行クリックでコメント欄。送信で POST /comments(その行の change_id/file/line と現在の step_order)。既存コメントは行下にインライン表示
- 「レビュー完了」ボタンで POST /done。完了メッセージを出す
- validation.ok が false なら missing/duplicated を警告バナー表示
- UIは日本語。add=緑/del=赤の簡易配色。外部リソース不使用(オフライン完結)
