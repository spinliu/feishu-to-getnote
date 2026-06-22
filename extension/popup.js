const $ = id => document.getElementById(id);
let currentTab = null;
let currentSourceType = 'unsupported';

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (kind || '');
  el.style.display = 'block';
}

function setBusy(busy) {
  for (const id of ['saveGet', 'saveFeishu', 'saveBoth']) {
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

  if (sourceType === 'wechat-article') {
    setStatus('公众号默认走后端抽取服务；如果 Worker 未配置 /api/extract，会返回明确错误。', 'run');
  } else if (unsupported) {
    setStatus('当前页面暂不支持保存。', 'err');
  }
  setBusy(false);
}

$('openOpts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
$('saveGet').onclick = () => save(['getnote']);
$('saveFeishu').onclick = () => save(['feishu']);
$('saveBoth').onclick = () => save(['feishu', 'getnote']);

async function save(destinations) {
  if (!currentTab?.url || currentSourceType === 'unsupported') {
    return setStatus('当前页面暂不支持保存。', 'err');
  }
  setBusy(true);
  setStatus('正在处理…', 'run');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'save',
      url: currentTab.url,
      tabId: currentTab.id,
      sourceType: currentSourceType,
      destinations,
    });
    if (res?.ok) {
      setStatus(successText(res), 'ok');
    } else {
      setStatus('失败：' + (res?.error || '未知错误'), 'err');
    }
  } catch (e) {
    setStatus('失败：' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

function successText(res) {
  const parts = [`已保存：${res.title || '(无标题)'}`];
  if (res.results?.feishu) {
    const feishu = res.results.feishu;
    parts.push(`飞书：已保存`);
    if (feishu.url) parts.push(feishu.url);
    if (!feishu.url && feishu.documentId) parts.push(`Feishu documentId：${feishu.documentId}`);
  }
  if (res.results?.getnote) {
    const getnote = res.results.getnote;
    const mode = {
      link: '链接',
      plain_text: '正文',
      plain_text_fallback: '正文兜底',
    }[getnote.mode] || getnote.mode || '未知模式';
    parts.push(`Get：已保存（${mode}）`);
    if (getnote.noteId) parts.push(`Get note_id：${getnote.noteId}`);
  }
  return parts.join('\n');
}

init();
