# storiff データ契約

storiff.js(Node単一ファイル)とビューア、skill が共有する契約。

## 用語
- 変更ID: 差分中の変更行(add/del)に振る通し番号。1始まり、ファイルの並び順で付く。自動生成ファイルは末尾に寄せてから番号を振る。context行にはIDなし
- ステップ: ストーリーの1コマ。意図・ビジネスロジック単位で変更IDをまとめたもの
- 追従: 2回目以降の prep が、前回の changes.json と steps.json を新しい差分に合わせて書き直すこと

## storiff.js の使い方
- `node storiff.js prep <dir> [--repo P [範囲]]...` : 差分を解析し `<dir>/changes.json` と `<dir>/changes.txt` と `<dir>/files.txt` を書き出す。差分の取得は引数なしなら `git diff HEAD`、範囲(`main...HEAD` など)を後ろに付ければ `git diff <範囲>`。ステージ済みの変更も差分に入る。`--repo <path> [範囲]` を並べると複数リポジトリを1つにまとめ変更IDを通し番号にする。変更なしなら何も書かない。git diff に失敗したときは1行のメッセージを出して中断する
  - `<dir>` に `changes.json` と `steps.json` の両方がすでにあれば追従になる。どちらか欠けていれば初回として書き出す。詳しくは「追従」を参照
- `node storiff.js check <dir>` : `steps.json` を検算し、抜けID・重複ID・不明ファイルを表示する。ok なら `ok: 全 N 件の変更IDがちょうど1回ずつ owns に入っています` と出す。1stepの変更行が目安(80行)を超えると参考として一覧に出し、目安の2倍を超えてかつ複数ファイルにまたがると ng になり分割を求める。`diagram` を持つ step は図の書き方も検算する。詳しくは「ステップの図」を参照
- `node storiff.js reply <dir> <コメント番号> <本文>` : comments.json の指定コメント(並び順1始まり)の `replies` に AI の返信を追記する
- `node storiff.js serve <dir> [--port N] [--host H] [--session-id ID]` : ビューアを配信する常駐プロセスを裏で立ち上げ、URLだけすぐ返す。裏のプロセスは changes.json と steps.json を読み、`<dir>/close.flag` で終了する(`done.flag` では止まらない)。ログは `<dir>/serve.log`、起動情報は `<dir>/serve.json`(pid・port・host・url・session_id・started_at)に書く。同じ dir でもう一度実行すると、serve.json の pid が生きていて `/health` に応答すれば新しく起動せず既存のビューアに接続する。このとき `--session-id` を渡すと serve.json の session_id を渡した値に更新する。`--daemon` は裏のプロセス自身が使う内部フラグ。`--session-id` を渡すと、行コメントに haiku がその場で返信する。バインド先は既定 127.0.0.1、`--host 0.0.0.0` で外部からホスト名で見られる
- バインド先は `~/.storiff/config.json` の `host` でも指定できる(`{"host": "0.0.0.0"}`)。CLI の `--host` が優先

`changes.json` `changes.txt` `files.txt` `steps.json` `comments.json` `follow.json` `serve.json` はすべて一時ファイルに書いてから同じディレクトリ内で差し替える。書き込みの途中で別プロセスが読みにいっても、壊れた内容を掴むことはない

依存は Node 組み込みのみ(http, fs, path, child_process, os)。Node 20+。`--session-id` を渡したときの行コメント返信(askHaiku)だけは外部の `claude` コマンドを子プロセスで呼ぶ。

## changes.json(prep が生成)
```json
{
  "diff_target": "HEAD",
  "repos": ["."],
  "repo_args": [{"path": ".", "diffArgs": []}],
  "cwd": "/path/to/repo",
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
- repo_args: prep に渡されたリポジトリと範囲の指定。追従で同じ範囲を再実行するために使う
- cwd: 初回 prep を実行した場所。リポジトリのパスが相対指定のときの起点。追従では前回の値を引き継ぐ

## changes.txt(prep が生成、ストーリー作成時に読むスリム版)
コンテキスト行を落とし、変更行(add と del)だけを持つ。
```
=== src/user.js (modified) ===
-[1]   return db.find(id)
+[2]   const user = db.find(id)
```
- `-[id] ` または `+[id] ` 始まりが変更行。id は changes.json の change_ids と対応する
- 複数リポジトリのときは見出しに repo が付く。例 `=== /path/to/repoB src/user.js (modified) ===`
- ロックファイルやビルド成果物などのノイズは prep が除外する。既定は `*.lock` `package-lock.json` `yarn.lock` `pnpm-lock.yaml` `*.min.js` `*.min.css` `*.map`。`~/.storiff/config.json` の `exclude` で追加できる
- 自動生成ファイルは除外せず、変更IDの並びで末尾に回すだけにする。既定は `*.generated.*` `*.gen.*` `*.pb.go`。`~/.storiff/config.json` の `generated` で追加できる

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
    {"order": 2, "title": "削除できるようにする", "narration": "次に...", "owns_files": ["src/user.js"], "refs": [2], "file_notes": {"src/user.js": "`deleteUser` を追加"}, "diagram": "flowchart LR\n  handler[deleteUser] -->|id| check{使用中か}\n  check --> db[レコードを消す]"}
  ]
}
```
- owns: このステップが所有する変更ID。全ステップの owns を合わせると change_ids に一致し、各IDはちょうど1回(不変条件)。次の3種を混ぜて書ける
  - F番号 `"F12"` そのファイル1つ丸ごと
  - 範囲 `"53-90"` id の範囲。ファイルの一部を切り出す
  - 整数 `12` 単独の変更ID
- owns_files: そのファイルの全変更IDを丸ごと所有する。同名ファイルが複数リポジトリにあるときは `repo::file` で書き分ける。owns と併用できる。並び順がビューアのファイル表示順になる。この並び順が効くのは初回だけで、追従では owns_files が消えるため効かなくなる
- file_notes: そのファイルへの一言説明。`{"パス": "短い説明"}`。同名ファイルが複数リポジトリにあるときだけ `repo::パス`。任意
- refs: 既出コードの再言及。所有ではないので不変条件の対象外。owns と同じく整数と範囲とF番号で書ける。serve が配信するときに整数の配列へ展開する
- narration と file_notes は簡易 markdown が効く。`code`・**強調**・改行・行頭 - の箇条書き。生HTMLは書けない
- narration の言語は固定しない。生成時に会話している言語を使う
- diagram: そのステップに閉じた小さい関係図。Mermaid の flowchart で書く。任意。無いステップは今までどおり図なしで表示する。詳しくは「ステップの図」を参照
- 追従で書き直された後の owns は範囲文字列と整数だけになり、F番号と owns_files は残らない。詳しくは「追従」を参照

## ステップの図(diagram)

ステップが触る呼び出し関係だけを描く。全体の構成図ではないので、ノードは目安 8 個まで。呼び出しの順番や状態のうつり変わりが読み取りにくいステップにだけ付ける。単なる置きかえや設定の変更には付けない。

書ける記法は Mermaid の flowchart の一部だけで、storiff.js が自前で読み取って SVG を描く。外部のライブラリは使わない。

| 書き方 | 意味 |
| --- | --- |
| `flowchart LR` `flowchart TD` | 1行目の書き出し。向きは TD と TB と LR と RL と BT |
| `名前[ラベル]` | 四角のノード |
| `名前(ラベル)` | 角の丸いノード |
| `名前{ラベル}` | 菱形のノード |
| `A --> B` | 矢印。`-.->` と `==>` も同じ見た目で描く |
| `A -->|ラベル| B` | ラベル付きの矢印 |
| `A --> B --> C` | つなげて書くと矢印が2本になる |
| `%% 説明` | コメント行。読み飛ばす |

- ノードの名前は英数字と `_` だけ。日本語はラベル側に書く
- `subgraph` と `style` と `classDef` と `click` は読めない。シーケンス図やクラス図も読めない
- 同じ名前に違うラベルを2回付けない。片方が黙って消える
- 違う名前に同じラベルを付けない。同じものが2つあるように見える
- `check` が上の決まりを検算する。読めない行、`graph` の古い書き出し、`->` や `-->>` の矢印、ラベルの重複があると ng になる。ノード数が目安を超えたときは参考として出すだけで ng にはしない
- ビューアは読み取れない図を黙って隠し、差分の表示は続ける

## ステップの分け方

作業の種類(新設・テスト追加・削除など)やファイルの場所を軸にした固定ルールで機械的に分けない。軸は差分ごとに違うので毎回想像し直す。実際の作業順が分かるなら想像せずそれを使う。

1. この差分を一から作るとしたら、どういう順番・どういうまとまりで進めたかを想像する
2. その作業の単位ごとに1ステップ。対象を丸ごと片づける単位のこともあれば、決断の積み重ねの単位のこともある。差分に合う単位を探す
3. 1ステップは一区切り(おおよそ最大1時間、変更行80行程度まで)。ステップ数は差分に比例し、大きい差分は10個20個に増える
4. 行数だけで割らない。薄く広い機械的変更(参照差し替えなど)は目安を超えても1ステップ。密な実装は関数や処理のまとまりで割る
5. 移設は追加(移設先)と削除(移設元)を必ず同じステップに対で入れる。作業の種類で割らない
6. owns_files で丸ごと1ステップにしてよいのは、小さいファイルか不可分な追加(自動生成物など)だけ。変更行が多いファイルは changes.txt を読んで割る
7. タイトル一覧が「新設」「削除」のように種類先行で並んだら割り直す
8. narration には背景と理由を書く。そのステップだけで他人に説明できる分量にする。一文で終わらせない
9. `node storiff.js check <dir>` で確認する。大きく複数ファイルにまたがるステップは ng になるので分割する

## 追従(修正後の prep のやり直し)

同じ `<dir>` にすでに changes.json と steps.json があるとき、prep をもう一度実行すると追従になる。どちらか欠けていれば初回として書き出す。コマンドは初回も追従も同じ。

- 範囲や `--repo` を引数で渡していないときだけ、前回の changes.json の repo_args を使う。渡し間違いで別の差分と対応表を作る事故を防ぐ。記録済みを使ったときは1行で知らせる。範囲を変えたいときは引数で渡し直せばそちらが使われる
- 前回と今回の差分を「リポジトリとパスと追加削除と行の中身」で照合し、旧IDと新IDの対応表を作る。旧IDの昇順と新IDの昇順の両方が保たれる組み合わせだけを採り、同じ中身の行が複数あっても前後関係が入れ替わる対応にはしない。同じ内容の行が SAME_CONTENT_LINE_COUNT_MAX(100)本を超えて並ぶ内容だけは、この計算から外して前回と今回の出現順どうしをそのまま対応させる
- 対応の取れなかった旧IDは消えた行として owns から落ちる。owns が空になったステップも消さずに残り、ステップ番号は繰り上げない
- title と narration と diagram と file_notes は書き換えずそのまま残る。書き換わるのは owns と refs だけ
- 対応の取れなかった新IDは末尾の「修正N回目」ステップに入る。narration は空で、後で人か AI が書く
- コメントの change_id も新IDに写る。写せないコメントは change_id が null になり、body と replies は残る。ビューアは「修正で無くなった行へのコメント」としてステップの末尾に出す。どのステップにも属さないコメントも最後のステップに寄る
- 追従で差分が0件になったときは書き換えず、既存のストーリーをそのまま残す。ここで書き換えると全ステップの owns が空になるため
- 前回とまったく同じ差分だったとき、つまり消えた行と増えた行がどちらも0件で、かつ旧IDと新IDの対応表がすべて同じ番号どうしの対応(恒等)だったときも書き換えない。steps.json と comments.json はもちろん、follow.json も控え(steps.prev.json と comments.prev.json)も作られない
- 前回の changes.json が読み込めないか、files を持たない形か、files の要素に lines が無い形のときは1行のメッセージを出して中断する。既存のファイルは書き換えない。steps.json や comments.json が壊れているときも、CLI は1行のメッセージにして中断する

追従で増えるファイル

- steps.prev.json 書き換え前の steps.json の控え
- comments.prev.json 書き換え前の comments.json の控え
- follow.json 旧IDと新IDの対応表、消えたID、増えたID、足した修正ステップの番号

控えは直前の1回分だけ残る。追従を重ねるたびに上書きされるので、最初の状態には戻れない

CLI から直接 prep を叩く経路と、ビューアの「差分を取り込む」ボタンからの追従(POST /follow)は、同時に走らせない。控えのファイルが書き換え済みの内容で上書きされて失われる。

### 追従の限界

- 範囲を指定してレビューを始めたときは、修正をコミットしないと追従に出てこない
- 新しく作ったファイルは `git add` するまで差分に入らない
- ファイル名を変えるとそのファイルのストーリーは白紙に戻る
- ストーリーに入っている行の中身を書き換えると、その行は元のステップから抜けて末尾の修正ステップに移る。元のステップの説明はその行を説明しなくなる
- 同じ内容の変更行が1ファイルに大量にあるとき、その本数が閾値を超えると対応が出現順になり、行の前後関係が入れ替わることがある。閉じ括弧や空行のような重複しやすい行で起きやすい
- ファイル内でブロックを入れ替えると、行数が少ない側の対応がすべて落ちて消えた行と増えた行になる。3行の関数と5行の関数を入れ替えると3行が消えて3行が増える
- 対応表を作る計算量は、変更行数と同じ内容の行の重複本数の積で伸びる。同じ内容が100本ずつ並ぶ行が1万行あると1.4秒と272MB、4万行あると6.6秒と1345MBかかる
- owns が空になったステップは残り、画面では説明だけで差分が出ない状態になる
- 「修正N回目」の連番は title の文字列から数えている。title を書き換えると番号が重なる

## story.json(serve が配信 = changes と steps をマージしたもの)
```json
{
  "title": "...",
  "files": [ ... ],
  "change_ids": [ ... ],
  "steps": [ ... ],
  "validation": {"ok": true, "missing": [], "duplicated": [], "unknown_files": []},
  "comments": [ ... ]
}
```
- serve は owns の和集合が change_ids と一致するか検算し validation に入れる。不一致でも配信はする

## HTTP API(serve)
| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | /health | 生存確認。`{"pid": ...}` を返す。serve を2回目に起動したとき既存プロセスの生死を確かめるのに使う |
| GET | / | ビューアHTML(storiff.js に埋め込み) |
| GET | /story.json | マージ済みのストーリーと validation と comments |
| POST | /comments | 行コメント追記。`<dir>/comments.json` に追記 |
| POST | /done | `<dir>/done.flag` を書く。skill はこれを合図に返信する。serve は止めない |
| POST | /close | `<dir>/close.flag` を書く。serve はこれで終了する |
| POST | /follow | 追従の prep を子プロセスで実行する。すでに実行中なら 409 を返す |

POST /comments の body
```json
{"change_id": 2, "file": "src/user.js", "repo": ".", "line": 3, "step_order": 1, "body": "ここなぜ?"}
```
comments.json は上記に `replies` と `at`(ISO文字列)を足した配列。1つの返信は `{"author": "ai", "body": "...", "at": "..."}`。serve に `--session-id` を渡してあると、コメント追記のたびに haiku が答えて replies に入る。渡すプロンプトは change_id で質問対象の行を特定し、そのステップが受け持つ範囲の差分(owns と refs)に質問対象の行自体を加えたものを渡す。ファイル名には複数リポジトリのときだけ repo を添える。change_id で特定できない古いコメントは file と repo でファイルだけ絞り込む。repo を持たない古いコメントでも動く。コメントの応答は先に返し、haiku へのプロンプト作りが steps.json などの読み込みで失敗しても、応答済みの `/comments` はエラーにならず serve.log に1行残るだけで動き続ける

## ビューアの振る舞い
- 左に固定サイドバー(目次)。全ステップを縦リストで並べ現在ステップを強調。クリックでジャンプ
- 上部に固定ヘッダー。Step X / N、前/次、レビュー完了、終了、title と narration。左右矢印キーでも前後移動
- diagram を持つステップは、差分の手前にそのステップの関係図を1枚出す。SVGはビューアが自分で組み立てるのでネット接続は要らない。読み取れない図は枠ごと隠し、差分の表示は続ける
- そのステップの owns を含むファイルだけ差分表示。owns行を強調、他の変更行は淡く、refs行は副次強調。離れた無変更行は「⋯ N 行 ⋯」に畳む
- 差分は左右並列(split)が既定。統合(unified)と切り替えるトグルがあり、選択はステップ移動後も保つ
- ファイル見出しにパスと status。複数リポジトリのときは repo をタグ表示。file_notes は見出しの下に出す
- 行クリックでコメント欄。送信で POST /comments。AIの返信は各コメントの下にスレッドで積む。コメント欄を開いた後に追従が入って差分が変わっていたら、送信時に欄を閉じて開き直すよう伝える
- 固定ヘッダーに「差分を取り込む」ボタンがある。押すと POST /follow で追従の prep を走らせ、押したことと取り込みが始まったことをメッセージで示す。押した直後には描き直さず、定期取得が変化を拾うのに任せる。追従が動いている間は次の押下がサーバ側で断られる
- /story.json を数秒ごとに取得し、差分やステップやコメントや返信が変わったときだけ再描画する。ミニマップも組み直す。見ているステップ位置とスクロール位置は保つ。コメント欄を開いている間は再描画しない
- 「レビュー完了」で POST /done、「終了」で POST /close
- validation.ok が false なら missing/duplicated/unknown_files を警告バナー表示
- add=緑、del=赤の配色で、OSの設定に合わせてダークモードにも切り替わる
- コードは highlight.js(cdnjs から読み込み)でハイライトする。表示にネット接続が要る
## 用語統一について
本プロジェクトでは、画面の遷移や意図の区切りを示す単位を「ステップ(Step)」、それらを集めたレビュー用の全体像を「ストーリー(Story)」と呼称します。ビューアの名称も「ストーリービューア」に統一します。
