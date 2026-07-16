#!/usr/bin/env node
/**
 * WordPress Playground を起動し、サイトマップ上の全ページをクロールして
 * 正規化した HTML を output/<WPバージョン>/ に保存する。
 *
 * Usage: node scripts/crawl.mjs [--wp=<version|latest>] [--port=<port>]
 */
import { spawn } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Playground CLI のバージョン差で出力がブレないよう固定する(環境変数で上書き可)
const PLAYGROUND_CLI = process.env.PLAYGROUND_CLI ?? '@wp-playground/cli@3.1.45';
const BOOT_TIMEOUT_MS = 10 * 60 * 1000;
// oEmbed を含むページは wasm PHP での初回レンダリングが遅いため長めにとる
const FETCH_TIMEOUT_MS = 120 * 1000;
const FETCH_RETRIES = 3;
// 保存する HTML 内の自サイト URL はポート設定に依らずこの origin に統一する
const CANONICAL_ORIGIN = 'http://127.0.0.1:9400';
// Playground はブループリント完了前にリクエストを受け始めるため、
// blueprint.json の最終ステップで blogname に設定するこの値を完了検知に使う
const READY_SENTINEL = 'wp-markup-checker';

const rootDir = path.resolve(fileURLToPath(import.meta.url), '../..');

const { values: args } = parseArgs({
  options: {
    wp: { type: 'string', default: 'latest' },
    port: { type: 'string', default: '9400' },
  },
});

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

async function main() {
  const port = Number(args.port);
  const base = `http://127.0.0.1:${port}`;

  const server = startPlayground(args.wp, port);
  const stop = () => stopPlayground(server);
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });

  try {
    console.log(`Playground を起動中 (wp=${args.wp}, port=${port})...`);
    const home = await waitForReady(base, server);

    const version = detectWpVersion(home, args.wp);
    const outDir = path.join(rootDir, 'output', version);
    const urls = await collectUrls(base);
    console.log(`WordPress ${version} / ${urls.length} URL -> ${path.relative(rootDir, outDir)}/`);

    // 途中失敗で不完全な結果が残らないよう、一時ディレクトリに保存して最後に差し替える
    const tmpDir = path.join(rootDir, 'output', `.tmp-${version}`);
    await rm(tmpDir, { recursive: true, force: true });

    let saved = 0;
    let skipped = 0;
    for (const url of urls) {
      const html = await fetchPage(url);
      if (html === null) {
        skipped += 1;
        continue;
      }
      const file = urlToFilePath(url, tmpDir);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, normalizeHtml(html, base));
      saved += 1;
    }

    await rm(outDir, { recursive: true, force: true });
    await rename(tmpDir, outDir);
    // publish.sh が「直近クロールしたバージョン」を特定するために使う
    await writeFile(path.join(rootDir, 'output', '.last-version'), `${version}\n`);
    console.log(`完了: saved=${saved} skipped=${skipped}`);
  } finally {
    stop();
  }
}

function startPlayground(wp, port) {
  const child = spawn(
    'npx',
    [
      '--yes',
      PLAYGROUND_CLI,
      'server',
      `--wp=${wp}`,
      `--port=${port}`,
      '--workers=1',
      `--blueprint=${path.join(rootDir, 'blueprint.json')}`,
      `--mount=${path.join(rootDir, 'fixtures')}:/fixtures`,
    ],
    {
      cwd: rootDir,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    },
  );
  child.on('exit', () => {
    child.exited = true;
  });
  return child;
}

function stopPlayground(child) {
  if (child.exited) return;
  // npx 経由で孫プロセスが立つため、プロセスグループごと止める
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

// blueprint 完了(= blogname がセンチネル値になる)までを起動待ちとし、
// 準備完了時点のトップページ HTML を返す
async function waitForReady(base, server) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exited) {
      throw new Error('Playground サーバーが起動前に終了しました');
    }
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const html = await res.text();
        if (html.includes(READY_SENTINEL)) return html;
      }
    } catch {
      // 起動待ち
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Playground が ${BOOT_TIMEOUT_MS / 1000} 秒以内に準備完了になりませんでした(blueprint 未完了の可能性)`,
  );
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${url}`);
  }
  return res.text();
}

// 200 なら HTML、200 以外なら null(スキップ)。タイムアウト等はリトライし、
// 尽きたら throw して不完全な output を残さない
async function fetchPage(url) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return res.text();
      console.warn(`skip (HTTP ${res.status}): ${url}`);
      return null;
    } catch (err) {
      lastErr = err;
      console.warn(`retry ${attempt}/${FETCH_RETRIES}: ${url} (${err.name ?? err})`);
    }
  }
  throw new Error(`ページ取得に失敗しました: ${url}`, { cause: lastErr });
}

function detectWpVersion(html, requested) {
  const m = html.match(/<meta name="generator" content="WordPress ([^"]+)"/);
  if (m) return m[1];
  if (/^\d+\.\d+(\.\d+)?$/.test(requested)) return requested;
  throw new Error(
    'generator メタから WP バージョンを検出できませんでした。--wp=<x.y.z> を明示してください',
  );
}

async function collectUrls(base) {
  const urls = new Set([`${base}/`]);
  const indexXml = await fetchText(`${base}/wp-sitemap.xml`);
  for (const sitemapUrl of extractLocs(indexXml)) {
    for (const loc of extractLocs(await fetchText(sitemapUrl))) {
      urls.add(loc);
    }
  }
  return [...urls].sort();
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeXmlEntities(m[1].trim()));
}

function decodeXmlEntities(s) {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&amp;', '&');
}

function urlToFilePath(url, outDir) {
  let pathname = decodeURIComponent(new URL(url).pathname);
  if (!pathname.endsWith('/')) pathname += '/';
  const file = path.resolve(outDir, pathname.replace(/^\/+/, '') + 'index.html');
  if (!file.startsWith(path.resolve(outDir) + path.sep)) {
    throw new Error(`出力先が output ディレクトリ外になる URL: ${url}`);
  }
  return file;
}

function normalizeHtml(html, base) {
  let out = html;

  // 自サイト origin をポート設定に依らず統一(素の URL / JSON エスケープ / URL エンコード)
  out = out.replaceAll(base, CANONICAL_ORIGIN);
  out = out.replaceAll(base.replaceAll('/', '\\/'), CANONICAL_ORIGIN.replaceAll('/', '\\/'));
  out = out.replaceAll(encodeURIComponent(base), encodeURIComponent(CANONICAL_ORIGIN));

  // アセットのバージョンクエリ (?ver=6.8.2 など)
  out = out.replace(/([?&](?:amp;)?ver=)[^"'&<\s]+/g, '$1');

  // WP バージョンを含む generator メタ
  out = out.replace(/[ \t]*<meta name="generator"[^>]*>\n?/g, '');

  // nonce
  out = out.replace(/(_wpnonce=)[a-zA-Z0-9]+/g, '$1__NONCE__');
  out = out.replace(/("nonce":\s*")[a-zA-Z0-9]+(")/g, '$1__NONCE__$2');

  // PHP uniqid() 由来のトークン(画像ライトボックスの imageId 等)は実行ごとに変わるため、
  // ページ内の出現順で連番に置換する(figure と Interactivity API の state の対応は保たれる)
  const uniqids = new Map();
  out = out.replace(/\b[0-9a-f]{13}\b/g, (token) => {
    if (!uniqids.has(token)) uniqids.set(token, `uid-${uniqids.size + 1}`);
    return uniqids.get(token);
  });

  if (!out.endsWith('\n')) out += '\n';
  return out;
}
