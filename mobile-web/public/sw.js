/* global self, caches, fetch, URL, setTimeout */
const CACHE = "eldrun-mobile-shell-v6";
/* A stalled connection — the common mobile-data failure — is not a network
 * *error*, so a plain `.catch()` fallback left the user on a white screen for
 * the browser's full timeout with the cached shell sitting right there. */
const NETWORK_TIMEOUT = 3000;
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;
  if (event.request.method !== "GET") return;
  const cached = () => caches.match(event.request).then((hit) => hit || caches.match("/"));
  const network = fetch(event.request).then((response) => {
    /* Never store a document under an asset URL. The host's SPA fallback used
     * to answer a missing /assets/* with index.html and a one-year immutable
     * header, which this cache then served as JavaScript for a year. */
    const type = response.headers.get("content-type") || "";
    const isDocument = type.includes("text/html");
    const cacheable = response.ok
      && (SHELL.includes(url.pathname) || (url.pathname.startsWith("/assets/") && !isDocument));
    if (cacheable) {
      const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  });
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(cached().then((hit) => hit || network)), NETWORK_TIMEOUT);
  });
  event.respondWith(Promise.race([network, timeout]).catch(cached));
});
