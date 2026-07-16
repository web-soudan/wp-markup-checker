# wp-markup-checker

WordPress コアのバージョンアップによるフロントエンドのマークアップ差異(ブロック出力 HTML のリグレッション)を検出するツール。

WordPress Playground(`@wp-playground/cli`)でテストデータ入りの WordPress を起動し、サイトマップ上の全ページをクロールして正規化した HTML を保存します。結果は orphan ブランチ `crawl-output` に `wp-<version>` タグ付きでコミットされ、GitHub の compare でバージョン間の差分をレビューします(ローカルの `output/` は一時ファイル扱いで git 管理外)。

詳細な仕様は [SPEC.md](SPEC.md) を参照してください。

## 必要環境

- Node.js >= 20.18(Docker 不要)

```bash
npm install
npx playwright install chromium   # 再保存処理で使用
```

## 使い方

```bash
# 指定バージョンをクロール(output/<実バージョン>/ に一時保存)
npm run crawl -- --wp=6.8

# 最新版をクロール
npm run crawl

# crawl-output ブランチへコミット + wp-<version> タグ付与(直近クロール分)
npm run release
```

クロール前に、全投稿・固定ページを起動中バージョンのエディタ相当で「無変更保存」します(保存時のブロック変換を反映させるため。詳細は [SPEC.md](SPEC.md))。この処理を省く場合は `npm run crawl -- --skip-resave` を使います。

- `--wp=latest` 指定時もフォルダ名・タグ名は generator メタから取得した実バージョン(例 `6.8.5`)になります
- ポートが競合する場合は `--port=<port>` を指定してください(保存される HTML 内の URL はポートに依らず正規化されます)

## 差分の見方

- **GitHub 上**: [web-soudan/wp-markup-checker/compare/wp-6.7.5...wp-6.8.5](https://github.com/web-soudan/wp-markup-checker/compare/wp-6.7.5...wp-6.8.5) — 同一パスのファイル差分として表示されます
- **ローカル(タグ同士)**: `git diff wp-6.7.5 wp-6.8.5`
- **ローカル(一時フォルダ同士)**: `npm run diff -- output/6.7.5 output/6.8.5`
- 同一バージョンで再実行しても差分は出ません(`?ver=` クエリ・generator メタ・nonce・`uniqid()` トークン等は正規化済み)
- 差分が出た場合、それは WP コアのバージョン間でマークアップが変わったことを意味します
- テーマは Twenty Twenty-Five をバージョン固定([blueprint.json](blueprint.json) の zip URL)で使用しているため、テーマ由来の差分は混ざりません

## GitHub Actions

[.github/workflows/crawl.yml](.github/workflows/crawl.yml)

- **workflow_dispatch**: WP バージョンを指定して手動実行(`6.8` / `latest` / `auto`)
- **schedule**: 6時間ごとに自動実行。[stable-check API](https://api.wordpress.org/core/stable-check/1.0/) の最新安定版が未クロールの場合のみ実行するため、新しい WP がリリースされると最大6時間以内に `wp-<version>` タグが自動で追加される(クロール済みならスキップ)
- クロール後、直前バージョンのタグとの `diff --stat` と compare URL をジョブサマリーに出力

## 構成メモ

- テストデータ: [theme-test-data](https://github.com/WordPress/theme-test-data) の `64-block-test-data.xml` を [fixtures/](fixtures/) にベンダリング
- Playground CLI のバージョンは [scripts/crawl.mjs](scripts/crawl.mjs) 内で固定(環境変数 `PLAYGROUND_CLI` で上書き可)
- テーマ(Twenty Twenty-Five)や Playground CLI のバージョンを上げる場合は、上げた直後に全バージョンを再クロールして基準を揃えること
