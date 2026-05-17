// File System Access API + IndexedDB handle persistence.
// 只在 window 上下文（popup / options）使用——service worker 不支持 showDirectoryPicker。

const DB_NAME = 'feishu-getnote';
const STORE = 'handles';
const KEY = 'vault';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbDel(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function pickVault() {
  if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持 File System Access API');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idbSet(KEY, handle);
  return handle.name;
}

export async function getVaultHandle() {
  return await idbGet(KEY);
}

export async function vaultName() {
  const h = await idbGet(KEY);
  return h ? h.name : null;
}

export async function clearVault() {
  await idbDel(KEY);
}

export function sanitizeFilename(name) {
  return String(name || 'Untitled')
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200) || 'Untitled';
}

// 写文件到 vault[/subdir]/baseName.md；文件已存在时加 (2)/(3)... 后缀避免覆盖。
// 返回实际写入的文件名。失败抛异常（包括权限被吊销）。
export async function writeMarkdown({ vaultHandle, subdir, baseName, content }) {
  const perm = await vaultHandle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    // 权限丢失（用户清了浏览器数据 / 重启太久）。requestPermission 需要用户手势，
    // 这里通常处于 click 后的活跃手势窗口，可以直接申请。
    const req = await vaultHandle.requestPermission({ mode: 'readwrite' });
    if (req !== 'granted') throw new Error('本地文件夹写入权限被拒绝（请到设置页重新选择文件夹）');
  }

  let dir = vaultHandle;
  if (subdir) {
    for (const seg of subdir.split('/').map(s => s.trim()).filter(Boolean)) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
  }

  let name = `${baseName}.md`;
  let i = 2;
  while (await fileExists(dir, name)) {
    name = `${baseName} (${i}).md`;
    i++;
    if (i > 100) throw new Error('同名文件过多，放弃');
  }

  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
  return name;
}

async function fileExists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}
