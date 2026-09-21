/**
 * TaskCash Pro service worker.
 *
 * Scope is deliberately narrow:
 *  - Caches only the static offline shell so the app still opens with no
 *    network.
 *  - NEVER caches API responses, dashboard HTML or anything under /api/.
 *    Balances must always come from the server, so a stale cached balance
 *    would be a correctness bug, not a performance win.
 */

const CACHE = "taskcash-shell-v1";
const OFFLINE_URL = "/offline";
const PRECACHE = ["/offline", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isNeverCached(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/dashboard") ||
    url.pathname.startsWith("/admin") ||
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/register")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin (Supabase, video CDNs) — always straight to the network.
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url)) return;

  // Navigations: network first, offline shell as the fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((res) => res ?? Response.error())),
    );
    return;
  }

  // Static assets: cache first.
  if (url.pathname.startsWith("/_next/static") || /\.(css|js|svg|png|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
