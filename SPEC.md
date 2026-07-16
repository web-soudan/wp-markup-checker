# wp-markup-checker 仕様

WordPress コアのバージョンアップによって、フロントエンドのマークアップ(特にブロックの出力 HTML)に意図しない差異が生じていないかを検出するツール。

## 目的

- WP コアのバージョン間でレンダリング済み HTML を比較し、マークアップの差異(リグレッション)を早期に発見する
- クロール結果を orphan ブランチ `crawl-output` に固定パスでコミットし `wp-<version>` タグを付与。GitHub の compare(`compare/wp-A...wp-B`)でファイル差分としてレビューできる状態にする
- main ブランチと ローカルの `output/` はクロール結果を持たない(一時ファイル扱い・gitignore)

## 実行環境

- WordPress Playground(`@wp-playground/cli`)で実行する。**wp-env / Docker は使わない**
- Node.js >= 20.18 + Playwright(Chromium。再保存処理で使用。Playground CLI は `npx` で実行)
- ローカルと GitHub Actions の両方で動作する
- Playground は `--workers=1` で起動する(マルチワーカーによる非決定的な挙動を避ける)
- blueprint の `wp-cli` ステップは使わない(この環境で SQLite のファイルロックがハングするため、`runPHP` で代替)

## 構成

| 項目 | 内容 |
|---|---|
| 比較対象 | **WordPress コア**のバージョン(`--wp=` で指定。`latest` 可) |
| テーマ | Twenty Twenty-Five を**バージョン固定**(zip URL 指定)で有効化。全 WP バージョンで同一テーマにし、コア由来の差分だけを見る |
| テストデータ | [theme-test-data](https://github.com/WordPress/theme-test-data) の `64-block-test-data.xml` を `fixtures/` にベンダリング(上流変更による結果ブレ防止) |
| 初期コンテンツ | WP が自動生成する post ID 1「Hello world!」は評価対象外のため、**インポート前に削除**(blueprint の `runPHP` ステップ) |
| 再保存 | インポートだけでは「エディタで開いて保存した時のブロック変換(deprecation の migrate / 再シリアライズ)」が反映されないため、クロール前に**全投稿・固定ページをエディタ相当で無変更保存**する。Playwright で管理画面のエディタを1回読み込み、そのページ上で `wp.blocks.parse()` → `wp.blocks.serialize()` を各投稿に適用し、変換があったものだけ REST API で保存(起動中バージョン同梱のエディタ JS を使用)。`--skip-resave` で省略可 |
| パーマリンク | WP 新規インストールのデフォルト(day and name: `/%year%/%monthnum%/%day%/%postname%/`)をそのまま使用 |
| サイト名 | blueprint の最終ステップで `wp-markup-checker` に設定。Playground は blueprint 完了前にリクエストを受け始めるため、クローラーはこの値を**完了検知のセンチネル**として待機する |
| クロール範囲 | `wp-sitemap.xml` に載る全 URL(投稿・固定ページ・アーカイブ)+ トップページ |
| ローカル出力先 | `output/<実際のWPバージョン>/`(gitignore 対象の一時ファイル)。`latest` 指定時も generator メタから実バージョンを取得してフォルダ名にする。直近バージョンは `output/.last-version` に記録 |
| 公開先 | `scripts/publish.sh` が orphan ブランチ `crawl-output` の**固定パス** `output/` にコミットし、`wp-<version>` タグを付与(同一内容の再公開はスキップ) |

## HTML の正規化

git 差分のノイズを防ぐため、保存前に以下の可変値を正規化する:

- `?ver=<version>` クエリ(スクリプト/スタイル)→ `?ver=` に統一
- `<meta name="generator" ...>` を除去(フォルダ名決定に使用後)
- nonce らしきトークン(`_wpnonce=<hex>` 等)→ 固定文字列に置換
- 自サイトの origin → ポート設定に依らず `http://127.0.0.1:9400` に統一(JSONエスケープ形・URLエンコード形も対象)
- PHP `uniqid()` 由来の13桁hexトークン(画像ライトボックスの `imageId` 等、実行ごとに変わる)→ ページ内の出現順に `uid-1`, `uid-2`, ... へ置換
- ファイル末尾に改行を保証

また、wp-config 定数 `DISABLE_WP_CRON=true` / `WP_DEBUG=false` / `SCRIPT_DEBUG=false` を blueprint で明示し、cron のループバックによるストールとデバッグ用マークアップの混入を防ぐ。

**同一バージョンで何度実行しても差分が出ないこと(冪等性)を保証する。**

## 使い方

```bash
# クロール(output/<version>/ に一時保存)
npm run crawl -- --wp=6.8
npm run crawl            # latest

# crawl-output ブランチへコミット + wp-<version> タグ付与(直近クロール分)
npm run release          # push する場合: npm run release -- --push

# ローカルでのバージョン間差分
npm run diff -- output/6.7.5 output/6.8.5   # 一時フォルダ同士
git diff wp-6.7.5 wp-6.8.5                   # タグ同士
```

GitHub 上では `https://github.com/web-soudan/wp-markup-checker/compare/wp-6.7.5...wp-6.8.5` で差分を見る。

## GitHub Actions

- `workflow_dispatch`(WP バージョン入力: `6.8` / `latest` / `auto`)+ `schedule`(**6時間ごと**)
- 定期実行(および `auto` 指定時)は [stable-check API](https://api.wordpress.org/core/stable-check/1.0/) で最新安定版を取得し、**`wp-<version>` タグが未作成の場合のみ**クロールを実行(クロール済みなら数十秒でスキップ)
- クロール後、`publish.sh --push` で `crawl-output` ブランチと `wp-<version>` タグを push
- 直前バージョンのタグとの `diff --stat` と compare URL をジョブサマリーに出力
- 新しい WP がリリースされると、最大6時間以内に新しいタグが自動的に追加される

## ディレクトリ構成

```
wp-markup-checker/                # main ブランチ(コードのみ)
├── SPEC.md                      # 本ファイル
├── README.md                    # 使い方
├── package.json                 # scripts: crawl / release / diff
├── blueprint.json               # Playground ブループリント
├── fixtures/
│   └── 64-block-test-data.xml   # テストデータ(ベンダリング)
├── scripts/
│   ├── crawl.mjs                # 起動→クロール→正規化→保存
│   └── publish.sh               # crawl-output ブランチへコミット + タグ付与
├── output/                      # ローカル一時ファイル(gitignore)
│   ├── .last-version
│   └── <wp-version>/
└── .github/workflows/crawl.yml

crawl-output ブランチ(orphan・クロール結果のみ)
├── README.md
└── output/                      # 固定パス。コミットごとに wp-<version> タグ
```
