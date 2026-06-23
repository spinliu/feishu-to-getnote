const $ = id => document.getElementById(id);
let currentTab = null;
let currentSourceType = 'unsupported';
let batchTabs = [];
let lastAction = null;

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (kind || '');
  el.style.display = 'block';
}

function setBusy(busy) {
  for (const id of ['saveGet', 'saveFeishu', 'saveBoth', 'batchGet', 'forceSave']) {
    $(id).disabled = busy || $(id).dataset.hidden === 'true';
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  const url = tab?.url || '';
  currentSourceType = detectSourceType(url);
  $('url').textContent = url || '(无)';
  $('source').textContent = sourceLabel(currentSourceType);
  await prepareBatchTabs();
  renderActions(currentSourceType);
}

function detectSourceType(url) {
  if (!url) return 'unsupported';
  let parsed;
  try { parsed = new URL(url); } catch { return 'unsupported'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'unsupported';
  if (/feishu\.cn|larksuite\.com/.test(parsed.hostname) && /\/(docx|docs|wiki)\//.test(parsed.pathname)) {
    return 'feishu-doc';
  }
  if (parsed.hostname === 'mp.weixin.qq.com') return 'wechat-article';
  return 'web-article';
}

function sourceLabel(sourceType) {
  return {
    'feishu-doc': '飞书文档',
    'web-article': '网页文章',
    'wechat-article': '微信公众号 / 后端抽取',
    unsupported: '暂不支持',
  }[sourceType] || '未知';
}

function renderActions(sourceType) {
  const unsupported = sourceType === 'unsupported';
  const feishuOnly = sourceType === 'feishu-doc';
  $('saveGet').dataset.hidden = unsupported ? 'true' : 'false';
  $('saveFeishu').dataset.hidden = unsupported || feishuOnly ? 'true' : 'false';
  $('saveBoth').dataset.hidden = unsupported || feishuOnly ? 'true' : 'false';

  $('saveGet').style.display = unsupported ? 'none' : 'block';
  $('saveFeishu').style.display = unsupported || feishuOnly ? 'none' : 'block';
  $('saveBoth').style.display = unsupported || feishuOnly ? 'none' : 'block';
  $('batchGet').dataset.hidden = batchTabs.length ? 'false' : 'true';
  $('batchGet').style.display = batchTabs.length ? 'block' : 'none';
  $('batchGet').textContent = `批量保存窗口网页到 Get（${batchTabs.length}）`;
  hideForceSave();

  if (sourceType === 'wechat-article') {
    setStatus('公众号会先从当前页面抽取正文；如页面限制导致失败，再尝试后端抽取。', 'run');
  } else if (unsupported) {
    setStatus('当前页面暂不支持保存。', 'err');
  }
  setBusy(false);
}

$('openOpts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
$('saveGet').onclick = () => save(['getnote']);
$('saveFeishu').onclick = () => save(['feishu']);
$('saveBoth').onclick = () => save(['feishu', 'getnote']);
$('batchGet').onclick = () => batchSaveGet();
$('forceSave').onclick = () => replayLastAction();

async function save(destinations, { force = false } = {}) {
  if (!currentTab?.url || currentSourceType === 'unsupported') {
    return setStatus('当前页面暂不支持保存。', 'err');
  }
  lastAction = { kind: 'single', destinations };
  hideForceSave();
  setBusy(true);
  setStatus(force ? '正在再次保存…' : '正在处理…', 'run');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'save',
      url: currentTab.url,
      tabId: currentTab.id,
      sourceType: currentSourceType,
      destinations,
      force,
    });
    if (res?.ok) {
      setStatus(successText(res), 'ok');
      if (res.duplicate) showForceSave('仍然再次保存');
    } else {
      setStatus(failureText(res), 'err');
    }
  } catch (e) {
    setStatus('失败：' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function batchSaveGet({ force = false } = {}) {
  if (!batchTabs.length) return setStatus('当前窗口没有可批量保存的网页。', 'err');
  lastAction = { kind: 'batch' };
  hideForceSave();
  setBusy(true);
  setStatus(force ? '正在再次批量保存…' : '正在批量保存…', 'run');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'batchSave',
      tabs: batchTabs,
      force,
    });
    setStatus(batchText(res), res?.ok ? 'ok' : 'err');
    if (res?.total && res.skipped === res.total) showForceSave('仍然全部再次保存');
  } catch (e) {
    setStatus('失败：' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function replayLastAction() {
  if (!lastAction) return;
  if (lastAction.kind === 'batch') return batchSaveGet({ force: true });
  return save(lastAction.destinations, { force: true });
}

function successText(res) {
  const parts = [`已保存：${res.title || '(无标题)'}`];
  if (res.results?.feishu) {
    const feishu = res.results.feishu;
    parts.push(feishu.skipped ? `飞书：已保存过` : `飞书：已保存`);
    if (feishu.url) parts.push(feishu.url);
    if (!feishu.url && feishu.documentId) parts.push(`Feishu documentId：${feishu.documentId}`);
    if (feishu.imageTransfer) parts.push(imageTransferText(feishu.imageTransfer));
    if (feishu.skipped && feishu.savedAt) parts.push(`飞书保存时间：${formatTime(feishu.savedAt)}`);
  }
  if (res.results?.getnote) {
    const getnote = res.results.getnote;
    const mode = {
      link: '链接',
      plain_text: '正文',
      plain_text_fallback: '正文兜底',
    }[getnote.mode] || getnote.mode || '未知模式';
    parts.push(getnote.skipped ? `Get：已保存过（${mode}）` : `Get：已保存（${mode}）`);
    if (getnote.noteId) parts.push(`Get note_id：${getnote.noteId}`);
    if (getnote.skipped && getnote.savedAt) parts.push(`Get 保存时间：${formatTime(getnote.savedAt)}`);
  }
  return parts.join('\n');
}

function failureText(res) {
  if (!res) return '失败：未知错误';
  const parts = ['失败：' + (res.error || '未知错误')];
  const saved = successText(res).split('\n').slice(1);
  if (saved.length) parts.push(...saved);
  return parts.join('\n');
}

function imageTransferText(imageTransfer) {
  const attempted = imageTransfer.attempted || 0;
  if (!attempted) return '图片：未发现可转存图片';
  const inserted = imageTransfer.inserted || 0;
  const failed = imageTransfer.failed || 0;
  return failed
    ? `图片：已插入 ${inserted}/${attempted}，失败 ${failed}`
    : `图片：已插入 ${inserted}/${attempted}`;
}

function batchText(res) {
  if (!res) return '批量保存失败：未知错误';
  const parts = [
    `批量完成：成功 ${res.saved || 0}，跳过重复 ${res.skipped || 0}，失败 ${res.failed || 0}`,
  ];
  const failed = (res.items || []).filter(item => !item.ok).slice(0, 3);
  for (const item of failed) {
    parts.push(`失败：${item.title || item.url || '(无标题)'}`);
    const reason = item.errors?.[0]?.message;
    if (reason) parts.push(reason);
  }
  return parts.join('\n');
}

async function prepareBatchTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    batchTabs = tabs
      .map(tab => ({
        id: tab.id,
        title: tab.title || '',
        url: tab.url || '',
        sourceType: detectSourceType(tab.url || ''),
      }))
      .filter(tab => ['web-article', 'wechat-article'].includes(tab.sourceType));
  } catch {
    batchTabs = [];
  }
}

function showForceSave(label) {
  $('forceSave').textContent = label;
  $('forceSave').dataset.hidden = 'false';
  $('forceSave').style.display = 'block';
}

function hideForceSave() {
  $('forceSave').dataset.hidden = 'true';
  $('forceSave').style.display = 'none';
}

function formatTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

init();
