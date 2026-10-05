'use strict';
// Tests locaux (node test.js) : aucune connexion à Firebase, tout est simulé.
const assert = require('assert');
const { changePassword, sha256, MAX_FAILS, WINDOW_MS } = require('./lib');

function makeDeps(staffPlain) {
  const st = { docs: { 'hiro-config/staff-password': staffPlain ? sha256(staffPlain) : null }, fails: [], t: 1_000_000, writes: [] };
  return {
    st,
    now: () => st.t,
    getHash: async (p) => st.docs[p] || null,
    setHash: async (p, h) => { st.docs[p] = h; st.writes.push([p, h]); },
    checkLimit: async (now) => {
      const f = st.fails.filter((t) => now - t < WINDOW_MS);
      return f.length >= MAX_FAILS ? { blocked: true, retryInSec: Math.ceil((WINDOW_MS - (now - f[0])) / 1000) } : { blocked: false };
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

  console.log('\nTous les tests passent.');
})().catch((e) => { console.error('ÉCHEC :', e.message); process.exit(1); });
