/* global self, caches, fetch, URL, setTimeout */
/* The cache name carries THIS build's entry hash, stamped into the emitted
 * copy by `stampServiceWorker` in vite.mobile.config.ts.
 *
 * It used to be a hand-bumped constant, which is the same thing as never
 * bumping it: `public/` files are copied verbatim, so vite never fingerprints
 * this one, the browser saw byte-identical `sw.js` across every release and
 * never installed a new worker, and `activate` — which only drops caches under
 * a *different* name — never purged anything. The cache accumulated every
 * bundle ever served, and the offline fallback below could still boot a
 * months-old shell out of it long after the desktop had upgraded. */
const CACHE = "eldrun-mobile-shell-__ELDRUN_BUILD__";
/* A stalled connection — the common mobile-data failure — is not a network
 * *error*, so a plain `.catch()` fallback left the user on a white screen for
 * the browser's full timeout with the cached shell sitting right there. */
const NETWORK_TIMEOUT = 3000;
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg"];
/* Take over on the next navigation rather than waiting for every client to
 * close. A phone PWA is rarely "closed", so waiting is what kept a superseded
 * worker — and the stale cache it answers from — alive for days. Dropping the
 * old cache out from under a running page is safe here because the build emits
 * one non-split bundle under immutable hashed URLs: a page already open holds
 * its JS in memory and asks the cache for nothing more. */
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  ),
);
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
