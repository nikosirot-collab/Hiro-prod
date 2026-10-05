'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { changePassword, MAX_FAILS, WINDOW_MS } = require('./lib');

initializeApp();
const db = getFirestore();

const ALLOWED_ORIGIN = 'https://nikosirot-collab.github.io';
// Compteur d'essais : collection sans règle côté navigateur (refusée), accessible seulement ici
const limRef = db.doc('hiro-auth-limits/change-password');

const deps = {
  now: () => Date.now(),
  getHash: async (path) => {
    const s = await db.doc(path).get();
    return s.exists ? (s.data().hash || null) : null;
  },
  setHash: async (path, hash) => { await db.doc(path).set({ hash }, { merge: true }); },
  checkLimit: async (now) => {
    const s = await limRef.get();
    const fails = ((s.exists && s.data().fails) || []).filter((t) => now - t < WINDOW_MS);
    if (fails.length >= MAX_FAILS)
      return { blocked: true, retryInSec: Math.ceil((WINDOW_MS - (now - fails[0])) / 1000) };
    return { blocked: false };
  },
  recordFail: async (now) => {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(limRef);
      const fails = ((s.exists && s.data().fails) || []).filter((t) => now - t < WINDOW_MS);
      fails.push(now);
      tx.set(limRef, { fails }, { merge: true });
    });
  },
  recordSuccess: async (now) => { await limRef.set({ fails: [], lastChange: now }, { merge: true }); },
};

exports.changePassword = onRequest(
  { region: 'australia-southeast1', cors: [ALLOWED_ORIGIN], maxInstances: 3, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'méthode non autorisée' });
    const origin = req.get('origin');
    if (origin && origin !== ALLOWED_ORIGIN) return res.status(403).json({ ok: false, error: 'origine non autorisée' });
    try {
      const r = await changePassword(req.body, deps);
      return res.status(r.status).json(r.body);
    } catch (e) {
      console.error('changePassword', e);
      return res.status(500).json({ ok: false, error: 'erreur serveur' });
    }
  }
);
