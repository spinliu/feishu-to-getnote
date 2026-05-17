import { getVaultHandle, writeMarkdown, sanitizeFilename } from './lib/fs-vault.js';

const $ = id => document.getElementById(id);
const GETNOTE_API = 'https://openapi.biji.com/open/api/v1/resource/note/save';

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

  const cfg = await chrome.storage.local.get(['mode']);
  const mode = cfg.mode || 'getnote-only';
  const vault = await getVaultHandle();
  if (mode === 'ask' && vault) {
    $('localBox').style.display = 'block';
  }
}

$('openOpts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

$('go').onclick = async () => {
  const url = $('go').dataset.url;
  if (!url || !/feishu\.cn|larksuite\.com/.test(url)) {
    return setStatus('当前页面不是飞书文档', 'err');
  }

  const cfg = await chrome.storage.local.get(['getKey', 'getCid', 'subdir', 'mode']);
  const mode = cfg.mode || 'getnote-only';
  const vault = await getVaultHandle();

  // 决定要写哪些 sink
  const writeGetnote = !!(cfg.getKey && cfg.getCid);
  let writeLocal = false;
  if (vault) {
    if (mode === 'both') writeLocal = true;
    else if (mode === 'ask') writeLocal = $('writeLocal').checked;
  }

  if (!writeGetnote && !writeLocal) {
    return setStatus('未配置任何写入目标（Get 笔记 API Key 或本地文件夹）', 'err');
  }

  $('go').disabled = true;
  setStatus('正在拉取飞书内容…', 'run');

  try {
    const res = await chrome.runtime.sendMessage({ type: 'fetch', url });
    if (!res?.ok) {
      setStatus('拉取失败：' + (res?.error || '未知错误'), 'err');
      return;
    }

    const results = [];

    if (writeGetnote) {
      setStatus('正在写入 Get 笔记…', 'run');
      const r = await writeGetnoteApi(cfg, res);
      results.push(r);
    }

    if (writeLocal) {
      setStatus('正在写入本地文件…', 'run');
      try {
        const baseName = sanitizeFilename(res.title);
        const fname = await writeMarkdown({
          vaultHandle: vault,
          subdir: cfg.subdir || '',
          baseName,
          content: `# ${res.title}\n\n${res.markdown}`,
        });
        results.push(`本地 ✓ ${fname}`);
      } catch (e) {
        results.push(`本地 ✗ ${e?.message || e}`);
      }
    }

    const allOk = results.every(r => r.includes('✓'));
    setStatus(`${res.title} → ${results.join(' · ')}`, allOk ? 'ok' : 'err');
  } catch (e) {
    setStatus('失败：' + (e?.message || e), 'err');
  } finally {
    $('go').disabled = false;
  }
};

async function writeGetnoteApi(cfg, res) {
  try {
    const resp = await fetch(GETNOTE_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: cfg.getKey,
        'x-client-id': cfg.getCid,
      },
      body: JSON.stringify({
        note_type: 'plain_text',
        title: res.title,
        content: res.markdown,
        tags: ['from-feishu'],
      }),
    });
    const json = await resp.json();
    if (resp.ok && json?.success) return 'Get 笔记 ✓';
    return `Get 笔记 ✗ ${json?.error?.message || resp.status}`;
  } catch (e) {
    return `Get 笔记 ✗ ${e?.message || e}`;
  }
}

init();
