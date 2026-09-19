// アプリ本体を更新したら CACHE の版番号を上げること。
const CACHE = "kosho-v9";
const ASSETS = ["./", "./index.html", "./app.js", "./data.mjs", "./search.mjs",
                "./style.css", "./manifest.webmanifest", "./apple-touch-icon.png",
                "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", e => {
  // 必須ファイルがすべて揃ってから新しい版に切り替える。
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => /^kosho-v\d+$/.test(k) && k !== CACHE)
      .map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function remember(cache, key, response){
  if (response.ok) {
    // キャッシュの容量不足でも取得済みのレスポンスは返す。
    try { await cache.put(key, response.clone()); } catch (_) {}
  }
  return response;
}

async function sheetResponse(request){
  const cache = await caches.open(CACHE);
  const key = new URL(request.url);
  // 再読込用の時刻だけを除き、sheet や tqx は区別する。
  key.searchParams.delete("_");
  try {
    const response = await fetch(request);
    if (!response.ok) return (await cache.match(key.href)) || response;
    return remember(cache, key.href, response);
  } catch (error) {
    const hit = await cache.match(key.href);
    if (hit) return hit;
    throw error;
  }
}

async function assetResponse(request){
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  return remember(cache, request, await fetch(request));
}

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin === "https://docs.google.com" && url.pathname.endsWith("/gviz/tq")) {
    e.respondWith(sheetResponse(e.request));
  } else if (url.origin === self.location.origin) {
    e.respondWith(assetResponse(e.request));
  }
});
