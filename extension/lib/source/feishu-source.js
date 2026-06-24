import { blocksToMarkdown } from '../feishu-md.js';

export async function readFeishuDocument({ worker, session, url }) {
  const docResp = await fetch(`${worker}/api/doc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session}`,
    },
    body: JSON.stringify({ url }),
  });
  const docJson = await docResp.json().catch(() => ({}));
  if (!docResp.ok) {
    const reason = docJson.error || docJson.detail || docResp.status;
    throw new Error(`飞书拉取失败：${reason}`);
  }

  const markdown = blocksToMarkdown(docJson.blocks || []);
  if (!markdown.trim()) throw new Error('文档内容为空');

  return {
    sourceType: 'feishu-doc',
    title: docJson.title || '未命名飞书文档',
    sourceUrl: url,
    markdown,
    images: [],
    metadata: {},
  };
}
