# storiff

ストーリー + diff。巨大な差分をAIが小さな意図単位のストーリーに分解し、紙芝居形式でレビューさせるツール。[crit](https://github.com/tomasz-tomczyk/crit) をベースにした発想で、ストーリーがありそのdiffを見れる。

でかい差分はどこから見ればいいかわからない。そこでAIにストーリーを出してもらい、少しずつ全体が分かるようにする。

## 仕組み
- skill がカレントの作業差分を ストーリー JSON にする
- Node単一ファイルの極小ローカルビューアが紙芝居と行コメントを提供する
- コメントは会話に返り、Claudeが回答する

差分の各変更行に通し番号(変更ID)を振り、Claudeがそれを意図・ビジネスロジック単位のステップにまとめる。全変更IDがどれかのステップにちょうど1回ずつ入るので、ストーリーをすべて合わせると指定した差分のdiffになる。

## なぜそうしたかの材料
差分のテキストだけでは「何をしたか」しか読み取れず、説明がコードの言い換えになりやすい。そこで差分を書き出すときに、意図の材料も `context.txt` に集めてストーリー作りに渡す。

- ブランチ名と、その差分に含まれるコミットの本文(Co-authored-by や Refs もそのまま)
- ブランチ名とコミットから拾った課題番号(`#12` や `ABC-123`)
- 変更したファイルの近くにある `CLAUDE.md` `AGENTS.md` `README.md` の場所
- `--with-remote` を付けたときだけ、`gh` で読んだ PR と課題の説明とコメント

ここまでが既定で手元の git だけで完結する。GitHub に問い合わせるのは `--with-remote` を付けたときか、`~/.storiff/config.json` に `{"with_remote": true}` と書いたときだけ。gh が入っていない、ログインしていない、ネットに出られない、GitHub ではない、といったときも取れた材料だけで動く。

## インストール
Claude Code のプラグインとして入れる。marketplace を1回追加してからインストールする。

```
/plugin marketplace add enoatu/storiff
/plugin install storiff@storiff
```

以降どのプロジェクトからでも `/storiff` で呼べる(同名コマンドと衝突するときは `/storiff:storiff`)。npm も symlink も不要。プラグインが storiff.js と skill と docs を同梱する。

セッションごとの生成物(changes.json や comments.json)は `~/.storiff/<日時>/` に置かれる。

## 設定ファイル
`~/.storiff/config.json` に既定値を書ける。`host` と `exclude`(除外するファイルパターン)と `generated`(自動生成ファイルパターン)と `with_remote`(GitHub の PR と課題も材料にするか。既定は false)に対応。

```json
{"host": "0.0.0.0"}
```

書いておくと、以降 `--host` を付けずに serve するだけで外部からホスト名で見られる。CLI の `--host` を指定した場合はそちらが優先される。0.0.0.0 は届く人全員に差分とコメントが見えるので一時的な用途に限る。

## 使い方
1. `/storiff` を実行する
2. 表示されたURLをブラウザで開き、ステップを読みながら気になる行にコメントする
3. コードを直したら「差分を取り込む」ボタンで直した分をストーリーに追従させる
4. 「レビュー完了」ボタンを押す
5. Claudeが会話上でコメントに回答する

## ファイル構成
| ファイル | 役割 |
| --- | --- |
| `storiff.js` | prep(差分解析)と serve(ビューア配信)を行うNode単一ファイル |
| `docs/story-schema.md` | データ契約 |
| `skills/storiff/SKILL.md` | `/storiff` の skill 定義 |
| `.claude-plugin/plugin.json` | プラグイン定義 |
| `.claude-plugin/marketplace.json` | marketplace 定義 |

## データ契約
changes.json と steps.json と story.json や HTTP API の定義は [docs/story-schema.md](docs/story-schema.md) を参照。
