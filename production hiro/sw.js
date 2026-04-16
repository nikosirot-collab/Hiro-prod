// ── Hiro Sushi Service Worker v2.0 ──
const SW_VERSION = '2.0.0';
const CACHE_NAME = 'hiro-cache-v2';
const DB_NAME = 'hiro-offline-db';
const DB_VERSION = 1;
const BASE = 'https://nikosirot-collab.github.io/Hiro-prod/production%20hiro/';

const PRECACHE_URLS = [
  BASE + 'hiro_prod.html',
  BASE + 'hiro_access.html',
  BASE + 'hiro_order_dsm.html',
  BASE + 'hiro_order_mgt.html',
  BASE + 'hiro_order_paita.html',
  BASE + 'hiro_order_ville.html',
];

// ── Installation ──
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return Promise.allSettled(PRECACHE_URLS.map(function(url){
        return cache.add(url).catch(function(err){ console.log('SW: skip', url, err); });
      }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

// ── Activation ──
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

// ── Fetch ──
self.addEventListener('fetch', function(e){
  var url = e.request.url;

  // Firebase — network first, fallback JSON vide
  if(url.includes('firestore.googleapis.com')){
    e.respondWith(
      fetch(e.request.clone()).then(function(res){
        // Mettre en cache les réponses GET réussies
        if(e.request.method === 'GET' && res.ok){
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(e.request, clone); });
        }
        return res;
      }).catch(function(){
        // Hors ligne — essayer le cache
        return caches.match(e.request).then(function(cached){
          return cached || new Response(JSON.stringify({documents:[], _offline:true}), {
            headers:{'Content-Type':'application/json'}
          });
        });
      })
    );
    return;
  }

  // Google Fonts — cache first
  if(url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')){
    e.respondWith(
      caches.match(e.request).then(function(cached){
        return cached || fetch(e.request).then(function(res){
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(e.request, clone); });
          return res;
        }).catch(function(){ return new Response(''); });
      })
    );
    return;
  }

  // Pages HTML — network first, cache fallback
  if(e.request.mode === 'navigate' || url.endsWith('.html')){
    e.respondWith(
      fetch(e.request).then(function(res){
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function(c){ c.put(e.request, clone); });
        return res;
      }).catch(function(){
        return caches.match(e.request).then(function(cached){
          return cached || new Response(
            '<html><body style="font-family:sans-serif;text-align:center;padding:2rem;">'
            +'<h2>📡 Hors ligne</h2><p>Reconnectez-vous pour accéder à l\'application.</p>'
            +'<button onclick="location.reload()">Réessayer</button></body></html>',
            {headers:{'Content-Type':'text/html'}}
          );
        });
      })
    );
    return;
  }

  // Autres — network with cache fallback
  e.respondWith(fetch(e.request).catch(function(){ return caches.match(e.request); }));
});

// ── IndexedDB ──
function openDB(){
  return new Promise(function(resolve, reject){
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e){
      var db = e.target.result;
      if(!db.objectStoreNames.contains('queue')){
        var s = db.createObjectStore('queue', {keyPath:'id', autoIncrement:true});
        s.createIndex('shop','shop'); s.createIndex('ts','ts');
      }
      if(!db.objectStoreNames.contains('cache')){
        db.createObjectStore('cache', {keyPath:'key'});
      }
    };
    req.onsuccess = function(e){ resolve(e.target.result); };
    req.onerror = function(e){ reject(e.target.error); };
  });
}

// ── Background Sync ──
self.addEventListener('sync', function(e){
  if(e.tag === 'hiro-sync') e.waitUntil(processQueue());
});

async function processQueue(){
  var db = await openDB();
  var items = await new Promise(function(resolve){
    var tx = db.transaction('queue','readonly');
    var req = tx.objectStore('queue').getAll();
    req.onsuccess = function(){ resolve(req.result||[]); };
    req.onerror = function(){ resolve([]); };
  });

  for(var i=0; i<items.length; i++){
    var item = items[i];
    try{
      // Vérifier date
      if(item.date){
        var today = new Date(); today.setHours(0,0,0,0);
        var itemDate = new Date(item.date); itemDate.setHours(0,0,0,0);
        if(itemDate < today){
          var dt = db.transaction('queue','readwrite'); dt.objectStore('queue').delete(item.id);
          console.log('SW: commande périmée supprimée', item.date);
          continue;
        }
      }
      var res = await fetch(item.url, {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({fields:item.fields})
      });
      if(res.ok){
        var dt2 = db.transaction('queue','readwrite'); dt2.objectStore('queue').delete(item.id);
        self.clients.matchAll().then(function(clients){
          clients.forEach(function(c){ c.postMessage({type:'sync-success', shop:item.shop}); });
        });
      }
    }catch(err){ console.log('SW: sync error', err); }
  }
}

// ── Messages ──
self.addEventListener('message', function(e){
  if(!e.data) return;

  if(e.data.type === 'queue-action'){
    openDB().then(function(db){
      var tx = db.transaction('queue','readwrite');
      tx.objectStore('queue').add({
        url:e.data.url, fields:e.data.fields,
        shop:e.data.shop, date:e.data.date, ts:Date.now()
      });
    }).then(function(){
      if(self.registration.sync) self.registration.sync.register('hiro-sync');
    });
  }

  if(e.data.type === 'cache-data'){
    openDB().then(function(db){
      var tx = db.transaction('cache','readwrite');
      tx.objectStore('cache').put({key:e.data.key, value:e.data.value, ts:Date.now()});
    });
  }

  if(e.data.type === 'get-cache'){
    openDB().then(function(db){
      var tx = db.transaction('cache','readonly');
      var req = tx.objectStore('cache').get(e.data.key);
      req.onsuccess = function(){
        e.source.postMessage({type:'cache-result', key:e.data.key, value:req.result?req.result.value:null});
      };
    });
  }

  if(e.data.type === 'skip-waiting'){
    self.skipWaiting();
  }
});
