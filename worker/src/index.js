// lark-doc-proxy — Cloudflare Worker
// 职责：飞书 OAuth + 文档 blocks 代拉
// 不做：下游笔记 API（Get 笔记 / Obsidian 等由各自插件自己调）

const SCOPES = [
  'docx:document:readonly',
  'wiki:wiki:readonly',
  'docx:document:create',
  'docs:document:import',
].join(' ');
const STATE_TTL_SEC = 600;
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 天，refresh_token 兜底
const REFRESH_SKEW_SEC = 300;
const FEISHU_IMAGE_LIMIT = 20;
const IMAGE_ANCHOR_PREFIX = 'ZylosImageAnchor';
const refreshFlights = new Map();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
  });

const err = (msg, status = 400, extra = {}) => json({ error: msg, ...extra }, status);

const uuid = () => crypto.randomUUID();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return json({ ok: true });

    try {
      if (url.pathname === '/oauth/start')   return oauthStart(req, env, url);
      if (url.pathname === '/oauth/callback')return oauthCallback(req, env, url);
      if (url.pathname === '/api/doc' && req.method === 'POST') return apiDoc(req, env);
      if (url.pathname === '/api/session' && req.method === 'GET') return apiSession(req, env);
      if (url.pathname === '/api/extract' && req.method === 'POST') return apiExtract(req, env);
      if (url.pathname === '/api/feishu/doc/create' && req.method === 'POST') return apiFeishuDocCreate(req, env);
      if (url.pathname === '/health' || url.pathname === '/') return health(env);
      return err('not_found', 404);
    } catch (e) {
      return err('internal_error', 500, { detail: String(e?.message || e) });
    }
  },
};

// ---------- OAuth ----------

// GET /oauth/start?redirect=<chrome-ext-callback-url>
//   插件用 chrome.identity.launchWebAuthFlow 把 redirect 设为
//   `https://<ext-id>.chromiumapp.org/` 然后跳到本端点。
//   本端点存 state -> redirect，跳飞书授权页。
async function oauthStart(req, env, url) {
  const redirect = url.searchParams.get('redirect');
  if (!redirect) return err('missing_redirect');
  if (!isAllowedRedirect(redirect, env)) return err('bad_redirect', 403);

  const configError = requireFeishuOAuthConfig(env);
  if (configError) return configError;

  const state = uuid();
  await env.SESSIONS.put(`state:${state}`, redirect, { expirationTtl: STATE_TTL_SEC });

  const proxyCallback = `${url.origin}/oauth/callback`;
  const authUrl = new URL(`${env.LARK_OAUTH_BASE}/open-apis/authen/v1/authorize`);
  authUrl.searchParams.set('client_id', env.LARK_APP_ID);
  authUrl.searchParams.set('redirect_uri', proxyCallback);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

// GET /oauth/callback?code=xxx&state=xxx
//   飞书回调到这里。用 code 换 token，存 KV，把 session_key 回带给插件 redirect。
async function oauthCallback(req, env, url) {
  const configError = requireFeishuOAuthConfig(env);
  if (configError) return configError;

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return err('missing_code_or_state');

  const redirect = await env.SESSIONS.get(`state:${state}`);
  if (!redirect) return err('state_expired_or_invalid', 403);
  await env.SESSIONS.delete(`state:${state}`);

  const proxyCallback = `${url.origin}/oauth/callback`;
  const tokenResp = await fetch(`${env.LARK_API_BASE}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: env.LARK_APP_ID,
      client_secret: env.LARK_APP_SECRET,
      code,
      redirect_uri: proxyCallback,
    }),
  });
  const tok = await tokenResp.json();
  if (!tokenResp.ok || tok.code) return err('feishu_token_exchange_failed', 502, { detail: tok });

  const session_key = uuid();
  const now = Math.floor(Date.now() / 1000);
  await env.SESSIONS.put(
    `sess:${session_key}`,
    JSON.stringify({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: now + (tok.expires_in || 7200) - 60,
      refresh_expires_at: now + (tok.refresh_expires_in || 60 * 60 * 24 * 30) - 60,
    }),
    { expirationTtl: SESSION_TTL_SEC }
  );

  const back = new URL(redirect);
  back.searchParams.set('session', session_key);
  return Response.redirect(back.toString(), 302);
}

// GET /api/session — 探活，验 session 是否有效
async function apiSession(req, env) {
  const session = bearer(req);
  if (!session) return err('missing_session', 401);
  const result = await ensureAccessTokenResult(env, session);
  if (!result.ok) return err(result.error, 401, result.extra || {});
  return json({ ok: true, expires_at: result.expires_at });
}

// ---------- 飞书文档代理 ----------

// POST /api/doc  body: { url: "<feishu doc/wiki url or token>" }
// 返回: { title, blocks: [...] }
async function apiDoc(req, env) {
  const session = bearer(req);
  if (!session) return err('missing_session', 401);

  let body;
  try { body = await req.json(); } catch { return err('bad_json'); }
  const docUrl = body?.url;
  if (!docUrl) return err('missing_url');

  const parsed = parseFeishuUrl(docUrl);
  if (!parsed) return err('unrecognized_feishu_url');

  const access = await ensureAccessToken(env, session);
  if (!access) return err('session_invalid_or_expired', 401);

  let docId = parsed.token;
  if (parsed.kind === 'wiki') {
    const node = await larkGet(env, access, `/open-apis/wiki/v2/spaces/get_node?token=${parsed.token}`);
    if (node?.code) return err('wiki_node_fetch_failed', 502, { detail: node });
    if (node?.data?.node?.obj_type !== 'docx') return err('wiki_node_not_docx', 400, { obj_type: node?.data?.node?.obj_type });
    docId = node.data.node.obj_token;
  }

  // 标题
  const meta = await larkGet(env, access, `/open-apis/docx/v1/documents/${docId}`);
  if (meta?.code) return err('doc_meta_fetch_failed', 502, { detail: meta });
  const title = meta?.data?.document?.title || 'Untitled';

  // blocks 分页
  const blocks = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) { // 50 页 * 500 = 25000 blocks，安全上限
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const page = await larkGet(env, access, `/open-apis/docx/v1/documents/${docId}/blocks?${qs}`);
    if (page?.code) return err('blocks_fetch_failed', 502, { detail: page });
    blocks.push(...(page?.data?.items || []));
    if (!page?.data?.has_more) break;
    pageToken = page.data.page_token || '';
    if (!pageToken) break;
  }

  return json({ title, blocks });
}

// POST /api/extract body: { url }
// Worker 只做转发，不在边缘运行 Python/scrapling。
async function apiExtract(req, env) {
  if (!env.EXTRACTOR_API_URL) {
    return err('extractor_not_configured', 501, {
      hint: 'Configure EXTRACTOR_API_URL to a trusted article extraction service. Worker only routes requests.',
    });
  }

  let body;
  try { body = await req.json(); } catch { return err('bad_json'); }
  if (!body?.url) return err('missing_url');

  const headers = { 'content-type': 'application/json' };
  if (env.EXTRACTOR_API_TOKEN) headers.authorization = `Bearer ${env.EXTRACTOR_API_TOKEN}`;
  const resp = await fetch(env.EXTRACTOR_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: body.url }),
  });
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: {
      'content-type': resp.headers.get('content-type') || 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
  });
}

// POST /api/feishu/doc/create
// P0: use Feishu's docs_ai import endpoint to create a Docx from Markdown.
async function apiFeishuDocCreate(req, env) {
  const session = bearer(req);
  if (!session) return err('missing_session', 401);
  const access = await ensureAccessToken(env, session);
  if (!access) return err('session_invalid_or_expired', 401);

  let body;
  try { body = await req.json(); } catch { return err('bad_json'); }
  if (!body?.markdown?.trim()) return err('missing_markdown');

  if (!env.FEISHU_DOC_CREATE_API_URL) {
    return createFeishuDocFromMarkdown(env, access, body);
  }

  const resp = await fetch(env.FEISHU_DOC_CREATE_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${access}`,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: {
      'content-type': resp.headers.get('content-type') || 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
  });
}

async function createFeishuDocFromMarkdown(env, access, content) {
  const prepared = buildFeishuMarkdown(content);
  const body = {
    content: prepared.markdown,
    format: 'markdown',
  };

  if (content.parentToken || env.FEISHU_DOC_PARENT_TOKEN) {
    body.parent_token = content.parentToken || env.FEISHU_DOC_PARENT_TOKEN;
  } else if (content.parentPosition || env.FEISHU_DOC_PARENT_POSITION) {
    body.parent_position = content.parentPosition || env.FEISHU_DOC_PARENT_POSITION;
  }

  const created = await larkPost(env, access, '/open-apis/docs_ai/v1/documents', body);
  if (!created.ok) {
    return err('feishu_doc_create_failed', 502, { detail: created.detail });
  }

  const doc = created.data?.data?.document || created.data?.document || created.data?.data || {};
  const url = doc.url || created.data?.data?.url || '';
  const documentId =
    doc.document_id ||
    doc.documentId ||
    doc.token ||
    created.data?.data?.document_id ||
    parseDocumentId(url);
  if (!documentId && !url) {
    return err('feishu_doc_create_no_document', 502, { detail: created.data });
  }

  const imageTransfer = documentId
    ? await insertFeishuImages(env, access, documentId, prepared.images)
    : { attempted: 0, inserted: 0, failed: 0, errors: ['missing_document_id'] };

  return json({
    ok: true,
    title: content.title || doc.title || 'Untitled',
    url,
    documentId,
    mode: 'docs_ai_markdown',
    imageTransfer,
  });
}

function buildFeishuMarkdown(content) {
  const title = String(content.title || 'Untitled').trim() || 'Untitled';
  const prepared = prepareMarkdownImages(content.markdown, content.images);
  let markdown = prepared.markdown;
  if (!/^#\s+/.test(markdown)) {
    markdown = `# ${title}\n\n${markdown}`;
  }
  return {
    markdown: markdown.trim() + '\n',
    images: prepared.images,
  };
}

function prepareMarkdownImages(markdown, imageCandidates) {
  const seen = new Set();
  const images = [];
  const input = String(markdown || '')
    .replace(/<!--\s*image omitted[\s\S]*?-->/gi, '')
    .replace(/!\[[^\]]*]\[[^\]]*]/g, '');
  const output = input.replace(
    /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)|<img\b[^>]*>/gi,
    (match, markdownAlt, markdownSrc) => {
      const html = match.startsWith('<') ? parseHtmlImage(match) : null;
      const src = normalizeImageUrl(markdownSrc || html?.src || '');
      if (!src || seen.has(src)) return '';
      seen.add(src);
      if (images.length >= FEISHU_IMAGE_LIMIT) return '';
      const image = {
        src,
        alt: String(markdownAlt || html?.alt || '').trim(),
        marker: imageAnchor(images.length + 1, src),
      };
      images.push(image);
      return `\n\n${image.marker}\n\n`;
    }
  );

  for (const image of normalizeImageList(imageCandidates)) {
    if (images.length >= FEISHU_IMAGE_LIMIT) break;
    if (seen.has(image.src)) continue;
    seen.add(image.src);
    images.push(image);
  }

  return {
    markdown: output.replace(/\n{3,}/g, '\n\n').trim(),
    images,
  };
}

async function insertFeishuImages(env, access, documentId, images) {
  const normalized = normalizeImageList(images).slice(0, FEISHU_IMAGE_LIMIT);
  if (!normalized.length) return { attempted: 0, inserted: 0, failed: 0, errors: [] };

  const anchorMarkers = normalized.map(image => image.marker).filter(Boolean);
  const anchorBlocks = anchorMarkers.length
    ? await findImageAnchorBlocks(env, access, documentId, anchorMarkers)
    : new Map();
  const errors = [];
  let inserted = 0;
  let positioned = 0;
  let appended = 0;
  const cleanupBlockIds = [];

  for (const image of normalized) {
    const anchorBlockId = image.marker ? anchorBlocks.get(image.marker) : '';
    const result = await larkPut(env, access, `/open-apis/docs_ai/v1/documents/${documentId}`, {
      block_id: anchorBlockId || '-1',
      command: 'block_insert_after',
      content: buildImageXml(image),
      format: 'xml',
      revision_id: -1,
    });
    if (result.ok) {
      inserted++;
      if (anchorBlockId) {
        positioned++;
        cleanupBlockIds.push(anchorBlockId);
      } else {
        appended++;
      }
    } else {
      errors.push(`${image.src}: ${summarizeFeishuError(result.detail)}`);
    }
  }

  const cleanup = await cleanupImageAnchors(
    env,
    access,
    documentId,
    cleanupBlockIds,
    normalized.map(image => image.marker).filter(Boolean)
  );
  if (cleanup.error) errors.push(cleanup.error);

  return {
    attempted: normalized.length,
    inserted,
    positioned,
    appended,
    failed: normalized.length - inserted,
    errors: errors.slice(0, 5),
  };
}

function normalizeImageList(images) {
  const seen = new Set();
  const out = [];
  for (const image of Array.isArray(images) ? images : []) {
    const src = normalizeImageUrl(image?.src || image?.url || image);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({
      src,
      alt: String(image?.alt || '').trim(),
      marker: String(image?.marker || '').trim(),
    });
  }
  return out;
}

function normalizeImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function buildImageXml(image) {
  const items = [`<img href="${escapeXml(image.src)}"/>`];
  if (image.alt) items.push(`<p>${escapeXml(image.alt)}</p>`);
  return items.join('\n');
}

function parseHtmlImage(value) {
  const src = attrOf(value, 'src') || attrOf(value, 'href');
  const alt = attrOf(value, 'alt');
  return { src, alt };
}

function attrOf(value, name) {
  const match = String(value || '').match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match?.[2] || '';
}

function imageAnchor(index, src) {
  return `${IMAGE_ANCHOR_PREFIX}:${index}:${hashString(src)}`;
}

async function findImageAnchorBlocks(env, access, documentId, markers) {
  const wanted = new Set(markers);
  for (let attempt = 0; attempt < 4; attempt++) {
    const blocks = await fetchDocumentBlocks(env, access, documentId).catch(() => []);
    const found = new Map();
    for (const block of blocks) {
      const text = blockText(block);
      for (const marker of wanted) {
        if (!found.has(marker) && text.includes(marker)) {
          found.set(marker, block.block_id);
        }
      }
    }
    if (found.size === wanted.size || attempt === 3) return found;
    await sleep(250 * (attempt + 1));
  }
  return new Map();
}

async function fetchDocumentBlocks(env, access, documentId) {
  const blocks = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const page = await larkGet(env, access, `/open-apis/docx/v1/documents/${documentId}/blocks?${qs}`);
    if (page?.code) throw new Error(summarizeFeishuError(page));
    blocks.push(...(page?.data?.items || []));
    if (!page?.data?.has_more) break;
    pageToken = page.data.page_token || '';
    if (!pageToken) break;
  }
  return blocks;
}

async function cleanupImageAnchors(env, access, documentId, blockIds, markers) {
  const uniqueBlockIds = [...new Set(blockIds.filter(Boolean))];
  const uniqueMarkers = [...new Set(markers.filter(Boolean))];
  let error = '';

  if (uniqueBlockIds.length) {
    const result = await larkPut(env, access, `/open-apis/docs_ai/v1/documents/${documentId}`, {
      block_id: uniqueBlockIds.join(','),
      command: 'block_delete',
      format: 'xml',
      revision_id: -1,
    });
    if (!result.ok) {
      error = `image_anchor_delete_failed: ${summarizeFeishuError(result.detail)}`;
    }
  }

  for (const marker of uniqueMarkers) {
    await larkPut(env, access, `/open-apis/docs_ai/v1/documents/${documentId}`, {
      command: 'str_replace',
      pattern: marker,
      content: '',
      format: 'xml',
      revision_id: -1,
    });
  }

  return { error };
}

function blockText(block) {
  const fields = [
    'text', 'bullet', 'ordered', 'code', 'quote', 'todo', 'callout',
    'heading1', 'heading2', 'heading3', 'heading4', 'heading5',
    'heading6', 'heading7', 'heading8', 'heading9',
  ];
  return fields.map(field => textNodeText(block?.[field])).join('');
}

function textNodeText(node) {
  const elements = node?.elements || [];
  return elements.map(element => {
    if (element.text_run) return element.text_run.content || '';
    if (element.equation) return element.equation.content || '';
    if (element.mention_doc) return element.mention_doc.title || '';
    if (element.mention_user) return element.mention_user.user_id || '';
    return '';
  }).join('');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseDocumentId(url) {
  const parsed = parseFeishuUrl(url);
  return parsed?.kind === 'docx' ? parsed.token : '';
}

function summarizeFeishuError(detail) {
  if (!detail) return 'unknown_error';
  return detail.msg || detail.message || detail.error || JSON.stringify(detail).slice(0, 500);
}

function health(env) {
  return json({
    name: 'lark-doc-proxy',
    ok: true,
    bindings: {
      sessions: !!env.SESSIONS,
      larkAppId: !!env.LARK_APP_ID,
      larkAppSecret: !!env.LARK_APP_SECRET,
      allowedRedirectPrefix: !!env.ALLOWED_REDIRECT_PREFIX,
      extractorApi: !!env.EXTRACTOR_API_URL,
      feishuDocCreateApi: !!env.FEISHU_DOC_CREATE_API_URL,
    },
  });
}

// ---------- 工具 ----------

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

async function loadSession(env, session_key) {
  const raw = await env.SESSIONS.get(`sess:${session_key}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveSession(env, session_key, sess) {
  await env.SESSIONS.put(`sess:${session_key}`, JSON.stringify(sess), { expirationTtl: SESSION_TTL_SEC });
}

async function ensureAccessToken(env, session_key) {
  const result = await ensureAccessTokenResult(env, session_key);
  return result.ok ? result.access_token : null;
}

async function ensureAccessTokenResult(env, session_key) {
  const sess = await loadSession(env, session_key);
  if (!sess) return { ok: false, error: 'session_invalid' };
  const now = Math.floor(Date.now() / 1000);
  if (now < (sess.expires_at - REFRESH_SKEW_SEC)) {
    return { ok: true, access_token: sess.access_token, expires_at: sess.expires_at };
  }
  if (now >= sess.refresh_expires_at) return { ok: false, error: 'refresh_token_expired' };

  if (!refreshFlights.has(session_key)) {
    refreshFlights.set(session_key, refreshAccessToken(env, session_key, sess, now).finally(() => {
      refreshFlights.delete(session_key);
    }));
  }
  return refreshFlights.get(session_key);
}

async function refreshAccessToken(env, session_key, sess, now) {
  const configError = missingFeishuOAuthConfig(env);
  if (configError) return { ok: false, error: configError };

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await refreshOnce(env, session_key, sess, now);
    if (result.ok) return result;
    if (attempt === 0 && result.retryable) continue;
    return result;
  }
  return { ok: false, error: 'refresh_failed' };
}

async function refreshOnce(env, session_key, sess, now) {
  const r = await fetch(`${env.LARK_API_BASE}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: env.LARK_APP_ID,
      client_secret: env.LARK_APP_SECRET,
      refresh_token: sess.refresh_token,
    }),
  });
  const tok = await r.json();
  if (!r.ok || tok.code) {
    return {
      ok: false,
      error: 'refresh_failed',
      retryable: r.status >= 500,
      extra: { status: r.status, detail: tok },
    };
  }

  sess.access_token = tok.access_token;
  sess.refresh_token = tok.refresh_token || sess.refresh_token;
  sess.expires_at = now + (tok.expires_in || 7200) - 60;
  if (tok.refresh_expires_in) sess.refresh_expires_at = now + tok.refresh_expires_in - 60;
  await saveSession(env, session_key, sess);
  return { ok: true, access_token: sess.access_token, expires_at: sess.expires_at };
}

async function larkGet(env, access, path) {
  const r = await fetch(`${env.LARK_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${access}` },
  });
  return r.json();
}

async function larkPost(env, access, path, body) {
  const r = await fetch(`${env.LARK_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${access}`,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.code) {
    return { ok: false, status: r.status, detail: data };
  }
  return { ok: true, status: r.status, data };
}

async function larkPut(env, access, path, body) {
  const r = await fetch(`${env.LARK_API_BASE}${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${access}`,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.code) {
    return { ok: false, status: r.status, detail: data };
  }
  return { ok: true, status: r.status, data };
}

function missingFeishuOAuthConfig(env) {
  if (!env.LARK_APP_ID) return 'lark_app_id_not_configured';
  if (!env.LARK_APP_SECRET) return 'lark_app_secret_not_configured';
  return '';
}

function requireFeishuOAuthConfig(env) {
  const missing = missingFeishuOAuthConfig(env);
  if (!missing) return null;
  return err(missing, 501, {
    hint: 'Configure LARK_APP_ID and LARK_APP_SECRET as Worker secrets before using Feishu OAuth.',
  });
}

// 支持的飞书 URL 形态：
//   https://xxx.feishu.cn/docx/<token>
//   https://xxx.feishu.cn/docs/<token>
//   https://xxx.feishu.cn/wiki/<token>
//   https://xxx.larksuite.com/docx/<token>  等
// 也直接接受裸 token 字符串（无 /）
function parseFeishuUrl(input) {
  const s = String(input || '').trim();
  if (!s.includes('/')) return { kind: 'docx', token: s }; // 裸 token 当 docx
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/(docx|docs|wiki)\/([A-Za-z0-9]+)/);
    if (!m) return null;
    const kind = m[1] === 'wiki' ? 'wiki' : 'docx';
    return { kind, token: m[2] };
  } catch {
    return null;
  }
}

function isAllowedRedirect(redirect, env) {
  try {
    const u = new URL(redirect);
    if (u.protocol !== 'https:') return false;
    if (!u.hostname.endsWith('.chromiumapp.org')) return false;
    if (env.ALLOWED_REDIRECT_PREFIX && !redirect.startsWith(env.ALLOWED_REDIRECT_PREFIX)) return false;
    return true;
  } catch {
    return false;
  }
}
