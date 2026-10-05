'use strict';
// Logique des événements qui déclenchent une notification (sans Firebase : testable seule).
// Formats réels de Firestore : champs de semaine « AAAA-MM-JJ--magasin » (le « -- » remplace « __ »).

const SHOPS = { dsm: 'DSM', mgt: 'MGT', paita: 'Paita', ville: 'Ville' };
const SITE = 'https://nikosirot-collab.github.io/Hiro-prod/production%20hiro/';
const URLS = {
  access: SITE + 'hiro_access.html',
  prod: SITE + 'hiro_prod.html',
  dsm: SITE + 'hiro_order_dsm.html', mgt: SITE + 'hiro_order_mgt.html',
  paita: SITE + 'hiro_order_paita.html', ville: SITE + 'hiro_order_ville.html',
};
const QUIET_MS = 2 * 60 * 1000;          // un magasin qui ajuste le riz : on attend 2 minutes sans nouvelle saisie avant de notifier
const NC_OFFSET_MS = 11 * 3600 * 1000;   // Nouméa = UTC+11, pas d'heure d'été

const DAYS_SHORT = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// ── dates (calendrier pur, sans fuseau) ─────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
const addDays = (s, n) => { const dt = parse(s); dt.setUTCDate(dt.getUTCDate() + n); return fmt(dt); };
const dow = (s) => parse(s).getUTCDay();                 // 0 = dimanche
const mondayOf = (s) => addDays(s, dow(s) === 0 ? -6 : 1 - dow(s));
const dateFr = (s) => { const dt = parse(s); return `${DAYS_SHORT[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`; };
const dayFr = (s) => { const dt = parse(s); return `${DAYS_SHORT[dt.getUTCDay()]} ${dt.getUTCDate()}`; };
// Date et heure à Nouméa à partir d'un instant (ms)
const nc = (ms) => { const dt = new Date(ms + NC_OFFSET_MS); return { date: fmt(dt), hour: dt.getUTCHours(), minute: dt.getUTCMinutes(), dow: dt.getUTCDay() }; };

// ── 1) commandes : nouvelle commande -> Access ; validée -> le magasin ──────
function orderMessages(docId, before, after) {
  const m = /^order_(\d{4}-\d{2}-\d{2})_([a-z]+)$/.exec(docId || '');
  if (!m || !Object.prototype.hasOwnProperty.call(SHOPS, m[2]) || !after) return [];
  const [, date, shop] = m, label = SHOPS[shop], out = [];
  if (!(before && before.ts) && after.ts && after.status !== 'validated')
    out.push({ role: 'access', title: '🆕 Commande ' + label, body: 'Nouvelle commande reçue pour le ' + dateFr(date), tag: `order-${shop}-${date}`, url: URLS.access });
  if (!(before && before.status === 'validated') && after.status === 'validated')
    out.push({ role: shop, title: '✅ Commande validée', body: 'Votre commande du ' + dateFr(date) + ' a été validée', tag: `valid-${shop}-${date}`, url: URLS[shop] });
  return out;
}

// ── 2) riz de la semaine EN COURS : changements réels de boules ─────────────
// weekDocId : « week_AAAA-MM-JJ » ; nowMs : instant courant. Les champs de poisson (--f--) et de rolls (--r--) ne comptent pas.
function rizChanges(weekDocId, before, after, nowMs) {
  const wm = /^week_(\d{4}-\d{2}-\d{2})$/.exec(weekDocId || '');
  if (!wm || !after || wm[1] !== mondayOf(nc(nowMs).date)) return [];
  const b = before || {}, out = [];
  for (const k of Object.keys(after)) {
    const m = /^(\d{4}-\d{2}-\d{2})--(dsm|mgt|paita|ville)$/.exec(k);
    if (!m) continue;
    const prev = Number(b[k] || 0), cur = Number(after[k] || 0);
    if (prev !== cur) out.push({ shop: m[2], date: m[1], before: prev, after: cur });
  }
  return out;
}

// Fusionne des changements dans l'attente d'un magasin : on garde la PREMIÈRE valeur « avant » et la dernière « après »
function mergePending(pending, changes, nowMs) {
  const p = { changes: { ...((pending && pending.changes) || {}) } };
  for (const c of changes) {
    const old = p.changes[c.date];
    p.changes[c.date] = { before: old ? old.before : c.before, after: c.after };
  }
  p.dueAt = nowMs + QUIET_MS;      // chaque nouvelle saisie repousse l'envoi (on notifie quand le magasin a fini)
  return p;
}

// Au moment d'envoyer : seuls les jours dont la valeur finale diffère de la valeur initiale comptent
function digestMessage(shop, changes) {
  const net = Object.entries(changes || {}).filter(([, v]) => v.before !== v.after).sort(([a], [b]) => (a < b ? -1 : 1));
  if (!net.length) return null;                              // aller-retour (ex. +250 puis -250) : aucune notification
  const lines = net.slice(0, 3).map(([d, v]) => `${dayFr(d)} : ${v.before} → ${v.after}`);
  if (net.length > 3) lines.push(`+ ${net.length - 3} autre(s) jour(s)`);
  return { role: 'access', title: '📊 Riz — ' + SHOPS[shop], body: lines.join('\n'), tag: 'riz-' + shop, url: URLS.access };
}

// ── 3) présence : demande d'approbation -> Prod ─────────────────────────────
function presenceMessage(before, after) {
  if (!after || after.pendingApproval !== true || after.rejected === true) return null;
  if (before && before.pendingApproval === true) return null;     // déjà en attente : pas de répétition
  const who = [after.userName, after.shop && SHOPS[after.shop]].filter(Boolean).join(' · ') || 'appareil inconnu';
  return { role: 'prod', title: '🔐 Demande d\'approbation', body: `${after.iface || 'Interface'} — ${who}${after.device ? ' (' + after.device + ')' : ''}`, tag: 'approval-' + (after.devId || 'x'), url: URLS.prod };
}

// ── 4) rappel de l'heure limite (14h00 à Nouméa, lundi-vendredi) ────────────
// Même règle que les pages de commande : demain, en sautant les jours off et les dimanches.
function deliveryDate(todayNcDate, offDates) {
  let d = addDays(todayNcDate, dow(todayNcDate) === 6 ? 2 : 1);
  while (offDates.has(d)) { d = addDays(d, 1); if (dow(d) === 0) d = addDays(d, 1); }
  return d;
}
// Dates de jours off (tous types) d'un magasin à partir du document hiro-config/jours-off
function offDatesOf(joursOffDoc, shop) {
  const raw = joursOffDoc && joursOffDoc[shop];
  let arr = [];
  try { arr = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []; } catch (e) { arr = []; }
  return new Set(arr.map((e) => (typeof e === 'string' ? e : e && e.date)).filter(Boolean));
}
// shopsWithSubs : magasins qui ont au moins un appareil abonné ; hasOrder(shop, date) -> bool
function reminders(nowMs, shopsWithSubs, joursOffDoc, hasOrder) {
  const t = nc(nowMs);
  if (t.dow === 0 || t.dow === 6) return [];                 // pas d'heure limite le week-end
  const out = [];
  for (const shop of shopsWithSubs) {
    if (!Object.prototype.hasOwnProperty.call(SHOPS, shop)) continue;
    const date = deliveryDate(t.date, offDatesOf(joursOffDoc, shop));
    if (hasOrder(shop, date)) continue;
    out.push({ role: shop, title: '⏰ Commande à envoyer', body: `Il vous reste jusqu'à 14h00 pour la commande du ${dateFr(date)}`, tag: `deadline-${shop}-${date}`, url: URLS[shop] });
  }
  return out;
}

module.exports = { SHOPS, URLS, QUIET_MS, orderMessages, rizChanges, mergePending, digestMessage, presenceMessage, deliveryDate, offDatesOf, reminders, nc, mondayOf, addDays, dow, dateFr, dayFr };
