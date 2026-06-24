export async function saveToFeishuDoc({ worker, session, content }) {
  const resp = await fetch(`${worker}/api/feishu/doc/create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session}`,
    },
    body: JSON.stringify(content),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const reason = json.error || json.detail || resp.status;
    throw new Error(`飞书文档写入失败：${reason}`);
  }
  if (!json.url && !json.documentId) {
    throw new Error('飞书文档写入失败：接口返回成功但没有文档链接或 documentId');
  }
  return {
    ok: true,
    title: json.title || content.title,
    url: json.url,
    documentId: json.documentId,
    mode: json.mode,
    imageTransfer: json.imageTransfer || null,
  };
}
