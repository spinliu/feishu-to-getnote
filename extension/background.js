import { ensureFeishuSession, getConfig } from './lib/auth-manager.js';
import { readFeishuDocument } from './lib/source/feishu-source.js';
import { readArticleFromTab } from './lib/source/article-dom-source.js';
import { readArticleViaExtractService } from './lib/source/extract-service-source.js';
import { saveToGetnote } from './lib/destination/getnote-destination.js';
import { saveToFeishuDoc } from './lib/destination/feishu-destination.js';
import { appendSaveLog, findSaveRecord, recordSave } from './lib/save-state.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!['save', 'batchSave'].includes(msg?.type)) return false;
  const task = msg.type === 'batchSave' ? handleBatchSave(msg) : handleSave(msg);
  task.then(sendResponse).catch(async e => {
    await safeAppendSaveLog({
      level: 'error',
      action: msg?.type || 'save',
      sourceUrl: msg?.url,
      sourceType: msg?.sourceType,
      message: e?.message || String(e),
    });
    sendResponse({ ok: false, error: e?.message || String(e) });
  });
  return true;
});

async function handleSave(msg) {
  const cfg = await getConfig();
  const destinations = Array.isArray(msg.destinations) ? msg.destinations : ['getnote'];
  const needsFeishu = msg.sourceType === 'feishu-doc' || destinations.includes('feishu');
  const session = needsFeishu ? await ensureFeishuSession({ interactive: true }) : cfg.feishuSession;

  const content = await readSource({
    ...msg,
    worker: cfg.worker,
    session,
  });

  const { results, errors } = await saveDestinations({
    cfg,
    content,
    destinations,
    session,
    force: !!msg.force,
  });

  return {
    ok: errors.length === 0,
    title: content.title,
    sourceType: content.sourceType,
    results,
    errors,
    duplicate: destinations.every(dest => results[dest]?.skipped),
    error: errors.map(e => `${destinationLabel(e.destination)}：${e.message}`).join('\n'),
  };
}

async function handleBatchSave(msg) {
  const cfg = await getConfig();
  const tabs = Array.isArray(msg.tabs) ? msg.tabs.slice(0, 30) : [];
  if (!tabs.length) return { ok: false, error: '没有可批量保存的网页标签页' };

  const items = [];
  for (const tab of tabs) {
    const content = {
      sourceType: tab.sourceType || 'web-article',
      sourceUrl: tab.url,
      title: tab.title || tab.url || 'Untitled',
      markdown: tab.url ? `# ${tab.title || 'Untitled'}\n\n> 来源：${tab.url}\n` : '',
    };
    const { results, errors } = await saveDestinations({
      cfg,
      content,
      destinations: ['getnote'],
      session: cfg.feishuSession,
      force: !!msg.force,
    });
    items.push({
      title: content.title,
      url: content.sourceUrl,
      ok: errors.length === 0,
      skipped: !!results.getnote?.skipped,
      result: results.getnote || null,
      errors,
    });
  }

  const failed = items.filter(item => !item.ok).length;
  return {
    ok: failed === 0,
    batch: true,
    total: items.length,
    saved: items.filter(item => item.ok && !item.skipped).length,
    skipped: items.filter(item => item.skipped).length,
    failed,
    items,
    error: failed ? `${failed} 个网页保存失败` : '',
  };
}

async function readSource({ sourceType, worker, session, url, tabId }) {
  if (sourceType === 'feishu-doc') {
    return readFeishuDocument({ worker, session, url });
  }
  if (sourceType === 'wechat-article') {
    try {
      return readArticleFromTab({ tabId, url, sourceType });
    } catch (e) {
      try {
        return await readArticleViaExtractService({ worker, session, url });
      } catch (fallbackError) {
        throw new Error(`公众号正文抽取失败：${e?.message || e}；后端兜底也失败：${fallbackError?.message || fallbackError}`);
      }
    }
  }
  if (sourceType === 'service-article') {
    return readArticleViaExtractService({ worker, session, url });
  }
  return readArticleFromTab({ tabId, url, sourceType });
}

async function saveDestinations({ cfg, content, destinations, session, force }) {
  const results = {};
  const errors = [];

  for (const destination of destinations) {
    const duplicate = force ? null : await safeFindSaveRecord({ sourceUrl: content.sourceUrl, destination });
    if (duplicate) {
      results[destination] = {
        ok: true,
        skipped: true,
        duplicate: true,
        savedAt: duplicate.savedAt,
        ...duplicate.result,
      };
      continue;
    }

    try {
      const result = await saveDestination({ cfg, content, destination, session });
      results[destination] = result;
      await safeRecordSave({
        sourceUrl: content.sourceUrl,
        sourceType: content.sourceType,
        title: content.title,
        destination,
        result,
      });
      await safeAppendSaveLog({
        level: 'success',
        action: 'save',
        destination,
        sourceUrl: content.sourceUrl,
        sourceType: content.sourceType,
        title: content.title,
        message: '保存成功',
      });
    } catch (e) {
      const message = e?.message || String(e);
      errors.push({ destination, message });
      await safeAppendSaveLog({
        level: 'error',
        action: 'save',
        destination,
        sourceUrl: content.sourceUrl,
        sourceType: content.sourceType,
        title: content.title,
        message,
      });
    }
  }

  return { results, errors };
}

async function saveDestination({ cfg, content, destination, session }) {
  if (destination === 'getnote') {
    return saveToGetnote({ getKey: cfg.getKey, getCid: cfg.getCid, content });
  }
  if (destination === 'feishu') {
    const feishuSession = session || await ensureFeishuSession({ interactive: true });
    return saveToFeishuDoc({ worker: cfg.worker, session: feishuSession, content });
  }
  throw new Error(`未知保存目标：${destination}`);
}

async function safeFindSaveRecord(input) {
  try {
    return await findSaveRecord(input);
  } catch {
    return null;
  }
}

async function safeRecordSave(input) {
  try {
    await recordSave(input);
  } catch {
    // History is an optimization; a failed write must not turn a real save into failure.
  }
}

async function safeAppendSaveLog(input) {
  try {
    await appendSaveLog(input);
  } catch {
    // Diagnostics are best-effort.
  }
}

function destinationLabel(destination) {
  return {
    getnote: 'Get',
    feishu: '飞书',
  }[destination] || destination;
}
