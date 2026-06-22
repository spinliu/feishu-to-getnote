import { getConfig, loginFeishu, probeFeishuSession } from './lib/auth-manager.js';

const $ = id => document.getElementById(id);

async function load() {
  const cfg = await getConfig();
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
  const worker = $('worker').value.trim().replace(/\/+$/, '');
  if (!worker) return alert('请先填 Worker URL 并保存');
  await chrome.storage.local.set({ worker });

  try {
    const session = await loginFeishu(worker, { preferSilent: false });
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

async function testWorker() {
  const worker = $('worker').value.trim().replace(/\/+$/, '');
  const el = $('worker-status');
  if (!worker) {
    el.textContent = '请先填写 Worker URL';
    el.className = 'status err';
    return;
  }
  try {
    const health = await fetch(`${worker}/health`).then(r => r.json());
    const cfg = await getConfig();
    const sessionOk = await probeFeishuSession(worker, cfg.feishuSession);
    el.textContent = `Worker OK：${health.name || 'unknown'} · session ${sessionOk ? '可用' : '不可用/未登录'}`;
    el.className = 'status ok';
    el.style.display = 'block';
  } catch (e) {
    el.textContent = 'Worker 测试失败：' + (e?.message || e);
    el.className = 'status err';
    el.style.display = 'block';
  }
}

$('save').onclick = save;
$('login').onclick = login;
$('logout').onclick = logout;
$('testWorker').onclick = testWorker;
load();
