// MV3 service worker — 实际干活的地方
import { blocksToMarkdown } from './lib/feishu-md.js';

const GETNOTE_API = 'https://openapi.biji.com/open/api/v1/resource/note/save';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'import') return false;
  handleImport(msg.url).then(sendResponse).catch(e =>
    sendResponse({ ok: false, error: e?.message || String(e) })
  );
  return true; // 异步响应
});

async function handleImport(url) {
  const cfg = await chrome.storage.local.get(['worker', 'getKey', 'getCid', 'feishuSession']);
  if (!cfg.worker) return { ok: false, error: '未配置 Worker URL（请到设置页填）' };
  if (!cfg.feishuSession) return { ok: false, error: '未登录飞书（请到设置页登录）' };
  if (!cfg.getKey || !cfg.getCid) return { ok: false, error: '未配置 Get 笔记 API Key（请到设置页填）' };

  // 1. 拉飞书 blocks
  const docResp = await fetch(`${cfg.worker}/api/doc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.feishuSession}`,
    },
    body: JSON.stringify({ url }),
  });
  const docJson = await docResp.json();
  if (!docResp.ok) {
    if (docResp.status === 401) {
      return { ok: false, error: 'session 失效，请到设置页重新登录飞书' };
    }
    return { ok: false, error: `飞书拉取失败：${docJson.error || docResp.status}` };
  }

  // 2. blocks → markdown
  const md = blocksToMarkdown(docJson.blocks || []);
  if (!md.trim()) return { ok: false, error: '文档内容为空' };

  // 3. 写 Get 笔记
  const noteResp = await fetch(GETNOTE_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: cfg.getKey,
      'x-client-id': cfg.getCid,
    },
    body: JSON.stringify({
      note_type: 'plain_text',
      title: docJson.title || '未命名飞书文档',
      content: md,
      tags: ['from-feishu'],
    }),
  });
  const noteJson = await noteResp.json();
  if (!noteResp.ok || !noteJson?.success) {
    return { ok: false, error: `Get 笔记写入失败：${noteJson?.error?.message || noteResp.status}` };
  }

  return { ok: true, title: docJson.title, noteId: noteJson?.data?.note_id };
}
