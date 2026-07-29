// 呼称マトリクス
// アプリ本体を更新したら CACHE の版番号を上げること。
const CACHE = "kosho-v3";
const ASSETS = ["./", "./index.html", "./app.js", "./style.css",
                "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const isSheet = e.request.url.includes("docs.google.com");

  if (isSheet){
    // スプレッドシートは常に最新を優先。取れなければ前回の内容を返す。
    e.respondWith(fetch(e.request).then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, {ignoreSearch:true})
      .then(hit => hit || Promise.reject(new Error("offline")))));
    return;
  }

  // アプリ本体はキャッシュ優先、裏で更新
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
