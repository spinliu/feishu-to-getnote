export async function getConfig() {
  const cfg = await chrome.storage.local.get(['worker', 'getKey', 'getCid', 'feishuSession']);
  return {
    worker: (cfg.worker || '').replace(/\/+$/, ''),
    getKey: cfg.getKey || '',
    getCid: cfg.getCid || '',
    feishuSession: cfg.feishuSession || '',
  };
}

export async function probeFeishuSession(worker, session) {
  if (!worker || !session) return false;
  try {
    const resp = await fetch(`${worker}/api/session`, {
      headers: { authorization: `Bearer ${session}` },
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function loginFeishu(worker, { preferSilent = true } = {}) {
  if (!worker) throw new Error('未配置 Worker URL');

  const redirect = chrome.identity.getRedirectURL();
  const startUrl = `${worker}/oauth/start?redirect=${encodeURIComponent(redirect)}`;
  let cbUrl;

  if (preferSilent) {
    try {
      cbUrl = await chrome.identity.launchWebAuthFlow({
        url: startUrl,
        interactive: false,
      });
    } catch {
      cbUrl = null;
    }
  }

  if (!cbUrl) {
    cbUrl = await chrome.identity.launchWebAuthFlow({
      url: startUrl,
      interactive: true,
    });
  }

  const session = new URL(cbUrl).searchParams.get('session');
  if (!session) throw new Error('飞书登录回调缺 session');
  await chrome.storage.local.set({ feishuSession: session });
  return session;
}

export async function ensureFeishuSession({ interactive = true } = {}) {
  const cfg = await getConfig();
  if (!cfg.worker) throw new Error('未配置 Worker URL（请到设置页填）');

  if (cfg.feishuSession) {
    const ok = await probeFeishuSession(cfg.worker, cfg.feishuSession);
    if (ok) return cfg.feishuSession;
    await chrome.storage.local.remove('feishuSession');
  }

  if (!interactive) throw new Error('未登录飞书');
  return loginFeishu(cfg.worker, { preferSilent: true });
}
