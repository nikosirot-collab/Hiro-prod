'use strict';
// Tests locaux des événements (node test-events.js) : aucune connexion, dates fixées.
const assert = require('assert');
const E = require('./events');
const ok = (n) => console.log('  OK  ' + n);
const at = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h, mi) - 11 * 3600 * 1000;      // heure de Nouméa -> instant
const MON = at(2026, 10, 5, 13, 30);                                                 // lundi 5 octobre 2026, 13 h 30 à Nouméa

// — fuseau
assert.deepStrictEqual(E.nc(MON), { date: '2026-10-05', hour: 13, minute: 30, dow: 1 });
assert.strictEqual(E.nc(at(2026, 10, 5, 0, 10)).date, '2026-10-05'); assert.strictEqual(E.nc(at(2026, 10, 4, 23, 50)).date, '2026-10-04');
ok('heure de Nouméa : minuit bien géré (UTC+11)');

// — 1) commandes
let r = E.orderMessages('order_2026-10-06_dsm', null, { ts: 1, date: '2026-10-06' });
assert.strictEqual(r.length, 1); assert.strictEqual(r[0].role, 'access'); assert.ok(r[0].title.includes('DSM') && r[0].body.includes('mar 6 octobre')); ok('nouvelle commande DSM -> Access');
assert.strictEqual(E.orderMessages('order_2026-10-06_dsm', { ts: 1 }, { ts: 2 }).length, 0); ok('commande renvoyée (ts mis à jour) : pas une nouvelle commande');
r = E.orderMessages('order_2026-10-06_mgt', { ts: 1 }, { ts: 1, status: 'validated' });
assert.strictEqual(r.length, 1); assert.strictEqual(r[0].role, 'mgt'); assert.ok(r[0].title.includes('validée')); ok('commande validée -> le magasin concerné seulement');
assert.strictEqual(E.orderMessages('order_2026-10-06_mgt', { ts: 1, status: 'validated' }, { ts: 2, status: 'validated' }).length, 0); ok('commande déjà validée puis modifiée : aucune notification');
assert.strictEqual(E.orderMessages('order_2026-10-06_asia', null, { ts: 1 }).length, 0); ok('Asia (saisie directe) ignorée');
assert.strictEqual(E.orderMessages('order_2026-10-06_dsm', { ts: 1 }, null).length, 0); assert.strictEqual(E.orderMessages('autre_doc', null, { ts: 1 }).length, 0); assert.strictEqual(E.orderMessages('order_2026-10-06_dsm', null, {}).length, 0); ok('suppression, nom inattendu, document vide : rien');
r = E.orderMessages('order_2026-10-06_ville', null, { ts: 1, status: 'validated' }); assert.deepStrictEqual(r.map((x) => x.role), ['ville']); ok('arrive déjà validée : seul le magasin est prévenu, pas Access');

// — modifications de commande par le magasin
const O = (extra, ts = 100) => ({ ts, shop: 'dsm', date: '2026-10-06', bo: 3, gyoza: 0, rizprod: 500, libre: '{"chr":[],"tarte":[],"plats":[]}', ...extra });
r = E.orderMessages('order_2026-10-06_dsm', O({}), O({ bo: 5, gyoza: 2 }, 200));
assert.strictEqual(r.length, 1); assert.strictEqual(r[0].role, 'access'); assert.ok(r[0].title.startsWith('✏️ Commande DSM modifiée'));
assert.strictEqual(r[0].body, 'Pour le mar 6 octobre : Bun Bò 3 → 5, Gyoza 0 → 2'); ok('commande renvoyée avec des quantités changées -> Access : « Bun Bò 3 → 5, Gyoza 0 → 2 »');
assert.strictEqual(E.orderMessages('order_2026-10-06_dsm', O({}), O({}, 200)).length, 0); ok('commande renvoyée à l\'identique : aucune notification');
assert.strictEqual(E.orderMessages('order_2026-10-06_dsm', O({}), O({ rizprod: 750 }, 200)).length, 0); ok('seul le riz indicatif change : ignoré (le riz est notifié à part)');
r = E.orderMessages('order_2026-10-06_dsm', O({ status: 'validated', vqty_bo: 3, validatedAt: 150 }), O({ status: 'validated', vqty_bo: 4, validatedAt: 150 }));
assert.strictEqual(r.length, 0); ok('Access modifie une quantité validée (vqty_) : pas de notification (c\'est lui qui l\'a fait)');
r = E.orderMessages('order_2026-10-06_dsm', O({ status: 'validated', vqty_bo: 3, validatedAt: 150 }), O({ bo: 6 }, 300));
assert.strictEqual(r.length, 1); assert.ok(r[0].title.includes('(à revalider)')); assert.ok(r[0].body.includes('Bun Bò 3 → 6')); ok('le magasin modifie une commande déjà validée : « (à revalider) »');
r = E.orderMessages('order_2026-10-06_dsm', O({ libre: '{"chr":[{"name":"Café","qty":1}]}' }), O({ libre: '{"chr":[{"name":"Café","qty":3},{"name":"Thé","qty":2}]}' }, 200));
assert.strictEqual(r.length, 1); assert.ok(r[0].body.includes('Café (libre) 1 → 3') && r[0].body.includes('Thé (libre) 0 → 2')); ok('lignes libres ajoutées ou modifiées : signalées');
r = E.orderMessages('order_2026-10-06_dsm', O({ libre: 'pas du json' }), O({ bo: 4, libre: '{pas du json' }, 200));
assert.strictEqual(r.length, 1); ok('ligne libre illisible : ignorée, sans erreur');
const big = {}; ['bo', 'sin', 'thai', 'thon', 'plp', 'rouleaux'].forEach((k) => { big[k] = 9; });
r = E.orderMessages('order_2026-10-06_dsm', O({}), O(big, 200)); assert.ok(r[0].body.includes('+ ') && r[0].body.includes('autre(s) produit(s)')); ok('plus de 4 produits modifiés : résumé « + N autre(s) produit(s) »');
r = E.orderMessages('order_2026-10-06_ville', { ts: 1, villerolls: 10 }, { ts: 2, villerolls: 20 }); assert.ok(r[0].body.includes('Rolls (Ville) 10 → 20')); ok('Ville : les rolls de la commande ont leur nom');
r = E.orderMessages('order_2026-10-06_dsm', null, O({ bo: 9 })); assert.strictEqual(r.length, 1); assert.ok(r[0].title.startsWith('🆕')); ok('première commande : toujours « 🆕 Commande » (pas « modifiée »)');

// — 2) riz de la semaine en cours
const W = 'week_2026-10-05';
let c = E.rizChanges(W, { '2026-10-05--dsm': 1000 }, { '2026-10-05--dsm': 1250 }, MON);
assert.deepStrictEqual(c, [{ shop: 'dsm', date: '2026-10-05', before: 1000, after: 1250 }]); ok('boules modifiées cette semaine -> changement détecté');
assert.strictEqual(E.rizChanges('week_2026-10-12', { '2026-10-12--dsm': 1 }, { '2026-10-12--dsm': 2 }, MON).length, 0); ok('semaine suivante : ignorée (seule la semaine en cours compte)');
assert.strictEqual(E.rizChanges('week_2026-09-28', { '2026-09-28--dsm': 1 }, { '2026-09-28--dsm': 2 }, MON).length, 0); ok('semaine passée : ignorée');
c = E.rizChanges(W, { '2026-10-05--dsm': 1000 }, { '2026-10-05--dsm': 1000, '2026-10-05--f--dsm--t': 8, '2026-10-05--r--dsm': 60, init: 'true' }, MON);
assert.strictEqual(c.length, 0); ok('poisson/rolls seuls modifiés, ou riz identique : aucune notification');
c = E.rizChanges(W, { '2026-10-05--dsm': 1000 }, { '2026-10-05--dsm': 1250, '2026-10-05--f--dsm--t': 9 }, MON);
assert.strictEqual(c.length, 1); ok('riz ET poisson modifiés ensemble : une seule modification de riz signalée');
c = E.rizChanges(W, undefined, { '2026-10-05--mgt': 750, '2026-10-06--asia': 100 }, MON);
assert.deepStrictEqual(c, [{ shop: 'mgt', date: '2026-10-05', before: 0, after: 750 }]); ok('première saisie (avant = rien) comptée ; Asia ignoré');
assert.strictEqual(E.rizChanges(W, { '2026-10-05--dsm': 5 }, { '2026-10-05--dsm': 5 }, at(2026, 10, 11, 12, 0)).length, 0);
assert.strictEqual(E.rizChanges(W, {}, { '2026-10-11--dsm': 250 }, at(2026, 10, 11, 12, 0)).length, 1); ok('dimanche : la semaine en cours reste celle du lundi précédent');

// — fusion et envoi différé
let p = E.mergePending(null, [{ shop: 'dsm', date: '2026-10-05', before: 1000, after: 1250 }], 1000);
assert.strictEqual(p.dueAt, 1000 + E.QUIET_MS);
p = E.mergePending(p, [{ shop: 'dsm', date: '2026-10-05', before: 1250, after: 1500 }], 5000);
assert.deepStrictEqual(p.changes['2026-10-05'], { before: 1000, after: 1500 }); assert.strictEqual(p.dueAt, 5000 + E.QUIET_MS); ok('plusieurs saisies de suite : avant = valeur initiale, après = valeur finale, envoi repoussé');
let d = E.digestMessage('dsm', p.changes);
assert.strictEqual(d.role, 'access'); assert.ok(d.body.includes('lun 5 : riz 1000 → 1500') && d.title.includes('DSM') && !d.body.includes('poisson')); ok('notification : « lun 5 : riz 1000 → 1500 » (sans poisson quand il n\'a pas changé)');
p = E.mergePending(p, [{ shop: 'dsm', date: '2026-10-05', before: 1500, after: 1000 }], 9000);
assert.strictEqual(E.digestMessage('dsm', p.changes), null); ok('+ puis − pour revenir à la valeur de départ : AUCUNE notification');
const many = {}; for (let i = 5; i <= 10; i++) many['2026-10-' + String(i).padStart(2, '0')] = { before: 0, after: 250 };
d = E.digestMessage('mgt', many); assert.ok(d.body.includes('+ 3 autre(s) jour(s)') && d.body.split('\n').length === 4); ok('plus de 3 jours : résumé « + 3 autre(s) jour(s) »');

// — poisson accompagnant le riz
const FW = 'week_2026-10-05';
let fc = E.fishChanges(FW, { '2026-10-08--f--mgt--t': 150, '2026-10-08--f--mgt--s': 170, '2026-10-08--f--mgt--a': 70 }, { '2026-10-08--f--mgt--t': 200, '2026-10-08--f--mgt--s': 170, '2026-10-08--f--mgt--a': 90, '2026-10-08--mgt': 750 }, MON);
assert.deepStrictEqual(fc.map((x) => x.field + ':' + x.before + '>' + x.after).sort(), ['a:70>90', 't:150>200']); ok('poisson : seuls les champs thon/saumon/aburi réellement modifiés sont relevés (le saumon inchangé et le riz sont ignorés)');
assert.strictEqual(E.fishChanges('week_2026-10-12', { '2026-10-12--f--mgt--t': 1 }, { '2026-10-12--f--mgt--t': 2 }, MON).length, 0);
assert.strictEqual(E.fishChanges(FW, {}, { '2026-10-08--f--asia--t': 5, '2026-10-08--f--mgt--x': 5 }, MON).length, 0); ok('poisson : semaine suivante, Asia et champs inconnus ignorés');
let pf = E.mergePending(null, [{ shop: 'mgt', date: '2026-10-08', before: 500, after: 750 }], 1000, [{ shop: 'mgt', date: '2026-10-08', field: 't', before: 150, after: 200 }, { shop: 'mgt', date: '2026-10-08', field: 'a', before: 70, after: 90 }]);
pf = E.mergePending(pf, [{ shop: 'mgt', date: '2026-10-08', before: 750, after: 1000 }], 2000, [{ shop: 'mgt', date: '2026-10-08', field: 't', before: 200, after: 260 }]);
assert.deepStrictEqual(pf.fish['2026-10-08--t'], { before: 150, after: 260 }); assert.deepStrictEqual(pf.fish['2026-10-08--a'], { before: 70, after: 90 }); ok('poisson fusionné comme le riz : valeur initiale -> valeur finale');
let dm = E.digestMessage('mgt', pf.changes, pf.fish);
assert.strictEqual(dm.body, 'jeu 8 : riz 500 → 1000 · poisson : thon 150 → 260, aburi 70 → 90'); ok('notification : « jeu 8 : riz 500 → 1000 · poisson : thon 150 → 260, aburi 70 → 90 »');
dm = E.digestMessage('mgt', { '2026-10-08': { before: 500, after: 750 } }, { '2026-10-08--t': { before: 150, after: 150 }, '2026-10-08--s': { before: 170, after: 170 } });
assert.strictEqual(dm.body, 'jeu 8 : riz 500 → 750'); ok('poisson inchangé (valeur finale = valeur de départ) : pas de ligne poisson');
assert.strictEqual(E.digestMessage('mgt', { '2026-10-08': { before: 500, after: 500 } }, { '2026-10-08--t': { before: 150, after: 200 } }), null); ok('riz revenu à sa valeur de départ : aucune notification, même si le poisson a changé');
dm = E.digestMessage('mgt', { '2026-10-08': { before: 0, after: 250 } }, undefined); assert.strictEqual(dm.body, 'jeu 8 : riz 0 → 250'); ok('ancien état en attente (sans poisson) : toujours géré');
dm = E.digestMessage('ville', { '2026-10-08': { before: 100, after: 200 }, '2026-10-09': { before: 0, after: 150 } }, { '2026-10-09--tamago': { before: 0, after: 1 }, '2026-10-09--s': { before: 0, after: 40 } });
assert.strictEqual(dm.body, 'jeu 8 : riz 100 → 200\nven 9 : riz 0 → 150 · poisson : saumon 0 → 40, tamago 0 → 1'); ok('plusieurs jours : le poisson est rattaché au bon jour, ordre thon/saumon/aburi/tamago');

// — 2 bis) rolls
let rc = E.rollChanges(W, { '2026-10-06--r--paita': 40 }, { '2026-10-06--r--paita': 60 }, MON);
assert.deepStrictEqual(rc, [{ shop: 'paita', date: '2026-10-06', before: 40, after: 60 }]); ok('rolls modifiés : détectés avec la valeur déjà saisie');
rc = E.rollChanges(W, {}, { '2026-10-06--r--ville': 50, '2026-10-06--r--asia': 30, '2026-10-06--f--ville--t': 3, '2026-10-06--ville': 500 }, MON);
assert.deepStrictEqual(rc, [{ shop: 'ville', date: '2026-10-06', before: 0, after: 50 }]); ok('première saisie : avant = 0 ; asia, poisson et riz ignorés');
assert.strictEqual(E.rollChanges(W, { '2026-10-06--r--dsm': 40 }, { '2026-10-06--r--dsm': 40, x: 1 }, MON).length, 0); ok('rolls inchangés : rien');
assert.strictEqual(E.rollChanges('week_2026-10-12', {}, { '2026-10-12--r--dsm': 5 }, MON).length, 0); ok('rolls d\'une autre semaine : ignorés');
assert.strictEqual(E.rizChanges(W, { '2026-10-06--r--dsm': 1 }, { '2026-10-06--r--dsm': 2 }, MON).length, 0); ok('les rolls ne comptent toujours pas comme du riz');
let pr = E.mergePending(null, [], 1000, [], [{ shop: 'paita', date: '2026-10-06', before: 40, after: 60 }]);
pr = E.mergePending(pr, [], 5000, [], [{ shop: 'paita', date: '2026-10-06', before: 60, after: 70 }]);
assert.deepStrictEqual(pr.rolls, { '2026-10-06': { before: 40, after: 70 } }); assert.strictEqual(pr.dueAt, 5000 + E.QUIET_MS); ok('plusieurs saisies de rolls : première valeur « avant », dernière « après », délai repoussé');
assert.strictEqual(E.digestMessage('paita', {}, {}, pr.rolls).body, 'mar 6 : rolls 40 → 70'); ok('rolls seuls : notification « rolls 40 → 70 »');
pr = E.mergePending(pr, [], 9000, [], [{ shop: 'paita', date: '2026-10-06', before: 70, after: 40 }]);
assert.strictEqual(E.digestMessage('paita', {}, {}, pr.rolls), null); ok('rolls revenus à la valeur de départ : aucune notification');
assert.strictEqual(E.digestMessage('ville', {}, {}, { '2026-10-06': { before: 0, after: 60 } }).body, 'mar 6 : rolls fixés à 60'); ok('première saisie de rolls : « fixés à 60 »');
assert.strictEqual(E.digestMessage('ville', {}, {}, { '2026-10-06': { before: 40, after: 0 } }).body, 'mar 6 : rolls 40 → auto'); ok('rolls effacés : « 40 → auto »');
dm = E.digestMessage('mgt', { '2026-10-08': { before: 500, after: 750 } }, { '2026-10-08--t': { before: 150, after: 200 } }, { '2026-10-08': { before: 40, after: 60 }, '2026-10-09': { before: 0, after: 30 } });
assert.strictEqual(dm.body, 'jeu 8 : riz 500 → 750 · poisson : thon 150 → 200 · rolls 40 → 60\nven 9 : rolls fixés à 30'); ok('riz + poisson + rolls sur un jour, rolls seuls sur un autre');
assert.strictEqual(E.digestMessage('mgt', { '2026-10-08': { before: 500, after: 750 } }, {}, undefined).body, 'jeu 8 : riz 500 → 750'); ok('sans rolls : texte du riz inchangé');
dm = E.digestMessage('mgt', { '2026-10-05': { before: 1, after: 2 }, '2026-10-06': { before: 1, after: 2 } }, {}, { '2026-10-07': { before: 1, after: 2 }, '2026-10-08': { before: 1, after: 2 } });
assert.ok(dm.body.endsWith('+ 1 autre(s) jour(s)') && dm.body.split('\n').length === 4); ok('4 jours (riz et rolls mélangés) : 3 lignes + « + 1 autre(s) jour(s) »');

// — 3) approbation
let a = E.presenceMessage({ ts: 1, online: true }, { pendingApproval: true, iface: 'Commande', shop: 'dsm', userName: 'Marie', device: 'iPhone', devId: 'dev-1' });
assert.strictEqual(a.role, 'prod'); assert.ok(a.url.endsWith('hiro_prod.html#securite')); assert.ok(a.body.includes('Marie') && a.body.includes('DSM') && a.body.includes('iPhone')); ok('nouvel appareil en attente -> Prod');
assert.strictEqual(E.presenceMessage({ pendingApproval: true }, { pendingApproval: true, ts: 2 }), null); ok('battement de présence pendant l\'attente : pas de répétition');
assert.strictEqual(E.presenceMessage({ pendingApproval: true }, { pendingApproval: false }), null);
assert.strictEqual(E.presenceMessage(null, { pendingApproval: true, rejected: true }), null);
assert.strictEqual(E.presenceMessage(null, { online: true }), null); assert.strictEqual(E.presenceMessage(null, null), null); ok('approuvé, rejeté, présence normale, suppression : rien');
a = E.presenceMessage({ pendingApproval: false }, { pendingApproval: true, devId: 'd' }); assert.ok(a && a.body.includes('appareil inconnu')); ok('nouvelle demande après un refus : de nouveau notifiée');

// — 4) date de livraison et rappels
const none = new Set();
assert.strictEqual(E.deliveryDate('2026-10-05', none), '2026-10-06'); ok('lundi -> mardi');
assert.strictEqual(E.deliveryDate('2026-10-09', none), '2026-10-10'); ok('vendredi -> samedi (livraison du samedi)');
assert.strictEqual(E.deliveryDate('2026-10-08', new Set(['2026-10-09'])), '2026-10-10'); ok('jeudi, vendredi en jour off -> samedi');
assert.strictEqual(E.deliveryDate('2026-10-09', new Set(['2026-10-10'])), '2026-10-12'); ok('vendredi, samedi en jour off -> lundi (le dimanche est sauté)');
assert.strictEqual(E.deliveryDate('2026-10-07', new Set(['2026-10-08', '2026-10-09', '2026-10-10'])), '2026-10-12'); ok('plusieurs jours off de suite -> prochain jour ouvert');
assert.deepStrictEqual([...E.offDatesOf({ dsm: '[{"date":"2026-10-06","mode":"off"},{"date":"2026-10-07","mode":"rizpoisson"}]' }, 'dsm')], ['2026-10-06', '2026-10-07']);
assert.deepStrictEqual([...E.offDatesOf({ dsm: ['2026-10-06'] }, 'dsm')], ['2026-10-06']); assert.strictEqual(E.offDatesOf({ dsm: '{pas du json' }, 'dsm').size, 0); assert.strictEqual(E.offDatesOf(null, 'dsm').size, 0); ok('jours off : tous les types, ancien format, données abîmées -> sans erreur');

let rm = E.reminders(MON, ['dsm', 'mgt', 'ville'], {}, (shop) => shop === 'mgt');
assert.deepStrictEqual(rm.map((x) => x.role), ['dsm', 'ville']); assert.ok(rm[0].body.includes('mar 6 octobre') && rm[0].body.includes('14h00')); ok('13 h 30 lundi : rappel seulement aux magasins qui n\'ont PAS envoyé');
assert.strictEqual(E.reminders(at(2026, 10, 10, 13, 30), ['dsm'], {}, () => false).length, 0); assert.strictEqual(E.reminders(at(2026, 10, 11, 13, 30), ['dsm'], {}, () => false).length, 0); ok('samedi et dimanche : aucun rappel');
rm = E.reminders(MON, ['dsm'], { dsm: '[{"date":"2026-10-06","mode":"off"}]' }, (shop, date) => { assert.strictEqual(date, '2026-10-07'); return false; });
assert.strictEqual(rm.length, 1); assert.ok(rm[0].body.includes('mer 7 octobre')); ok('demain en jour off : le rappel vise le prochain jour ouvert');
assert.strictEqual(E.reminders(MON, ['asia', 'prod'], {}, () => false).length, 0); ok('rôles qui ne sont pas des magasins : ignorés');
console.log('\nTous les tests passent.');
