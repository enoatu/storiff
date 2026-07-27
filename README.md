# storiff

story + diff。巨大な差分をAIが小さな意図単位のストーリーに分解し、紙芝居形式でレビューさせるツール。[crit](https://github.com/tomasz-tomczyk/crit) をベースにした発想で、storyがありそのdiffを見れる。

でかい差分はどこから見ればいいかわからない。そこでAIにストーリーを出してもらい、少しずつ全体が分かるようにする。

## 仕組み
- skill がカレントの作業差分を story JSON にする
- Node単一ファイルの極小ローカルビューアが紙芝居と行コメントを提供する
- コメントは会話に返り、Claudeが回答する

差分の各変更行に通し番号(変更ID)を振り、Claudeがそれを意図・ビジネスロジック単位のstepにまとめる。全変更IDがどれかのstepにちょうど1回ずつ入るので、ストーリーをすべて合わせると指定した差分のdiffになる。

## インストール
Claude Code のプラグインとして入れる。marketplace を1回追加してからインストールする。

```
/plugin marketplace add enoatu/storiff
/plugin install storiff@storiff
```

以降どのプロジェクトからでも `/storiff` で呼べる(同名コマンドと衝突するときは `/storiff:storiff`)。npm も symlink も不要。プラグインが storiff.js と skill と docs を同梱する。

セッションごとの生成物(changes.json や comments.json)は `~/.storiff/<日時>/` に置かれる。

## 設定ファイル
`~/.storiff/config.json` に既定値を書ける。今のところ `host` のみ対応。

```json
{"host": "0.0.0.0"}
```

書いておくと、以降 `--host` を付けずに serve するだけで外部からホスト名で見られる。CLI の `--host` を指定した場合はそちらが優先される。0.0.0.0 は届く人全員に差分とコメントが見えるので一時的な用途に限る。

## 使い方
1. `/storiff` を実行する
2. 表示されたURLをブラウザで開き、stepを読みながら気になる行にコメントする
3. 「レビュー完了」ボタンを押す
4. Claudeが会話上でコメントに回答する

## ファイル構成
| ファイル | 役割 |
| --- | --- |
| `storiff.js` | prep(差分解析)と serve(ビューア配信)を行うNode単一ファイル |
| `docs/story-schema.md` | データ契約 |
| `skills/storiff/SKILL.md` | `/storiff` の skill 定義 |
| `.claude-plugin/plugin.json` | プラグイン定義 |
| `.claude-plugin/marketplace.json` | marketplace 定義 |

## データ契約
changes.json / steps.json / story.json や HTTP API の定義は [docs/story-schema.md](docs/story-schema.md) を参照。
