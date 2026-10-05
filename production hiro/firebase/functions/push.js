'use strict';
// Logique des notifications push (sans dépendance Firebase : testable seule).
const { sha256, MAX_FAILS, WINDOW_MS } = require('./lib');
const crypto = require('crypto');

// Qui peut s'abonner et avec quel mot de passe (la preuve est le mot de passe en clair, jamais le hash public)
const ROLE_PASSWORD = { access: 'staff', prod: 'staff', test: 'staff', dsm: 'order', mgt: 'order', paita: 'order', ville: 'order' };
const PASSWORD_DOC = { staff: 'hiro-config/staff-password', order: 'hiro-config/order-password' };

// Le serveur ne contacte QUE les services de notification des navigateurs (évite qu'on lui fasse appeler n'importe quelle adresse)
const ENDPOINT_HOSTS = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];

const MAX_SUBS_PER_ROLE = 30;                         // plafond d'appareils par rôle (contre l'enregistrement en masse)
const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const b64url = /^[A-Za-z0-9_-]+$/;

function validSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 600) return false;
  let u; try { u = new URL(sub.endpoint); } catch (e) { return false; }
  if (u.protocol !== 'https:' || !ENDPOINT_HOSTS.some((re) => re.test(u.hostname))) return false;
  const k = sub.keys;
  if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return false;
  if (k.p256dh.length < 60 || k.p256dh.length > 140 || k.auth.length < 10 || k.auth.length > 40) return false;
  return b64url.test(k.p256dh) && b64url.test(k.auth);
}

// Vérifie le mot de passe du rôle, avec la limite d'essais. Renvoie null si OK, sinon une réponse d'erreur.
async function checkProof(role, password, deps) {
  if (typeof password !== 'string' || !password || password.length > 200)
    return { status: 400, body: { ok: false, error: 'mot de passe manquant' } };
  const now = deps.now();
  const lim = await deps.checkLimit(now);
  if (lim.blocked)
    return { status: 429, body: { ok: false, error: 'trop d\'essais, réessayez dans quelques minutes', retryInSec: lim.retryInSec } };
  const hash = await deps.getHash(PASSWORD_DOC[ROLE_PASSWORD[role]]);
  if (!hash) return { status: 503, body: { ok: false, error: 'configuration manquante' } };
  if (!safeEqual(sha256(password), hash)) {
    await deps.recordFail(now);
    return { status: 403, body: { ok: false, error: 'mot de passe incorrect' } };
  }
  await deps.recordSuccess(now);
  return null;
}

// Preuve par empreinte (hash) : celle que l'appareil a déjà mémorisée à la connexion. Même niveau de sécurité que la connexion des interfaces.
async function checkHashProof(role, hash, deps) {
  const now = deps.now();
  const lim = await deps.checkLimit(now);
  if (lim.blocked)
    return { status: 429, body: { ok: false, error: 'trop d\'essais, réessayez dans quelques minutes', retryInSec: lim.retryInSec } };
  const ref = await deps.getHash(PASSWORD_DOC[ROLE_PASSWORD[role]]);
  if (!ref) return { status: 503, body: { ok: false, error: 'configuration manquante' } };
  if (!safeEqual(hash, ref)) {
    await deps.recordFail(now);
    return { status: 403, body: { ok: false, error: 'empreinte incorrecte' } };
  }
  await deps.recordSuccess(now);
  return null;
}

async function registerPush(body, deps) {
  const role = body && body.role, sub = body && body.subscription, pw = body && body.password;
  if (!has(ROLE_PASSWORD, role)) return { status: 400, body: { ok: false, error: 'rôle invalide' } };
  if (!validSubscription(sub)) return { status: 400, body: { ok: false, error: 'abonnement invalide' } };
  const useHash = !!(body && body.hash !== undefined);
  if (useHash && !isHash(body.hash)) return { status: 400, body: { ok: false, error: 'empreinte invalide' } };
  const err = useHash ? await checkHashProof(role, body.hash, deps) : await checkProof(role, pw, deps);
  if (err) return err;
  const id = sha256(role + '|' + sub.endpoint).slice(0, 40);   // un appareil peut avoir plusieurs rôles (ex. Access + Prod)
  if (!(await deps.hasSubscription(id)) && (await deps.countSubscriptions(role)) >= MAX_SUBS_PER_ROLE)
    return { status: 409, body: { ok: false, error: 'trop d\'appareils enregistrés pour ce rôle' } };
  await deps.saveSubscription(id, { role, subscription: sub, createdAt: deps.now(), expired: false });
  return { status: 200, body: { ok: true } };
}

async function sendTest(body, deps) {
  const role = (body && body.role) || 'test';
  if (!has(ROLE_PASSWORD, role)) return { status: 400, body: { ok: false, error: 'rôle invalide' } };
  const err = await checkProof('test', body && body.password, deps);   // toujours le mot de passe staff
  if (err) return err;
  const subs = await deps.listSubscriptions(role);
  if (!subs.length) return { status: 404, body: { ok: false, error: 'aucun appareil enregistré pour ce rôle' } };
  const payload = JSON.stringify({ title: 'Hiro — test', body: role === 'test' ? 'Les notifications fonctionnent sur cet appareil.' : 'Test d\'envoi au rôle « ' + role + ' ».', url: './', tag: 'hiro-test-' + role });
  let sent = 0, failed = 0; const details = [];
  for (const s of subs) {
    let host = ''; try { host = new URL(s.subscription.endpoint).hostname; } catch (e) { host = '?'; }
    const d = { role, host, id: String(s.id).slice(0, 6), enregistréLe: s.createdAt || null };
    try { const r = await deps.send(s.subscription, payload); sent++; d.statut = (r && r.statusCode) || 'ok'; }
    catch (e) {
      failed++; d.statut = (e && e.statusCode) || 'erreur';
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await deps.markExpired(s.id);   // abonnement périmé : marqué, jamais supprimé
    }
    details.push(d);
  }
  return { status: 200, body: { ok: true, sent, failed, details } };
}

module.exports = { registerPush, sendTest, validSubscription, ROLE_PASSWORD, ENDPOINT_HOSTS, MAX_SUBS_PER_ROLE };
