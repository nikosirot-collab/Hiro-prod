// Service worker de la mini-application de TEST des notifications (périmètre limité à ce dossier).
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Hiro', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Hiro', {
    body: d.body || '',
    icon: '/Hiro-prod/production%20hiro/icon-192.png',
    badge: '/Hiro-prod/production%20hiro/icon-192.png',
    tag: d.tag || 'hiro',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
