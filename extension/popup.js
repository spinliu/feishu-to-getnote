const $ = id => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (kind || '');
  el.style.display = 'block';
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('url').textContent = tab?.url || '(无)';
  $('go').dataset.url = tab?.url || '';
}

$('openOpts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

$('go').onclick = async () => {
  const url = $('go').dataset.url;
  if (!url || !/feishu\.cn|larksuite\.com/.test(url)) {
    return setStatus('当前页面不是飞书文档', 'err');
  }
  $('go').disabled = true;
  setStatus('正在拉取飞书内容…', 'run');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'import', url });
    if (res?.ok) {
      setStatus(`✓ 已导入：${res.title || '(无标题)'}`, 'ok');
    } else {
      setStatus('失败：' + (res?.error || '未知错误'), 'err');
    }
  } catch (e) {
    setStatus('失败：' + (e?.message || e), 'err');
  } finally {
    $('go').disabled = false;
  }
};

init();
