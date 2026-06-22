// 极简 IndexedDB 封装,只为持久化「保存文件夹」的句柄。
// File System Access 的 directory handle 可以被结构化克隆存进 IndexedDB,
// 这样刷新页面后还能记住上次选的文件夹 (需用户再次授权一次)。

const DB_NAME = "platescope";
const STORE = "handles";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const rq = tx.objectStore(STORE).get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
