// MV3 service worker — 拉飞书 + 转 markdown。
// 不写下游 sink（Get 笔记 / 本地文件）——下游由 popup 编排，
// 因为本地文件写入需要 FSA，FSA 必须在 window 上下文 + 用户手势里跑。
import { blocksToMarkdown } from './lib/feishu-md.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'fetch') return false;
  handleFetch(msg.url).then(sendResponse).catch(e =>
    sendResponse({ ok: false, error: e?.message || String(e) })
  );
  return true; // 异步响应
});

async function handleFetch(url) {
  const cfg = await chrome.storage.local.get(['worker', 'feishuSession']);
  if (!cfg.worker) return { ok: false, error: '未配置 Worker URL（请到设置页填）' };
  if (!cfg.feishuSession) return { ok: false, error: '未登录飞书（请到设置页登录）' };

  const resp = await fetch(`${cfg.worker}/api/doc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.feishuSession}`,
    },
    body: JSON.stringify({ url }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    if (resp.status === 401) return { ok: false, error: 'session 失效，请到设置页重新登录飞书' };
    return { ok: false, error: `飞书拉取失败：${data.error || resp.status}` };
  }

  const markdown = blocksToMarkdown(data.blocks || []);
  if (!markdown.trim()) return { ok: false, error: '文档内容为空' };

  return { ok: true, title: data.title, markdown, sourceUrl: url };
}
