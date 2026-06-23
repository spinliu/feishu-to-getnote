const HISTORY_KEY = 'saveHistoryV1';
const LOG_KEY = 'saveLogsV1';
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGS = 80;

export async function findSaveRecord({ sourceUrl, destination }) {
  const history = await loadHistory();
  const key = historyKey(sourceUrl, destination);
  const record = history[key];
  if (!record) return null;
  if (Date.now() - record.savedAt > HISTORY_TTL_MS) {
    delete history[key];
    await saveHistory(history);
    return null;
  }
  return record;
}

export async function recordSave({ sourceUrl, sourceType, title, destination, result }) {
  const history = await loadHistory();
  history[historyKey(sourceUrl, destination)] = {
    sourceUrl: normalizeUrl(sourceUrl),
    sourceType: sourceType || '',
    title: title || '',
    destination,
    savedAt: Date.now(),
    result: compactResult(result),
  };
  await saveHistory(pruneHistory(history));
}

export async function removeSaveRecord({ sourceUrl, destination }) {
  const history = await loadHistory();
  delete history[historyKey(sourceUrl, destination)];
  await saveHistory(history);
}

export async function appendSaveLog(entry) {
  const logs = await listSaveLogs();
  logs.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    level: entry.level || 'info',
    action: entry.action || 'save',
    destination: entry.destination || '',
    sourceUrl: normalizeUrl(entry.sourceUrl),
    sourceType: entry.sourceType || '',
    title: entry.title || '',
    message: entry.message || '',
  });
  await chrome.storage.local.set({ [LOG_KEY]: logs.slice(0, MAX_LOGS) });
}

export async function listSaveLogs() {
  const data = await chrome.storage.local.get([LOG_KEY]);
  return Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
}

export async function clearSaveLogs() {
  await chrome.storage.local.remove(LOG_KEY);
}

function compactResult(result) {
  if (!result) return {};
  return {
    noteId: result.noteId || '',
    mode: result.mode || '',
    url: result.url || '',
    documentId: result.documentId || '',
  };
}

function pruneHistory(history) {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  return Object.fromEntries(
    Object.entries(history)
      .filter(([, record]) => record?.savedAt >= cutoff)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, 500)
  );
}

async function loadHistory() {
  const data = await chrome.storage.local.get([HISTORY_KEY]);
  return data[HISTORY_KEY] && typeof data[HISTORY_KEY] === 'object' ? data[HISTORY_KEY] : {};
}

async function saveHistory(history) {
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

function historyKey(sourceUrl, destination) {
  return `${destination}:${hashString(normalizeUrl(sourceUrl))}`;
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
