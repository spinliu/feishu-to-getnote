// lark-doc-proxy — Cloudflare Worker
// 职责：飞书 OAuth + 文档 blocks 代拉
// 不做：下游笔记 API（Get 笔记 / Obsidian 等由各自插件自己调）

const SCOPES = ['docx:document:readonly', 'wiki:wiki:readonly'].join(' ');
const STATE_TTL_SEC = 600;
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 天，refresh_token 兜底

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
      if (url.pathname === '/')              return json({ name: 'lark-doc-proxy', ok: true });
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
  if (!redirect.startsWith(env.ALLOWED_REDIRECT_PREFIX)) return err('bad_redirect', 403);

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
  const sess = await loadSession(env, session);
  if (!sess) return err('session_invalid', 401);
  return json({ ok: true });
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
  const sess = await loadSession(env, session_key);
  if (!sess) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now < sess.expires_at) return sess.access_token;
  if (now >= sess.refresh_expires_at) return null;

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
  if (!r.ok || tok.code) return null;

  sess.access_token = tok.access_token;
  sess.refresh_token = tok.refresh_token || sess.refresh_token;
  sess.expires_at = now + (tok.expires_in || 7200) - 60;
  if (tok.refresh_expires_in) sess.refresh_expires_at = now + tok.refresh_expires_in - 60;
  await saveSession(env, session_key, sess);
  return sess.access_token;
}

async function larkGet(env, access, path) {
  const r = await fetch(`${env.LARK_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${access}` },
  });
  return r.json();
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
