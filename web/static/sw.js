// Service Worker：缓存 App 外壳与静态资源，离线也能打开（数据请求永远走网络）。
const CACHE = "lifebook-shell-v3";
const SHELL = [
  "/",
  "/static/styles.css",
  "/static/js/app.js",
  "/static/js/api.js",
  "/static/js/ui.js",
  "/static/js/views/dashboard.js",
  "/static/js/views/ledger.js",
  "/static/js/views/hours.js",
  "/static/js/views/media.js",
  "/static/js/views/accounts.js",
  "/static/icon-192.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 接口与上传资源不进缓存
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/uploads") || url.pathname === "/health" || url.pathname === "/ready") {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
