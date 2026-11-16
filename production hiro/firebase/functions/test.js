'use strict';
// Tests locaux (node test.js) : aucune connexion à Firebase, tout est simulé.
const assert = require('assert');
const { changePassword, verifyAuth, sha256, MAX_FAILS, MAX_FAILS_PW, MAX_FAILS_HASH, WINDOW_MS } = require('./lib');

function makeDeps(staffPlain) {
  const st = { docs: { 'hiro-config/staff-password': staffPlain ? sha256(staffPlain) : null }, fails: [], t: 1_000_000, writes: [] };
  return {
    st,
    now: () => st.t,
    getHash: async (p) => st.docs[p] || null,
    setHash: async (p, h) => { st.docs[p] = h; st.writes.push([p, h]); },
    checkLimit: async (now, max = MAX_FAILS) => {
      const f = st.fails.filter((t) => now - t < WINDOW_MS);
      return f.length >= max ? { blocked: true, retryInSec: Math.ceil((WINDOW_MS - (now - f[0])) / 1000) } : { blocked: false };
    },
    recordFail: async (now) => { st.fails.push(now); },
    recordSuccess: async () => { st.fails = []; },
  };
}
const ok = (n) => console.log('  OK  ' + n);

(async () => {
  // même algorithme que les pages (SHA-256 hex, UTF-8) : vecteur connu
  assert.strictEqual(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); ok('SHA-256 conforme (vecteur connu)');
  // « é » doit être haché sur ses octets UTF-8 (c3 a9), comme TextEncoder le fait côté navigateur
  assert.strictEqual(sha256('é'), require('crypto').createHash('sha256').update(Buffer.from([0xc3, 0xa9])).digest('hex')); ok('UTF-8 géré (octets c3 a9)');

  let d = makeDeps('staff123');
  let r = await changePassword({ target: 'order', newPassword: 'nouveau1', staffPassword: 'staff123' }, d);
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(d.st.writes, [['hiro-config/order-password', sha256('nouveau1')]]); ok('bon mot de passe staff -> 200, hash SHA-256 écrit sur order-password');

  d = makeDeps('staff123');
  r = await changePassword({ target: 'home', newPassword: '  espace  ', staffPassword: 'staff123' }, d);
  assert.strictEqual(r.status, 200); assert.strictEqual(d.st.writes[0][0], 'hiro-config/home-password'); assert.strictEqual(d.st.writes[0][1], sha256('espace')); ok('cible home + nouveau mot de passe rogné (comme la page)');

  d = makeDeps('staff123');
  r = await changePassword({ target: 'order', newPassword: 'nouveau1', staffPassword: 'faux' }, d);
  assert.strictEqual(r.status, 403); assert.strictEqual(d.st.writes.length, 0); assert.strictEqual(d.st.fails.length, 1); ok('mauvais mot de passe staff -> 403, RIEN écrit, échec compté');

  d = makeDeps('staff123');
  for (let i = 0; i < MAX_FAILS; i++) await changePassword({ target: 'order', newPassword: 'nouveau1', staffPassword: 'faux' + i }, d);
  r = await changePassword({ target: 'order', newPassword: 'nouveau1', staffPassword: 'staff123' }, d);
  assert.strictEqual(r.status, 429); assert.strictEqual(d.st.writes.length, 0); ok('après ' + MAX_FAILS + ' échecs : 429, même le BON mot de passe est refusé (anti force brute)');
  d.st.t += WINDOW_MS + 1;
  r = await changePassword({ target: 'order', newPassword: 'nouveau1', staffPassword: 'staff123' }, d);
  assert.strictEqual(r.status, 200); ok('10 minutes plus tard : de nouveau accepté');

  d = makeDeps('staff123');
  for (const bad of [{ target: 'staff', newPassword: 'nouveau1', staffPassword: 'staff123' }, { target: '__proto__', newPassword: 'nouveau1', staffPassword: 'staff123' }, { target: 'constructor', newPassword: 'nouveau1', staffPassword: 'staff123' }, {}, null]) {
    r = await changePassword(bad, d); assert.strictEqual(r.status, 400);
  }
  assert.strictEqual(d.st.writes.length, 0); ok('cible invalide (dont staff-password, __proto__) -> 400, jamais d\'écriture');

  d = makeDeps('staff123');
  for (const bad of [{ newPassword: 'abc' }, { newPassword: '   a  ' }, { newPassword: 123 }, { newPassword: 'x'.repeat(101) }]) {
    r = await changePassword({ target: 'order', staffPassword: 'staff123', ...bad }, d); assert.strictEqual(r.status, 400);
  }
  r = await changePassword({ target: 'order', newPassword: 'abcd' }, d); assert.strictEqual(r.status, 400);
  assert.strictEqual(d.st.writes.length, 0); ok('nouveau mot de passe < 4 caractères / non texte / trop long / preuve absente -> 400');

  d = makeDeps(null);
  r = await changePassword({ target: 'order', newPassword: 'nouveau1', staffPassword: 'x' }, d);
  assert.strictEqual(r.status, 503); assert.strictEqual(d.st.writes.length, 0); ok('document staff absent -> 503, rien écrit');

  d = makeDeps('staff123');
  r = await changePassword({ target: 'order', newPassword: 'nouveau1', staffPassword: sha256('staff123') }, d);
  assert.strictEqual(r.status, 403); ok('le HASH du staff (lisible publiquement) n\'est PAS accepté comme preuve');

  // ── verifyAuth ──
  const withDocs = () => { const x = makeDeps('staff123'); x.st.docs['hiro-config/order-password'] = sha256('order456'); x.st.docs['hiro-config/home-password'] = sha256('home789'); return x; };

  d = withDocs();
  for (const [t, p] of [['staff', 'staff123'], ['order', 'order456'], ['home', 'home789']]) {
    r = await verifyAuth({ target: t, password: p }, d);
    assert.deepStrictEqual([r.status, r.body], [200, { ok: true }]);
  }
  ok('bon mot de passe pour staff, order et home -> ok:true');

  d = withDocs();
  r = await verifyAuth({ target: 'order', hash: sha256('order456') }, d);
  assert.deepStrictEqual(r.body, { ok: true }); ok('bon hash (appareil déjà connecté) -> ok:true');

  d = withDocs();
  r = await verifyAuth({ target: 'staff', password: 'faux' }, d);
  assert.deepStrictEqual([r.status, r.body], [200, { ok: false }]); assert.strictEqual(d.st.fails.length, 1); ok('mauvais mot de passe -> ok:false, échec compté');
  r = await verifyAuth({ target: 'staff', hash: sha256('faux') }, d);
  assert.deepStrictEqual(r.body, { ok: false }); assert.strictEqual(d.st.fails.length, 2); ok('mauvais hash -> ok:false, échec compté');

  d = withDocs();
  assert.ok(!JSON.stringify((await verifyAuth({ target: 'staff', password: 'staff123' }, d)).body).includes(sha256('staff123'))); ok('la réponse ne contient jamais le hash');

  d = makeDeps(null);
  r = await verifyAuth({ target: 'staff', password: 'x' }, d);
  assert.deepStrictEqual([r.status, r.body], [200, { ok: false, missing: true }]); ok('document absent -> missing:true');

  d = withDocs();
  for (const bad of [{ target: 'x', password: 'a' }, { target: '__proto__', password: 'a' }, { target: 'constructor', hash: 'a' }, { target: 'staff' }, { target: 'staff', password: '' }, { target: 'staff', password: 'x'.repeat(201) }, { target: 'staff', hash: 'abc' }, { target: 'staff', hash: 'Z'.repeat(64) }, {}, null]) {
    r = await verifyAuth(bad, d); assert.strictEqual(r.status, 400);
  }
  assert.strictEqual(d.st.fails.length, 0); ok('entrées invalides (cible, vide, trop long, hash mal formé, __proto__) -> 400, aucun échec compté');

  d = withDocs();
  for (let i = 0; i < MAX_FAILS_PW; i++) await verifyAuth({ target: 'staff', password: 'faux' + i }, d);
  r = await verifyAuth({ target: 'staff', password: 'staff123' }, d);
  assert.strictEqual(r.status, 429); ok('11ᵉ tentative en mot de passe (après ' + MAX_FAILS_PW + ' échecs) -> 429, même le bon mot de passe');
  d.st.t += WINDOW_MS + 1;
  r = await verifyAuth({ target: 'staff', password: 'staff123' }, d);
  assert.deepStrictEqual(r.body, { ok: true }); ok('10 minutes plus tard : de nouveau accepté');

  d = withDocs();
  for (let i = 0; i < MAX_FAILS_PW - 1; i++) await verifyAuth({ target: 'staff', password: 'faux' + i }, d);
  await verifyAuth({ target: 'staff', password: 'staff123' }, d);
  assert.strictEqual(d.st.fails.length, 0); ok('un succès en mot de passe remet le compteur à zéro');

  d = withDocs();
  for (let i = 0; i < MAX_FAILS_HASH; i++) await verifyAuth({ target: 'staff', hash: sha256('faux' + i) }, d);
  r = await verifyAuth({ target: 'staff', hash: sha256('staff123') }, d);
  assert.strictEqual(r.status, 429); ok('16ᵉ tentative en hash (après ' + MAX_FAILS_HASH + ' échecs) -> 429');

  d = withDocs();
  for (let i = 0; i < 3; i++) await verifyAuth({ target: 'staff', password: 'faux' + i }, d);
  await verifyAuth({ target: 'staff', hash: sha256('staff123') }, d);
  assert.strictEqual(d.st.fails.length, 3); ok('un succès en hash n\'efface pas les échecs (pas de contournement du limiteur)');

  d = withDocs();
  for (let i = 0; i < MAX_FAILS_PW; i++) await verifyAuth({ target: 'staff', password: 'faux' + i }, d);
  r = await verifyAuth({ target: 'staff', hash: sha256('staff123') }, d);
  assert.deepStrictEqual(r.body, { ok: true }); ok('10 échecs en mot de passe : le mode hash (limite 15) reste utilisable');

  console.log('\nTous les tests passent.');
})().catch((e) => { console.error('ÉCHEC :', e.message); process.exit(1); });
