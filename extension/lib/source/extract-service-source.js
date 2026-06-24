export async function readArticleViaExtractService({ worker, session, url }) {
  if (!worker) throw new Error('未配置 Worker URL（后端抽取需要 Worker 转发）');
  const headers = { 'content-type': 'application/json' };
  if (session) headers.authorization = `Bearer ${session}`;
  const resp = await fetch(`${worker}/api/extract`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const reason = json.error || json.detail || resp.status;
    throw new Error(`后端抽取失败：${reason}`);
  }
  if (!json.markdown?.trim()) throw new Error('后端抽取结果为空');
  return {
    sourceType: json.sourceType || 'web-article',
    title: json.title || 'Untitled',
    sourceUrl: json.sourceUrl || url,
    author: json.author || '',
    siteName: json.siteName || '',
    publishedAt: json.publishedAt || '',
    markdown: json.markdown,
    images: json.images || [],
    metadata: { ...(json.metadata || {}), extraction: 'service' },
  };
}
