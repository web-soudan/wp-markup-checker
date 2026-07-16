/**
 * 起動中の WordPress のブロックエディタ JS を使って、全投稿・固定ページを
 * 「エディタで開いて無変更のまま保存」した状態にする。
 *
 * WXR インポートは旧バージョンのマークアップをそのまま DB に入れるため、
 * エディタの保存時に起きるブロック変換(deprecation の migrate / 再シリアライズ)が
 * 反映されない。管理画面のエディタページを1回読み込み、そのページ上で
 * wp.blocks.parse() → wp.blocks.serialize() を各投稿に適用することで、
 * 起動中バージョンに同梱された正確なエディタ JS による変換を再現する。
 */
import { chromium } from 'playwright';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'password';
const EDITOR_TIMEOUT_MS = 240 * 1000;

export async function resaveAllPosts(base) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    await page.goto(`${base}/wp-login.php`, { waitUntil: 'domcontentloaded', timeout: EDITOR_TIMEOUT_MS });
    await page.fill('#user_login', ADMIN_USER);
    await page.fill('#user_pass', ADMIN_PASS);
    await Promise.all([
      page.waitForURL('**/wp-admin/**', { timeout: EDITOR_TIMEOUT_MS }),
      page.click('#wp-submit'),
    ]);

    // エディタ JS(ブロック定義一式)を読み込むため、任意の1投稿の編集画面を開く
    const res = await fetch(`${base}/wp-json/wp/v2/posts?per_page=1&_fields=id`);
    const [first] = await res.json();
    if (!first?.id) {
      throw new Error('再保存対象の投稿が見つかりません(インポート失敗の可能性)');
    }
    await page.goto(`${base}/wp-admin/post.php?post=${first.id}&action=edit`, {
      waitUntil: 'domcontentloaded',
      timeout: EDITOR_TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => window.wp?.blocks?.parse && window.wp?.apiFetch && window.wp.blocks.getBlockTypes().length > 50,
      { timeout: EDITOR_TIMEOUT_MS },
    );

    const summary = { checked: 0, resaved: 0, converted: [] };
    for (const type of ['posts', 'pages']) {
      const ids = await page.evaluate(async (t) => {
        const out = [];
        for (let p = 1; ; p++) {
          const items = await window.wp.apiFetch({
            path: `/wp/v2/${t}?per_page=100&page=${p}&status=publish&orderby=id&order=asc&_fields=id`,
          });
          out.push(...items.map((i) => i.id));
          if (items.length < 100) break;
        }
        return out;
      }, type);

      for (const id of ids) {
        const changed = await page.evaluate(
          async ({ t, postId }) => {
            const item = await window.wp.apiFetch({ path: `/wp/v2/${t}/${postId}?context=edit` });
            const raw = item.content?.raw ?? '';
            const converted = window.wp.blocks.serialize(window.wp.blocks.parse(raw));
            if (converted === raw) return null;
            await window.wp.apiFetch({
              path: `/wp/v2/${t}/${postId}`,
              method: 'POST',
              data: { content: converted },
            });
            return item.slug ?? String(postId);
          },
          { t: type, postId: id },
        );
        summary.checked += 1;
        if (changed !== null) {
          summary.resaved += 1;
          summary.converted.push(`${type}/${changed}`);
        }
      }
    }
    return summary;
  } finally {
    await browser.close();
  }
}
