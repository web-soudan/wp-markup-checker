#!/bin/bash
# クロール結果を orphan ブランチ crawl-output に固定パス output/ でコミットし、
# wp-<version> タグを付ける。差分は GitHub の compare/wp-A...wp-B で見る。
#
# Usage: bash scripts/publish.sh [version] [--push]
#   version 省略時は output/.last-version(直近の npm run crawl の結果)を使う
#   --push を付けると origin へブランチとタグを push する(CI 用)
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH=crawl-output

push=0
version=""
for arg in "$@"; do
  case "$arg" in
    --push) push=1 ;;
    *) version="$arg" ;;
  esac
done
if [ -z "$version" ]; then
  version=$(cat output/.last-version 2>/dev/null || true)
fi
if [ -z "$version" ] || [ ! -d "output/$version" ]; then
  echo "クロール結果が見つかりません: output/${version:-<version>}(先に npm run crawl を実行)" >&2
  exit 1
fi
tag="wp-$version"

# リモートがあれば既存ブランチ・タグを取得(初回や remote 無しは無視)
git fetch origin "$BRANCH" --tags 2>/dev/null || true

# ブランチにコミットする内容を一時ディレクトリに構成(固定パス output/)
tmpwork=$(mktemp -d)
trap 'rm -rf "$tmpwork"' EXIT
mkdir -p "$tmpwork/output"
cp -R "output/$version/." "$tmpwork/output/"
find "$tmpwork" -name .DS_Store -delete
cat > "$tmpwork/README.md" <<EOF
# crawl-output

wp-markup-checker のクロール結果のみを積む orphan ブランチです(main とは独立)。
各コミットに \`wp-<WPバージョン>\` タグが付きます。

バージョン間のマークアップ差分は GitHub の compare で確認します:
\`https://github.com/web-soudan/wp-markup-checker/compare/wp-6.7.5...wp-6.8.5\`
EOF

# 一時 index に構成内容をステージして tree を作る(main の作業ツリーには触れない)
idx=$(mktemp -u)
export GIT_INDEX_FILE="$idx"
repo_git_dir=$(git rev-parse --absolute-git-dir)
(cd "$tmpwork" && GIT_DIR="$repo_git_dir" git add -A .)
tree=$(git write-tree)
unset GIT_INDEX_FILE
rm -f "$idx"

# 同一バージョン・同一内容が公開済みならスキップ
if existing=$(git rev-parse -q --verify "refs/tags/$tag^{commit}"); then
  if [ "$(git rev-parse "$existing^{tree}")" = "$tree" ]; then
    echo "変更なし: $tag は同一内容で公開済み"
    if [ "$push" = 1 ]; then
      git push origin "refs/tags/$tag" 2>/dev/null || true
    fi
    exit 0
  fi
fi

parent=$(git rev-parse -q --verify "refs/remotes/origin/$BRANCH^{commit}" \
  || git rev-parse -q --verify "refs/heads/$BRANCH^{commit}" || true)

name=$(git config user.name 2>/dev/null || echo "github-actions[bot]")
email=$(git config user.email 2>/dev/null || echo "41898282+github-actions[bot]@users.noreply.github.com")
if [ -n "$parent" ]; then
  commit=$(git -c user.name="$name" -c user.email="$email" commit-tree "$tree" -p "$parent" -m "WordPress $version")
else
  commit=$(git -c user.name="$name" -c user.email="$email" commit-tree "$tree" -m "WordPress $version")
fi

git update-ref "refs/heads/$BRANCH" "$commit"
git tag -f "$tag" "$commit"
echo "コミット作成: $BRANCH -> $commit ($tag)"

if [ "$push" = 1 ]; then
  git push origin "refs/heads/$BRANCH"
  git push --force origin "refs/tags/$tag"
  echo "push 完了: $BRANCH, $tag"
fi
