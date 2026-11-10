/* Videcutto service worker — offline support (stale-while-revalidate). */
const CACHE = 'videcutto-v0.14.2';
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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('videcutto-') && k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// "Share to Videcutto" (installed app): the shared files are handed to the page
// as they are (no copy — big videos would take ages to copy), then it opens.
let shared = null, delivered = null;
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'get-shared') {
    event.source.postMessage({ type: 'shared', files: shared || [] });
    shared = null;
    if (delivered) { delivered(); delivered = null; }
  }
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'POST' && new URL(req.url).pathname === '/share-target') {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        shared = form.getAll('media').filter((f) => f && typeof f === 'object' && f.size);
      } catch (e) { shared = []; }
      return Response.redirect(`/?shared=${shared.length}`, 303);
    })());
    // Stay awake until the page has picked the files up (at most a minute).
    event.waitUntil(new Promise((res) => { delivered = res; setTimeout(res, 60000); }));
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
