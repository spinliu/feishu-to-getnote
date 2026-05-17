const $ = id => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(['worker', 'getKey', 'getCid', 'feishuSession']);
  $('worker').value = cfg.worker || '';
  $('getKey').value = cfg.getKey || '';
  $('getCid').value = cfg.getCid || '';
  renderAuth(cfg.feishuSession);
}

function renderAuth(session) {
  const el = $('auth-status');
  if (session) {
    el.textContent = '已登录飞书 · session: ' + session.slice(0, 8) + '…';
    el.className = 'status ok';
  } else {
    el.textContent = '未登录';
    el.className = 'status';
  }
}

async function save() {
  const worker = $('worker').value.trim().replace(/\/+$/, '');
  const getKey = $('getKey').value.trim();
  const getCid = $('getCid').value.trim();
  await chrome.storage.local.set({ worker, getKey, getCid });
  const s = $('save-status');
  s.textContent = '已保存';
  s.className = 'status ok';
  s.style.display = 'inline-block';
  setTimeout(() => (s.style.display = 'none'), 1500);
}

async function login() {
  const { worker } = await chrome.storage.local.get('worker');
  if (!worker) return alert('请先填 Worker URL 并保存');

  // chrome.identity 回调 URL 形如 https://<ext-id>.chromiumapp.org/
  const redirect = chrome.identity.getRedirectURL();
  const startUrl = `${worker}/oauth/start?redirect=${encodeURIComponent(redirect)}`;

  try {
    const cbUrl = await chrome.identity.launchWebAuthFlow({
      url: startUrl,
      interactive: true,
    });
    const session = new URL(cbUrl).searchParams.get('session');
    if (!session) throw new Error('回调缺 session');
    await chrome.storage.local.set({ feishuSession: session });
    renderAuth(session);
  } catch (e) {
    const el = $('auth-status');
    el.textContent = '登录失败：' + (e?.message || e);
    el.className = 'status err';
  }
}

async function logout() {
  await chrome.storage.local.remove('feishuSession');
  renderAuth(null);
}

$('save').onclick = save;
$('login').onclick = login;
$('logout').onclick = logout;
load();
