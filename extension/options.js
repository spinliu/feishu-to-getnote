import { getConfig, loginFeishu, probeFeishuSession } from './lib/auth-manager.js';
import { clearSaveLogs, listSaveLogs } from './lib/save-state.js';

const $ = id => document.getElementById(id);

async function load() {
  const cfg = await getConfig();
  $('worker').value = cfg.worker || '';
  $('getKey').value = cfg.getKey || '';
  $('getCid').value = cfg.getCid || '';
  renderAuth(cfg.feishuSession);
  await renderLogs();
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

async function renderLogs() {
  const logs = await listSaveLogs();
  const el = $('logs');
  if (!logs.length) {
    el.innerHTML = '<div class="log">暂无记录</div>';
    return;
  }
  el.innerHTML = logs.slice(0, 20).map(log => {
    const level = log.level === 'error' ? 'error' : 'success';
    const status = log.level === 'error' ? '失败' : '成功';
    const title = escapeHtml(log.title || log.sourceUrl || '(无标题)');
    const destination = escapeHtml(destinationLabel(log.destination));
    const message = escapeHtml(log.message || '');
    const url = escapeHtml(log.sourceUrl || '');
    return `
      <div class="log ${level}">
        <div class="log-title">${status} · ${destination} · ${title}</div>
        <div class="log-meta">${formatTime(log.at)}${message ? ' · ' + message : ''}</div>
        ${url ? `<div class="log-url">${url}</div>` : ''}
      </div>
    `;
  }).join('');
}

async function clearLogs() {
  await clearSaveLogs();
  await renderLogs();
}

function destinationLabel(destination) {
  return {
    getnote: 'Get',
    feishu: '飞书',
  }[destination] || destination || '系统';
}

function formatTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

$('save').onclick = save;
$('login').onclick = login;
$('logout').onclick = logout;
$('testWorker').onclick = testWorker;
$('refreshLogs').onclick = renderLogs;
$('clearLogs').onclick = clearLogs;
load();
