/* Reflow EPUB service worker: offline shell + share target.
   Bump VERSION when you change index.html so installed copies refresh. */
const VERSION = 'v3';
const SHELL = 'epub-shell-' + VERSION;
const FONTS = 'epub-fonts'; // downloaded Google Fonts; never purged on updates
const LIB = 'epub-lib'; // user's saved books; never purged on updates
const ZIPJS = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const CDN_FILES = [ZIPJS];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES);
    // the unzip library is best-effort: a failure here must not block installation
    await Promise.all(CDN_FILES.map(async (u) => {
      try { const r = await fetch(u); if (r.ok) await cache.put(u, r); } catch (e) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('epub-shell-') && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // EPUB shared to the installed app from Android's share sheet
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      try {
        const fd = await req.formData();
        const f = fd.get('book');
        if (f && f.size) {
          const cache = await caches.open(LIB);
          await cache.put(new URL('__shared', self.registration.scope).href, new Response(f, {
            headers: {
              'Content-Type': 'application/epub+zip',
              'X-Filename': encodeURIComponent(f.name || 'shared.epub'),
              'X-Size': String(f.size)
            }
          }));
        }
      } catch (e) {}
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;

  // unzip library from the CDN: cache first
  if (CDN_FILES.includes(req.url)) {
    event.respondWith((async () => {
      const hit = await caches.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      try { if (res.ok) (await caches.open(SHELL)).put(req.url, res.clone()); } catch (e) {}
      return res;
    })());
    return;
  }

  // Google Fonts (stylesheet + font files): cache after first use so reading fonts work offline
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const cache = await caches.open(FONTS);
      const hit = await cache.match(req);
      if (hit) {
        if (url.hostname === 'fonts.googleapis.com') {
          event.waitUntil(fetch(req).then((r) => { if (r && (r.ok || r.type === 'opaque')) cache.put(req, r); }).catch(() => {}));
        }
        return hit;
      }
      const res = await fetch(req);
      try { if (res && (res.ok || res.type === 'opaque')) await cache.put(req, res.clone()); } catch (e) {}
      return res;
    })());
    return;
  }

  // App shell: cached copy now, refreshed in the background
  if (url.origin === location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(req, { ignoreSearch: true });
      const refresh = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (cached) { event.waitUntil(refresh); return cached; }
      const res = await refresh;
      if (res) return res;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    })());
  }
});
