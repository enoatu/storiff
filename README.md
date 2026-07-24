# storiff

story + diff。巨大な差分をAIが小さな意図単位のストーリーに分解し、紙芝居形式でレビューさせるツール。[crit](https://github.com/tomasz-tomczyk/crit) をベースにした発想で、storyがありそのdiffを見れる。

でかい差分はどこから見ればいいかわからない。そこでAIにストーリーを出してもらい、少しずつ全体が分かるようにする。

## 仕組み
- skill がカレントの作業差分を story JSON にする
- Node単一ファイルの極小ローカルビューアが紙芝居と行コメントを提供する
- コメントは会話に返り、Claudeが回答する

差分の各変更行に通し番号(変更ID)を振り、Claudeがそれを意図・ビジネスロジック単位のstepにまとめる。全変更IDがどれかのstepにちょうど1回ずつ入るので、ストーリーをすべて合わせると指定した差分のdiffになる。

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
| `.claude/skills/storiff/SKILL.md` | `/storiff` の skill 定義 |

## データ契約
changes.json / steps.json / story.json や HTTP API の定義は [docs/story-schema.md](docs/story-schema.md) を参照。
