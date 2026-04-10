const CACHE_NAME = 'hiro-v4';
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

const FB_ORDERS = 'https://firestore.googleapis.com/v1/projects/hiro-sushi-nc/databases/(default)/documents/hiro-orders';
const FB_PROD   = 'https://firestore.googleapis.com/v1/projects/hiro-sushi-nc/databases/(default)/documents/hiro-production';
const FB_KEY    = 'AIzaSyAeGNmrF96_64HYYQom7xsGM09BjNeI6EE';

// ── CACHE ──
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if(e.request.url.includes('firestore.googleapis.com') ||
     e.request.url.includes('fonts.googleapis.com') ||
     e.request.url.includes('fonts.gstatic.com')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// ── POLLING STATE ──
let _timers = {};
let _snapshots = {};

function stopTimer(key) {
  if(_timers[key]) { clearInterval(_timers[key]); delete _timers[key]; }
}

// ── MESSAGES FROM PAGE ──
self.addEventListener('message', e => {
  if(!e.data) return;
  const {type} = e.data;

  // Magasin : surveille validation de SA commande
  if(type === 'WATCH_VALIDATION') {
    const {shop, docId} = e.data;
    const key = 'valid_' + shop;
    stopTimer(key);
    _snapshots[key] = null;
    _timers[key] = setInterval(() => pollValidation(shop, docId, key), 15000);
  }

  // Access : surveille les commandes entrantes (tous magasins)
  if(type === 'WATCH_ORDERS') {
    const {dateStr} = e.data;
    const key = 'orders_' + dateStr;
    stopTimer(key);
    // Init snapshot avec commandes déjà reçues
    initOrdersSnapshot(dateStr, key);
    _timers[key] = setInterval(() => pollOrders(dateStr, key), 20000);
  }

  // Access : surveille riz & poisson dans hiro-prod
  if(type === 'WATCH_PROD') {
    const {weekDocId} = e.data;
    const key = 'prod_' + weekDocId;
    stopTimer(key);
    initProdSnapshot(weekDocId, key);
    _timers[key] = setInterval(() => pollProd(weekDocId, key), 30000);
  }

  if(type === 'STOP_ALL') {
    Object.keys(_timers).forEach(stopTimer);
    _snapshots = {};
  }
});

// ── POLL VALIDATION (pour les magasins) ──
async function pollValidation(shop, docId, key) {
  try {
    const res = await fetch(FB_ORDERS + '/' + docId + '?key=' + FB_KEY);
    if(!res.ok) return;
    const json = await res.json();
    if(!json.fields) return;
    const status = json.fields.status ? json.fields.status.stringValue : null;
    const validatedAt = json.fields.validatedAt ? parseInt(json.fields.validatedAt.integerValue) : null;
    if(status === 'validated' && validatedAt && _snapshots[key] !== 'validated') {
      _snapshots[key] = 'validated';
      const time = new Date(validatedAt).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
      await self.registration.showNotification('✅ Commande validée — ' + shop.toUpperCase(), {
        body: 'Votre commande a été validée à ' + time + '. Ouvrez l\'app pour voir le récap.',
        tag: 'valid_' + shop,
        requireInteraction: true,
        data: {url: BASE + 'hiro_order_' + shop + '.html'}
      });
      stopTimer(key);
    } else if(status !== 'validated') {
      _snapshots[key] = status;
    }
  } catch(e) {}
}

// ── POLL ORDERS (pour Access) ──
const SHOPS = ['dsm','mgt','paita','ville'];
const SHOP_LABELS = {dsm:'DSM', mgt:'MGT', paita:'Paita', ville:'Ville'};

async function initOrdersSnapshot(dateStr, key) {
  _snapshots[key] = {};
  for(const shop of SHOPS) {
    try {
      const res = await fetch(FB_ORDERS + '/order_' + dateStr + '_' + shop + '?key=' + FB_KEY);
      if(res.ok) {
        const json = await res.json();
        _snapshots[key][shop] = json.fields && json.fields.ts ? parseInt(json.fields.ts.integerValue) : null;
      } else {
        _snapshots[key][shop] = null;
      }
    } catch(e) { _snapshots[key][shop] = null; }
  }
}

async function pollOrders(dateStr, key) {
  if(!_snapshots[key]) return;
  for(const shop of SHOPS) {
    try {
      const res = await fetch(FB_ORDERS + '/order_' + dateStr + '_' + shop + '?key=' + FB_KEY);
      if(!res.ok) continue;
      const json = await res.json();
      if(!json.fields || !json.fields.ts) continue;
      const ts = parseInt(json.fields.ts.integerValue);
      const prev = _snapshots[key][shop];
      if(prev === null || ts > prev + 60000) { // nouvelle commande ou modifiée
        _snapshots[key][shop] = ts;
        if(prev !== undefined) { // pas la première fois
          const time = new Date(ts).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
          await self.registration.showNotification('📦 Commande reçue — ' + SHOP_LABELS[shop], {
            body: 'Commande envoyée à ' + time + '. Ouvrez Hiro Access pour valider.',
            tag: 'order_' + shop,
            requireInteraction: true,
            data: {url: BASE + 'hiro_access.html'}
          });
        }
      }
    } catch(e) {}
  }
}

// ── POLL PROD (riz & poisson pour Access) ──
async function initProdSnapshot(weekDocId, key) {
  try {
    const res = await fetch(FB_PROD + '/' + weekDocId + '?key=' + FB_KEY);
    if(!res.ok) return;
    const json = await res.json();
    _snapshots[key] = {};
    if(json.fields) {
      Object.entries(json.fields).forEach(([k,v]) => {
        if(v.integerValue !== undefined) _snapshots[key][k] = parseInt(v.integerValue);
      });
    }
  } catch(e) {}
}

async function pollProd(weekDocId, key) {
  if(!_snapshots[key]) return;
  try {
    const res = await fetch(FB_PROD + '/' + weekDocId + '?key=' + FB_KEY);
    if(!res.ok) return;
    const json = await res.json();
    if(!json.fields) return;
    
    const rizChanges = [];
    const fishChanges = [];
    
    Object.entries(json.fields).forEach(([k, v]) => {
      if(v.integerValue === undefined) return;
      const newVal = parseInt(v.integerValue);
      const oldVal = _snapshots[key][k];
      if(oldVal === undefined || oldVal === newVal) {
        _snapshots[key][k] = newVal;
        return;
      }
      _snapshots[key][k] = newVal;
      // Détecte type de changement
      const dk = k.replace(/--/g,'__');
      if(dk.includes('__f__')) {
        // poisson : format dStr__f__shop__field
        const parts = dk.split('__');
        if(parts.length >= 4) {
          const shop = parts[2];
          const field = parts[3];
          const fieldName = {t:'Thon',s:'Saumon',a:'Aburi',tamago:'Tamago'}[field] || field;
          fishChanges.push(SHOP_LABELS[shop]||shop + ' ' + fieldName + ': ' + oldVal + '→' + newVal);
        }
      } else if(!dk.includes('__r__') && !dk.includes('__f__')) {
        // riz : format dStr__shop
        const parts = dk.split('__');
        if(parts.length === 2) {
          const shop = parts[1];
          if(['dsm','mgt','paita','ville'].includes(shop)) {
            rizChanges.push((SHOP_LABELS[shop]||shop) + ': ' + oldVal + '→' + newVal);
          }
        }
      }
    });

    if(rizChanges.length > 0) {
      await self.registration.showNotification('🍚 Modification riz', {
        body: rizChanges.join(' · '),
        tag: 'riz_change',
        data: {url: BASE + 'hiro_access.html'}
      });
    }
    if(fishChanges.length > 0) {
      await self.registration.showNotification('🐟 Modification poisson', {
        body: fishChanges.join(' · '),
        tag: 'fish_change',
        data: {url: BASE + 'hiro_access.html'}
      });
    }
  } catch(e) {}
}

// ── CLIC NOTIFICATION ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) ? e.notification.data.url : BASE;
  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(cls => {
      for(const c of cls) {
        if(c.url.includes(url.split('/').pop()) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
