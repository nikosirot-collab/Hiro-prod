'use strict';
// Tests locaux des notifications (node test-push.js) : tout est simulé, rien ne sort vers Internet.
const assert = require('assert');
const { sha256, MAX_FAILS, WINDOW_MS } = require('./lib');
const { registerPush, sendTest, validSubscription } = require('./push');

const P256 = 'B' + 'x'.repeat(86), AUTH = 'a'.repeat(22);
const goodSub = (host = 'web.push.apple.com', path = '/wpush/v2/abc123') => ({ endpoint: `https://${host}${path}`, keys: { p256dh: P256, auth: AUTH } });

function makeDeps() {
  const st = {
    hashes: { 'hiro-config/staff-password': sha256('staff123'), 'hiro-config/order-password': sha256('order456') },
    fails: [], t: 5_000_000, saved: {}, expired: [], sent: [],
  };
  return {
    st, now: () => st.t,
    getHash: async (p) => st.hashes[p] || null,
    checkLimit: async (now) => { const f = st.fails.filter((t) => now - t < WINDOW_MS); return f.length >= MAX_FAILS ? { blocked: true, retryInSec: 1 } : { blocked: false }; },
    recordFail: async (now) => { st.fails.push(now); },
    recordSuccess: async () => { st.fails = []; },
    saveSubscription: async (id, d) => { st.saved[id] = d; },
    listSubscriptions: async (role) => Object.entries(st.saved).filter(([, d]) => d.role === role && !d.expired).map(([id, d]) => ({ id, ...d })),
    markExpired: async (id) => { st.expired.push(id); st.saved[id].expired = true; },
    send: async (sub, payload) => {
      if (sub.endpoint.includes('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
      st.sent.push([sub.endpoint, JSON.parse(payload)]);
    },
  };
}
const ok = (n) => console.log('  OK  ' + n);

(async () => {
  // — validation de l'abonnement
  assert.ok(validSubscription(goodSub()));
  assert.ok(validSubscription(goodSub('fcm.googleapis.com', '/fcm/send/xyz')));
  ok('abonnements Apple et Google acceptés');
  for (const bad of [
    goodSub('evil.example'), goodSub('web.push.apple.com.evil.example'),
    { ...goodSub(), endpoint: 'http://web.push.apple.com/x' }, { ...goodSub(), endpoint: 'https://127.0.0.1/x' },
    { endpoint: 'https://web.push.apple.com/x' }, { ...goodSub(), keys: { p256dh: 'court', auth: AUTH } },
    { ...goodSub(), keys: { p256dh: P256 + '!', auth: AUTH } }, null, 'x',
  ]) assert.strictEqual(validSubscription(bad), false);
  ok('adresses étrangères, http, locales, clés absentes/trop courtes/mal formées : refusées');

  // — enregistrement
  let d = makeDeps();
  let r = await registerPush({ role: 'test', subscription: goodSub(), password: 'staff123' }, d);
  assert.strictEqual(r.status, 200); assert.strictEqual(Object.keys(d.st.saved).length, 1);
  ok('rôle test + bon mot de passe staff -> 200, abonnement enregistré');

  r = await registerPush({ role: 'dsm', subscription: goodSub('web.push.apple.com', '/b'), password: 'order456' }, d);
  assert.strictEqual(r.status, 200); assert.ok(Object.values(d.st.saved).some((x) => x.role === 'dsm'));
  ok('rôle magasin : vérifié avec le mot de passe des COMMANDES');

  d = makeDeps();
  r = await registerPush({ role: 'dsm', subscription: goodSub(), password: 'staff123' }, d);
  assert.strictEqual(r.status, 403); assert.strictEqual(Object.keys(d.st.saved).length, 0);
  ok('rôle magasin avec le mot de passe staff (différent) -> 403, rien enregistré');

  d = makeDeps();
  r = await registerPush({ role: 'test', subscription: goodSub(), password: 'faux' }, d);
  assert.strictEqual(r.status, 403); assert.strictEqual(Object.keys(d.st.saved).length, 0); assert.strictEqual(d.st.fails.length, 1);
  ok('mauvais mot de passe -> 403, rien enregistré, échec compté');

  d = makeDeps();
  for (let i = 0; i < MAX_FAILS; i++) await registerPush({ role: 'test', subscription: goodSub(), password: 'faux' + i }, d);
  r = await registerPush({ role: 'test', subscription: goodSub(), password: 'staff123' }, d);
  assert.strictEqual(r.status, 429); assert.strictEqual(Object.keys(d.st.saved).length, 0);
  ok('après ' + MAX_FAILS + ' échecs : 429, même le bon mot de passe est refusé');

  d = makeDeps();
  for (const bad of [{ role: 'admin' }, { role: '__proto__' }, { role: 'constructor' }, {}, null]) {
    r = await registerPush({ subscription: goodSub(), password: 'staff123', ...(bad || {}) }, d); assert.strictEqual(r.status, 400);
  }
  r = await registerPush({ role: 'test', subscription: goodSub('evil.example'), password: 'staff123' }, d); assert.strictEqual(r.status, 400);
  r = await registerPush({ role: 'test', subscription: goodSub() }, d); assert.strictEqual(r.status, 400);
  assert.strictEqual(Object.keys(d.st.saved).length, 0);
  ok('rôle inconnu, abonnement étranger, mot de passe absent -> 400, rien enregistré');

  d = makeDeps(); d.st.hashes = {};
  r = await registerPush({ role: 'test', subscription: goodSub(), password: 'staff123' }, d);
  assert.strictEqual(r.status, 503); ok('mot de passe de référence absent -> 503');

  // — réenregistrement du même appareil : un seul enregistrement
  d = makeDeps();
  await registerPush({ role: 'test', subscription: goodSub(), password: 'staff123' }, d);
  await registerPush({ role: 'test', subscription: goodSub(), password: 'staff123' }, d);
  assert.strictEqual(Object.keys(d.st.saved).length, 1); ok('même appareil enregistré deux fois : une seule fiche');

  // — test d'envoi
  d = makeDeps();
  r = await sendTest({ password: 'staff123' }, d);
  assert.strictEqual(r.status, 404); ok('aucun appareil enregistré -> 404');

  await registerPush({ role: 'test', subscription: goodSub('web.push.apple.com', '/a'), password: 'staff123' }, d);
  await registerPush({ role: 'test', subscription: goodSub('web.push.apple.com', '/gone'), password: 'staff123' }, d);
  await registerPush({ role: 'dsm', subscription: goodSub('web.push.apple.com', '/shop'), password: 'order456' }, d);
  r = await sendTest({ password: 'staff123' }, d);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.sent, 1); assert.strictEqual(r.body.failed, 1);
  assert.strictEqual(d.st.sent.length, 1); assert.ok(d.st.sent[0][0].endsWith('/a'));
  assert.strictEqual(d.st.expired.length, 1); assert.strictEqual(Object.values(d.st.saved).length, 3);
  ok('test : seul l\'appareil de TEST reçoit (pas le magasin) ; abonnement périmé (410) marqué mais PAS supprimé');
  assert.deepStrictEqual(Object.keys(d.st.sent[0][1]).sort(), ['body', 'tag', 'title', 'url']); ok('contenu de la notification : titre, texte, page à ouvrir, étiquette');

  r = await sendTest({ password: 'faux' }, makeDeps()); assert.strictEqual(r.status, 403);
  r = await sendTest({}, makeDeps()); assert.strictEqual(r.status, 400);
  ok('envoi de test sans le bon mot de passe staff -> refusé');

  console.log('\nTous les tests passent.');
})().catch((e) => { console.error('ÉCHEC :', e.message); process.exit(1); });
