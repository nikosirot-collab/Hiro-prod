'use strict';
// Logique du changement de mot de passe (sans dépendance Firebase : testable seule).
const crypto = require('crypto');

const TARGETS = {
  order: 'hiro-config/order-password',   // mot de passe des pages de commande
  home:  'hiro-config/home-password',    // mot de passe de Hiro Home
};
const STAFF_DOC = 'hiro-config/staff-password';   // preuve : le mot de passe staff (en clair, jamais le hash)
const MAX_FAILS = 5;
const WINDOW_MS = 10 * 60 * 1000;                  // 5 essais ratés max par tranche de 10 minutes

// Même calcul que les pages : SHA-256 hexadécimal du texte UTF-8
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/**
 * deps : {
 *   now()                      -> ms
 *   getHash(path)              -> string | null
 *   setHash(path, hash)        -> void
 *   checkLimit(now)            -> { blocked, retryInSec }
 *   recordFail(now) / recordSuccess(now)
 * }
 */
async function changePassword(body, deps) {
  const target = body && body.target;
  const np = body && body.newPassword;
  const sp = body && body.staffPassword;

  if (!Object.prototype.hasOwnProperty.call(TARGETS, target))
    return { status: 400, body: { ok: false, error: 'cible invalide' } };
  if (typeof np !== 'string' || np.trim().length < 4 || np.length > 100)
    return { status: 400, body: { ok: false, error: 'nouveau mot de passe invalide (4 caractères minimum)' } };
  if (typeof sp !== 'string' || sp.length === 0 || sp.length > 200)
    return { status: 400, body: { ok: false, error: 'mot de passe staff manquant' } };

  const now = deps.now();
  const lim = await deps.checkLimit(now);
  if (lim.blocked)
    return { status: 429, body: { ok: false, error: 'trop d\'essais, réessayez dans quelques minutes', retryInSec: lim.retryInSec } };

  const staffHash = await deps.getHash(STAFF_DOC);
  if (!staffHash)
    return { status: 503, body: { ok: false, error: 'configuration manquante' } };

  if (!safeEqual(sha256(sp), staffHash)) {
    await deps.recordFail(now);
    return { status: 403, body: { ok: false, error: 'mot de passe staff incorrect' } };
  }

  await deps.setHash(TARGETS[target], sha256(np.trim()));
  await deps.recordSuccess(now);
  return { status: 200, body: { ok: true } };
}

module.exports = { changePassword, sha256, TARGETS, STAFF_DOC, MAX_FAILS, WINDOW_MS };
