import { pickVault, vaultName, clearVault } from './lib/fs-vault.js';

const $ = id => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get([
    'worker', 'getKey', 'getCid', 'feishuSession', 'subdir', 'mode'
  ]);
  $('worker').value = cfg.worker || '';
  $('getKey').value = cfg.getKey || '';
  $('getCid').value = cfg.getCid || '';
  $('subdir').value = cfg.subdir || '';
  const mode = cfg.mode || 'getnote-only';
  const radio = document.querySelector(`input[name=mode][value="${mode}"]`);
  if (radio) radio.checked = true;
  renderAuth(cfg.feishuSession);
  renderVault(await vaultName());
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

function renderVault(name) {
  const el = $('vault-status');
  if (name) {
    el.textContent = '已选择文件夹: ' + name;
    el.className = 'status ok';
  } else {
    el.textContent = '未选择';
    el.className = 'status';
  }
}

async function save() {
  const worker = $('worker').value.trim().replace(/\/+$/, '');
  const getKey = $('getKey').value.trim();
  const getCid = $('getCid').value.trim();
  const subdir = $('subdir').value.trim();
  const mode = document.querySelector('input[name=mode]:checked')?.value || 'getnote-only';
  await chrome.storage.local.set({ worker, getKey, getCid, subdir, mode });
  const s = $('save-status');
  s.textContent = '已保存';
  s.className = 'status ok';
  s.style.display = 'inline-block';
  setTimeout(() => (s.style.display = 'none'), 1500);
}

async function login() {
  const { worker } = await chrome.storage.local.get('worker');
  if (!worker) return alert('请先填 Worker URL 并保存');
  const redirect = chrome.identity.getRedirectURL();
  const startUrl = `${worker}/oauth/start?redirect=${encodeURIComponent(redirect)}`;
  try {
    const cbUrl = await chrome.identity.launchWebAuthFlow({ url: startUrl, interactive: true });
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

async function onPickVault() {
  try {
    const name = await pickVault();
    renderVault(name);
  } catch (e) {
    if (e.name === 'AbortError') return; // 用户取消选择
    alert('选择文件夹失败: ' + (e?.message || e));
  }
}

async function onClearVault() {
  await clearVault();
  renderVault(null);
}

$('save').onclick = save;
$('login').onclick = login;
$('logout').onclick = logout;
$('pickVault').onclick = onPickVault;
$('clearVault').onclick = onClearVault;
load();
