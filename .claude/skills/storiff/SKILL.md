---
name: storiff
description: 巨大な作業差分を意図・ビジネスロジック単位のストーリーに分解し、紙芝居形式のローカルビューアでレビューさせる。ユーザーの行コメントに会話上で回答する。差分レビューやコードの意図説明を求められたときに使う
---

# storiff

storiff は story(お話)と diff(変更点)を合わせた名前。いま変更したコードを意図ごとに小さなステップに分け、紙芝居のように順番に見せてレビューしてもらう。本体は `~/.claude/skills/storiff/storiff.js`、細かい仕様は [docs/story-schema.md](docs/story-schema.md)

## 用語

| 用語 | 意味 |
| --- | --- |
| ストーリー | レビュー全体。ステップを順に並べた紙芝居 |
| ステップ | 紙芝居の1コマ。1つの意図でまとめた変更のかたまり |
| 変更ID | 変更した行1つずつに付く番号。1から順 |
| F番号 | ファイル1個をまるごと指す名前(例 F12) |
| owns | そのステップが受け持つ変更ID。全ステップを合わせると全変更IDをちょうど1回ずつ |
| refs | 前に出たコードをもう一度見せるだけ。owns ではない |
| narration | そのステップの説明。何をなぜやったかを書く |

## 進め方

1. `ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)` で `~/.storiff/$ts/` を作る。これを `<dir>` と呼ぶ
2. `node ~/.claude/skills/storiff/storiff.js prep <dir>` で変更点を書き出す。引数なしで今の変更。`origin/main...HEAD` のように範囲を後ろに付けてもいい。複数リポジトリは `--repo <path> [範囲]` を並べる。changes.json ができなければ「見るものがない」と伝えて終わる
3. ストーリーはサブエージェントに作らせる。メイン(この会話)に大量のコードを読み込ませないため、steps.json を作るところまでサブエージェント側で終わらせる
   - この会話で実装したなら、メインが「どんな順番で何のために作ったか」を短くまとめ、下の prompt に書いて渡す。サブエージェントはこの会話を見られない
   - まだ実装していない変更なら、まとめは渡さず files.txt と changes.txt から組み立てさせる
   - Agent tool(subagent_type: general-purpose)で呼ぶ。メインはステップの数と check の結果だけ受け取り、コードの中身は読まない
4. `node ~/.claude/skills/storiff/storiff.js serve <dir> --session-id "$CLAUDE_CODE_SESSION_ID"` を実行し、返ってきた URL を伝える。serve は tool のタイムアウトに縛られない常駐デーモンを立てて URL をすぐ返すので、裏で動かし続けなくてよい。同じ dir でもう一度実行すると起動済みのビューアにつなぎ直す。画面の「レビュー完了」で done.flag、「終了」で close.flag ができる
   - `--session-id` を渡すと、画面に書かれたコメントに haiku がその場で返事する。haiku はこの会話の履歴を読むだけで、履歴に書き戻さない。この会話の返事を待たずに答えが出るので必ず渡す
5. Bash を1回だけ裏で動かし、下のループで合図を待つ。ターンを繰り返して待たない

   ```
   until [ -f <dir>/done.flag ] || [ -f <dir>/close.flag ]; do sleep 5; done
   ```

6. close.flag なら片付けて終わり。done.flag なら `<dir>/comments.json` を読み、haiku の返事で足りないコメントに答える。会話で答えつつ `node ~/.claude/skills/storiff/storiff.js reply <dir> <番号> "<本文>"` でも書く(番号は上から1・2…)。あわせて、直しが必要なやり取りだけを短くまとめて自分の理解に入れ、そのまま直す。ストーリーは作り直さない。答えたら `rm <dir>/done.flag` して 5 に戻り、close.flag まで繰り返す
7. 手順6でコードを直したら `node ~/.claude/skills/storiff/storiff.js prep <dir>` をもう一度実行する。changes.json と steps.json がすでにあるので追従に切り替わり、直した差分は末尾の「修正N回目」ステップにまとまる。steps.json を作り直させたりはせず、追加された修正ステップの narration だけ、何をなぜ直したかを書いて `<dir>/steps.json` に足す。書いたら `node ~/.claude/skills/storiff/storiff.js check <dir>` を実行する。修正が大きいと「修正N回目」ステップが ng になるので、その場合はステップを割ってから ok になったことを確かめる。書いたら 5 に戻る

## サブエージェントに渡す prompt

ステップ3では、下の文を本物の内容に置きかえて Agent tool(subagent_type: general-purpose)で呼び出す。`<dir>` は本物のパスにする。「作業メモ」は、この会話で実装していたなら要点を書き、していなければ行ごと消す

> steps.json を `<dir>/steps.json` に作り、`node ~/.claude/skills/storiff/storiff.js check <dir>` が ok になるまで直してください。ステップの分け方は `~/.claude/skills/storiff/docs/story-schema.md` の「ステップの分け方」に従います。
>
> - まず `<dir>/files.txt`(ファイル一覧)で全体をつかみ、`<dir>/changes.txt`(変えた行だけ)で中身を読む。changes.json は開かない
> - owns は、ファイルまるごとなら F番号(例 `"F12"`)、一部なら変更IDの範囲(例 `"53-90"`)で書く。長いファイルパスは書かない
> - ステップを並べた順が画面の表示順になる。作った順に並べる
> - 1ステップは変えた行で数十行がまとまり。大きな変更をまとめすぎない。長いファイルは処理のまとまりで変更IDの範囲に分ける。広く薄い機械的な変更は1ステップでいい
> - 各ステップに title(見出し)と narration(説明文)を付ける。narration は日本語で、`code` や改行、行頭の - の箇条書きが使える
> - narration は「なぜそうしたか」まで書く。ただし、はっきりしないことは決めつけず、根拠があれば「issue に〜と書いてある」のように出どころを添え、推測は推測とわかるように書く
> - すべての変更IDが、どれかのステップの owns にちょうど1回ずつ入るようにする。再掲は refs にする
> - 作業メモ(どんな順番で何のために作ったか): <この会話で実装した内容の要点。なければこの行を消す>
> - 終わったらステップの数と check の結果だけ返す
