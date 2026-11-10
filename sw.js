/* Videcutto service worker — offline support (stale-while-revalidate). */
const CACHE = 'videcutto-v0.14.1';
// Fonts are loaded when first used and kept across app updates.
const FONT_CACHE = 'videcutto-fonts-1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/mp4.js',
  '/meta.js',
  '/render.js',
  '/project.js',
  '/zip.js',
  '/manifest.json',
  '/favicon.ico',
  '/icons/logo.svg',
  '/icons/favicon-16x16.png',
  '/icons/favicon-32x32.png',
  '/icons/apple-touch-icon.png',
  '/icons/android-chrome-192x192.png',
  '/icons/android-chrome-512x512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('videcutto-') && k !== CACHE && k !== FONT_CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// "Share to Videcutto" (installed app): keep the shared files for the page, then open it.
const SHARE_CACHE = 'videcutto-share';
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'POST' && new URL(req.url).pathname === '/share-target') {
    event.respondWith((async () => {
      let n = 0;
      try {
        const form = await req.formData();
        const files = form.getAll('media').filter((f) => f && typeof f === 'object' && f.size);
        const cache = await caches.open(SHARE_CACHE);
        for (const k of await cache.keys()) await cache.delete(k);
        for (const f of files) {
          await cache.put(`/__shared/${n++}`, new Response(f, { headers: {
            'Content-Type': f.type || 'application/octet-stream',
            'X-Name': encodeURIComponent(f.name || `shared-${n}`),
            'X-Modified': String(f.lastModified || Date.now()),
          } }));
        }
      } catch (e) { /* nothing received */ }
      return Response.redirect(`/?shared=${n}`, 303);
    })());
    return;
  }
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (new URL(req.url).pathname.startsWith('/fonts/')) {
    event.respondWith(caches.open(FONT_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => { if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
