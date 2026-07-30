---
name: storiff
description: 巨大な作業差分を意図・ビジネスロジック単位のストーリーに分解し、紙芝居形式のローカルビューアでレビューさせる。ユーザーの行コメントに会話上で回答する。差分レビューやコードの意図説明を求められたときに使う
---

# storiff

story + diff。カレントの作業差分を意図単位のstepに分け、紙芝居ビューアでレビューさせる。実体は `${CLAUDE_PLUGIN_ROOT}/storiff.js`。データ契約は `${CLAUDE_PLUGIN_ROOT}/docs/story-schema.md`

## ワークフロー

1. `ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)` を取り `~/.storiff/$ts/` を作る。以降 `<dir>`
2. `node ${CLAUDE_PLUGIN_ROOT}/storiff.js prep <dir>` を実行する。引数なしでカレントの作業差分。`origin/main...HEAD` のような範囲を後ろに付けられる。複数リポジトリは `--repo <path> [範囲]` を並べる。changes.json が出なければレビュー対象なしと伝えて終わる
3. story は本セッションで書く。stepの分け方は `${CLAUDE_PLUGIN_ROOT}/docs/story-schema.md` の「stepの分け方」節に従う
   - `<dir>/files.txt`(F番号つきの地図)で全体をつかみ、`<dir>/changes.txt`(スリムな変更行)で中身を読む。changes.json は開かない
   - owns はファイル丸ごとなら **F番号**(例 `"F12"`)、一部なら id 範囲(例 `"53-90"`)。長いパス文字列は使わない
   - この会話で実装した差分は、実際の作業順と意図をそのまま story にする。未実装の差分は想像する
   - step と owns の並びが表示順になる。作業順に並べる
   - 1stepは変更行で数十行の一区切り。大きい差分を数個に丸めない。長いファイルは処理のまとまりで id 範囲に割る。薄く広い機械的変更は1stepでよい
   - 各stepに title と narration と file_notes。narration はユーザーと会話している言語で、`code`・改行・行頭 - の箇条書きを使う
   - 全変更IDがどれかの owns にちょうど1回ずつ。既出コードは refs
   - `<dir>/steps.json` に書き、`node ${CLAUDE_PLUGIN_ROOT}/storiff.js check <dir>` を ok まで回す。ok ならパスだけ報告する
4. `node ${CLAUDE_PLUGIN_ROOT}/storiff.js serve <dir>` を実行し、URLを伝える。serve は tool のタイムアウトに縛られない常駐デーモンを立てて URL をすぐ返す。同じ dir で再実行すると起動済みのビューアにつなぎ直す。「レビュー完了」で `done.flag`、「終了」で `close.flag`
5. 1回のBash呼び出しをバックグラウンドで実行し、シェルの待ちループで待つ。ターンを繰り返して待たない

   ```
   until [ -f <dir>/done.flag ] || [ -f <dir>/close.flag ]; do sleep 5; done
   ```

6. close.flag なら片付けて終わる。done.flag なら `<dir>/comments.json` を読み、返信の無いコメントに答える。会話に出しつつ `node ${CLAUDE_PLUGIN_ROOT}/storiff.js reply <dir> <番号> "<本文>"` でも書く(番号は並び順1始まり、本文は会話言語で改行と行頭 - が効く)。story は作り直さない。答えたら `rm <dir>/done.flag` して 5 に戻り、close.flag まで繰り返す
