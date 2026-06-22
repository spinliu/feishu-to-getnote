import { ensureFeishuSession, getConfig } from './lib/auth-manager.js';
import { readFeishuDocument } from './lib/source/feishu-source.js';
import { readArticleFromTab } from './lib/source/article-dom-source.js';
import { readArticleViaExtractService } from './lib/source/extract-service-source.js';
import { saveToGetnote } from './lib/destination/getnote-destination.js';
import { saveToFeishuDoc } from './lib/destination/feishu-destination.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'save') return false;
  handleSave(msg).then(sendResponse).catch(e =>
    sendResponse({ ok: false, error: e?.message || String(e) })
  );
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

  const results = {};
  if (destinations.includes('getnote')) {
    results.getnote = await saveToGetnote({ getKey: cfg.getKey, getCid: cfg.getCid, content });
  }
  if (destinations.includes('feishu')) {
    const feishuSession = session || await ensureFeishuSession({ interactive: true });
    results.feishu = await saveToFeishuDoc({ worker: cfg.worker, session: feishuSession, content });
  }

  return { ok: true, title: content.title, sourceType: content.sourceType, results };
}

async function readSource({ sourceType, worker, session, url, tabId }) {
  if (sourceType === 'feishu-doc') {
    return readFeishuDocument({ worker, session, url });
  }
  if (sourceType === 'wechat-article' || sourceType === 'service-article') {
    return readArticleViaExtractService({ worker, session, url });
  }
  return readArticleFromTab({ tabId, url });
}
