'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const webpush = require('web-push');
const { changePassword, MAX_FAILS, WINDOW_MS } = require('./lib');
const { registerPush, sendTest } = require('./push');

initializeApp();
const db = getFirestore();

const ALLOWED_ORIGIN = 'https://nikosirot-collab.github.io';
const VAPID_PUBLIC = 'BH1jrYGo47bFhdzBcd2qnPLwb66L5cWzYYgzEoNAg24Z5TltsgVW2HakxXqE7Bw7-ifNkCPQgZFgFt3jAizimWs';
const VAPID_PRIVATE = defineSecret('VAPID_PRIVATE_KEY');     // coffre-fort Google : jamais dans le code
const VAPID_SUBJECT = 'mailto:niko.sirot@gmail.com';

// Compteurs d'essais : collection sans règle côté navigateur (refusée), accessible seulement ici
const limiter = (path) => {
  const ref = db.doc(path);
  return {
    checkLimit: async (now) => {
      const s = await ref.get();
      const fails = ((s.exists && s.data().fails) || []).filter((t) => now - t < WINDOW_MS);
      if (fails.length >= MAX_FAILS) return { blocked: true, retryInSec: Math.ceil((WINDOW_MS - (now - fails[0])) / 1000) };
      return { blocked: false };
    },
    recordFail: async (now) => {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const fails = ((s.exists && s.data().fails) || []).filter((t) => now - t < WINDOW_MS);
        fails.push(now);
        tx.set(ref, { fails }, { merge: true });
      });
    },
    recordSuccess: async (now) => { await ref.set({ fails: [], lastOk: now }, { merge: true }); },
  };
};

const baseDeps = {
  now: () => Date.now(),
  getHash: async (path) => {
    const s = await db.doc(path).get();
    return s.exists ? (s.data().hash || null) : null;
  },
  setHash: async (path, hash) => { await db.doc(path).set({ hash }, { merge: true }); },
};

// Enveloppe commune : méthode, origine, erreurs
const handle = (fn) => async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'méthode non autorisée' });
  const origin = req.get('origin');
  if (origin && origin !== ALLOWED_ORIGIN) return res.status(403).json({ ok: false, error: 'origine non autorisée' });
  try {
    const r = await fn(req.body);
    return res.status(r.status).json(r.body);
  } catch (e) {
    console.error('erreur', e);
    return res.status(500).json({ ok: false, error: 'erreur serveur' });
  }
};
const opts = { region: 'australia-southeast1', cors: [ALLOWED_ORIGIN], maxInstances: 3, invoker: 'public' };

exports.changePassword = onRequest(opts, handle((body) =>
  changePassword(body, { ...baseDeps, ...limiter('hiro-auth-limits/change-password') })));

// Abonnements aux notifications : collection privée (aucune règle navigateur => refusée)
const subs = db.collection('hiro-push');
const pushDeps = {
  ...baseDeps,
  ...limiter('hiro-auth-limits/push'),
  saveSubscription: async (id, data) => { await subs.doc(id).set(data, { merge: true }); },
  listSubscriptions: async (role) => {
    const q = await subs.where('role', '==', role).where('expired', '==', false).get();
    return q.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  markExpired: async (id) => { await subs.doc(id).set({ expired: true }, { merge: true }); },
  send: async (subscription, payload) => {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE.value());
    return webpush.sendNotification(subscription, payload, { TTL: 3600 });
  },
};

exports.pushRegister = onRequest(opts, handle((body) => registerPush(body, pushDeps)));
exports.pushTest = onRequest({ ...opts, secrets: [VAPID_PRIVATE] }, handle((body) => sendTest(body, pushDeps)));

// ═══════════════════════════════════════════════════════════════════════════
// Notifications d'événements (phase 1)
// ═══════════════════════════════════════════════════════════════════════════
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const E = require('./events');

// Envoie un message à tous les appareils abonnés à un rôle ; marque (sans supprimer) les abonnements périmés
async function notifyRole(msg) {
  const list = await pushDeps.listSubscriptions(msg.role);
  if (!list.length) { console.log('notification', msg.role, msg.tag, 'aucun appareil abonné à ce rôle'); return { sent: 0, failed: 0 }; }
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag });
  let sent = 0, failed = 0;
  for (const s of list) {
    let host = ''; try { host = new URL(s.subscription.endpoint).hostname; } catch (e) { host = '?'; }
    try { const r = await pushDeps.send(s.subscription, payload); sent++; console.log('  appareil', String(s.id).slice(0, 6), host, 'enregistré le', s.createdAt ? new Date(s.createdAt + 11 * 3600000).toISOString().slice(0, 16) : '?', '=> statut', r && r.statusCode); }
    catch (e) { failed++; console.log('  appareil', String(s.id).slice(0, 6), host, '=> ÉCHEC statut', e && e.statusCode, String(e && e.body || e && e.message || '').slice(0, 120)); if (e && (e.statusCode === 404 || e.statusCode === 410)) await pushDeps.markExpired(s.id); }
  }
  console.log('notification', msg.role, msg.tag, 'envoyées:', sent, 'échecs:', failed);
  return { sent, failed };
}
const snapData = (s) => (s && s.exists ? s.data() : null);
// Les déclencheurs Firestore doivent être dans la région de la base (comme onOrderChange / onRizChange)
const trig = { region: 'us-central1', secrets: [VAPID_PRIVATE], maxInstances: 5, memory: '256MiB' };
const notifyColl = db.collection('hiro-notify');      // état interne (collection sans règle navigateur => refusée)

// Commande reçue (-> Access) ou validée (-> le magasin)
exports.notifyOrder = onDocumentWritten({ ...trig, document: 'hiro-orders/{docId}' }, async (event) => {
  const msgs = E.orderMessages(event.params.docId, snapData(event.data.before), snapData(event.data.after));
  for (const m of msgs) await notifyRole(m);
});

// Riz de la semaine en cours : on mémorise la modification, l'envoi se fait 2 min après la dernière saisie
exports.notifyRiz = onDocumentWritten({ ...trig, document: 'hiro-production/{docId}' }, async (event) => {
  const docId = event.params.docId;
  const changes = E.rizChanges(docId, snapData(event.data.before), snapData(event.data.after), Date.now());
  if (!changes.length) { if (docId === 'week_' + E.mondayOf(E.nc(Date.now()).date)) console.log('riz', docId, ': aucune modification de boules'); return; }
  console.log('riz', docId, ': modifications détectées', JSON.stringify(changes));
  const shops = [...new Set(changes.map((c) => c.shop))];
  for (const shop of shops) {
    const ref = notifyColl.doc('riz-' + shop);
    await db.runTransaction(async (tx) => {
      const pending = snapData(await tx.get(ref));
      const merged = E.mergePending(pending, changes.filter((c) => c.shop === shop), Date.now());
      tx.set(ref, { shop, changes: merged.changes, dueAt: merged.dueAt });
    });
  }
});

// Demande d'approbation d'un nouvel appareil (-> Prod)
exports.notifyApproval = onDocumentWritten({ ...trig, document: 'hiro-presence/{docId}' }, async (event) => {
  const msg = E.presenceMessage(snapData(event.data.before), snapData(event.data.after));
  if (msg) await notifyRole(msg);
});

const sched = { region: 'australia-southeast1', timeZone: 'Pacific/Noumea', secrets: [VAPID_PRIVATE], memory: '256MiB', maxInstances: 1 };

// Chaque minute : envoie les résumés de riz dont la dernière saisie date de plus de 2 minutes
exports.flushRizNotifications = onSchedule({ ...sched, schedule: 'every 1 minutes' }, async () => {
  const now = Date.now();
  const due = await notifyColl.where('dueAt', '<=', now).get();
  if (due.size) console.log('résumés de riz à envoyer :', due.size);
  for (const doc of due.docs) {
    const data = await db.runTransaction(async (tx) => {
      const d = snapData(await tx.get(doc.ref));
      if (!d || d.dueAt == null || d.dueAt > now) return null;           // déjà traité ou repoussé par une nouvelle saisie
      tx.update(doc.ref, { dueAt: null, changes: {}, lastFlush: now });  // update : remplace entièrement la liste
      return d;
    });
    if (!data) continue;
    const msg = E.digestMessage(data.shop, data.changes);
    console.log('résumé riz', data.shop, JSON.stringify(data.changes), msg ? '=> notification' : '=> aucune (valeur finale = valeur de départ)');
    if (msg) await notifyRole(msg);
  }
});

// 13 h 30 (Nouméa), du lundi au vendredi : rappel aux magasins abonnés qui n'ont pas encore envoyé la commande du lendemain
exports.deadlineReminders = onSchedule({ ...sched, schedule: '30 13 * * 1-5' }, async () => {
  const now = Date.now();
  const subsSnap = await subs.where('expired', '==', false).get();
  const shopsWithSubs = [...new Set(subsSnap.docs.map((d) => d.data().role).filter((r) => E.SHOPS[r]))];
  if (!shopsWithSubs.length) return;
  const jo = snapData(await db.doc('hiro-config/jours-off').get()) || {};
  const today = E.nc(now).date, done = {};
  for (const shop of shopsWithSubs) {
    const date = E.deliveryDate(today, E.offDatesOf(jo, shop));
    const o = snapData(await db.doc(`hiro-orders/order_${date}_${shop}`).get());
    done[shop + '|' + date] = !!(o && o.ts);
  }
  for (const m of E.reminders(now, shopsWithSubs, jo, (shop, date) => done[shop + '|' + date])) await notifyRole(m);
});
