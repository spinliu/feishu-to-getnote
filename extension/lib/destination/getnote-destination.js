const GETNOTE_API = 'https://openapi.biji.com/open/api/v1/resource/note/save';
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|heic|heif)(?:[?#].*)?$/i;
const GETNOTE_MIN_INTERVAL_MS = 1400;
const GETNOTE_RATE_LIMIT_RETRY_MS = 3500;
let nextGetnoteAvailableAt = 0;

export async function saveToGetnote({ getKey, getCid, content }) {
  if (!getKey || !getCid) throw new Error('未配置 Get 笔记 API Key（请到设置页填）');

  const headers = {
    'content-type': 'application/json; charset=utf-8',
    authorization: getKey,
    'x-client-id': getCid,
  };

  if (shouldSaveAsLink(content)) {
    try {
      const linkJson = await postGetnote(headers, {
        note_type: 'link',
        title: content.title || 'Untitled',
        link_url: content.sourceUrl,
        tags: ['from-web', content.sourceType || 'article'],
      });
      return {
        ok: true,
        title: content.title,
        noteId: getNoteId(linkJson),
        mode: 'link',
      };
    } catch (e) {
      const fallbackJson = await savePlainText(headers, content);
      return {
        ok: true,
        title: content.title,
        noteId: getNoteId(fallbackJson),
        mode: 'plain_text_fallback',
        fallbackReason: e?.message || String(e),
      };
    }
  }

  const noteJson = await savePlainText(headers, content);
  return {
    ok: true,
    title: content.title,
    noteId: getNoteId(noteJson),
    mode: 'plain_text',
  };
}

async function savePlainText(headers, content) {
  return postGetnote(headers, {
    note_type: 'plain_text',
    title: content.title || 'Untitled',
    content: stripExternalImages(content.markdown, content.sourceUrl),
    tags: content.sourceType === 'feishu-doc' ? ['from-feishu'] : ['from-web', content.sourceType || 'article'],
  });
}

async function postGetnote(headers, body) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitForGetnoteSlot();

    const noteResp = await fetch(GETNOTE_API, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const noteJson = await noteResp.json().catch(() => ({}));
    const message = noteJson?.error?.message || noteJson?.message || String(noteResp.status);

    if (noteResp.ok && noteJson?.success) {
      if (!getNoteId(noteJson)) {
        throw new Error(`Get 笔记写入失败：接口返回成功但没有 note_id（${body.note_type}）`);
      }
      return noteJson;
    }

    lastError = new Error(`Get 笔记写入失败：${message}`);
    if (!isRateLimited(noteResp.status, message) || attempt === 3) break;
    await sleep(GETNOTE_RATE_LIMIT_RETRY_MS * attempt);
  }

  throw lastError;
}

function shouldSaveAsLink(content) {
  return content?.sourceType !== 'feishu-doc' && /^https?:\/\//.test(content?.sourceUrl || '');
}

function stripExternalImages(markdown, sourceUrl = '') {
  let text = String(markdown || '')
    .replace(/<!--\s*image omitted[\s\S]*?-->/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*]\[[^\]]*]/g, '')
    .replace(/^\s*\[[^\]]+]:\s*(https?:\/\/\S+)\s*$/gim, (match, url) => isImageUrl(url) ? '' : match)
    .replace(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g, (match, label, url) => isImageUrl(url) ? label : match)
    .replace(/(^|[\s(])https?:\/\/[^\s<>)\]]+/g, (match, prefix) => {
      const url = match.slice(prefix.length);
      return isImageUrl(url) ? prefix : match;
    })
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (sourceUrl && !text.includes(sourceUrl)) {
    text = text ? `${text}\n\n> 来源：${sourceUrl}` : `> 来源：${sourceUrl}`;
  }

  return text ? `${text}\n` : '';
}

function getNoteId(noteJson) {
  return noteJson?.data?.note_id || noteJson?.data?.id || noteJson?.note_id || '';
}

function isImageUrl(value) {
  const url = String(value || '').replace(/[),.;!?，。；！？]+$/g, '');
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return IMAGE_EXT_RE.test(parsed.pathname + parsed.search);
  } catch {
    return IMAGE_EXT_RE.test(url);
  }
}

async function waitForGetnoteSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, nextGetnoteAvailableAt - now);
  nextGetnoteAvailableAt = Math.max(now, nextGetnoteAvailableAt) + GETNOTE_MIN_INTERVAL_MS;
  if (waitMs > 0) await sleep(waitMs);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimited(status, message) {
  return status === 429 || /频率|限流|rate|too many/i.test(String(message || ''));
}
