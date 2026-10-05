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
