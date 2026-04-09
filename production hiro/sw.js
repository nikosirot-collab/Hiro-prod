const CACHE_NAME = 'hiro-v2';
const BASE = 'https://nikosirot-collab.github.io/Hiro-prod/production%20hiro/';
const ASSETS = [
  BASE + 'hiro_prod.html',
  BASE + 'hiro_access.html',
  BASE + 'hiro_order_dsm.html',
  BASE + 'hiro_order_mgt.html',
  BASE + 'hiro_order_paita.html',
  BASE + 'hiro_order_ville.html',
  BASE + 'hiro_labo.html',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if(e.request.url.includes('firestore.googleapis.com') ||
     e.request.url.includes('firebase') ||
     e.request.url.includes('fonts.googleapis.com') ||
     e.request.url.includes('fonts.gstatic.com')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
