/* Last Card client. Every player's browser keeps a copy of the table, applies moves with
   the rules in engine.js, and saves through Supabase (lc_save checks the version so two
   saves can't clobber each other). Realtime pushes each save to everyone at the table. */
(function () {
'use strict';

const E = window.LCEngine;
const {MAXP, AV_COUNT, COLS, CNAME, CARD_RE, RULES, TURN_SECONDS, rint, isWild, cardName, canPlay, ruleOn, newTable, newSeat,
  applyAct, botMove, botCatchTarget, doCatch, addBot} = E;
const CFG = window.LC_CONFIG || {};
const CONFIGURED = typeof CFG.url === 'string' && /^https:\/\/\S+$/.test(CFG.url) &&
  typeof CFG.key === 'string' && CFG.key.length > 20 && CFG.key.indexOf('%%') < 0;

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const ESC = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]); }
function cleanName(s){
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 16);
}
function cleanCode(s){ return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24); }
function hash(k){ let h = 7; for (const ch of String(k)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function decode(h){ return (typeof h === 'string' ? (h.match(/../g) || []) : []).filter(c => CARD_RE.test(c)); }
const CO = {r:0, y:1, g:2, b:3, w:4};
const VO = '0123456789SRDWF';
function sortHand(h){ return h.slice().sort((a, b) => CO[a[0]] - CO[b[0]] || VO.indexOf(a[1]) - VO.indexOf(b[1])); }
function clone(o){ return JSON.parse(JSON.stringify(o)); }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function randId(n){
  const a = new Uint8Array(n);
  try { crypto.getRandomValues(a); } catch (e){ for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); }
  return Array.from(a, b => (b % 36).toString(36)).join('');
}
const LS = {
  get(k){ try { return localStorage.getItem(k); } catch (e){ return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch (e){} }
};
function validG(g){
  return !!g && typeof g === 'object' && typeof g.ph === 'string' && Array.isArray(g.seats) && Array.isArray(g.deck) &&
    Array.isArray(g.disc) && Array.isArray(g.q) && Array.isArray(g.log) && !!g.rules && typeof g.rules === 'object';
}

/* ---------- faces and cards ---------- */
const AV = ['😎','🤠','🦊','🐸','👽','🐼','🦁','🐙','🐧','👻','🐯','🦄','🐵','🐶','🐱','🐻'];
function avIndex(av, k){ const n = Number(av); return Number.isInteger(n) && n >= 0 && n < AV.length ? n : hash(k) % AV.length; }
function avHTML(s, tag, attrs, timerMs){
  const face = s.b ? '🤖' : AV[avIndex(s.av, s.k)];
  const h = hash(s.k) % 360;
  const t = tag || 'span';
  const ring = timerMs !== undefined ? '<svg class="tring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18.5" style="animation-duration:' +
    (TURN_SECONDS * 1000) + 'ms;animation-delay:-' + Math.max(0, timerMs).toFixed(0) + 'ms"/></svg>' : '';
  return '<' + t + ' class="av" style="--h:' + h + '"' + (attrs || '') + '>' + face + ring +
    (s.w ? '<span class="wins" aria-label="' + s.w + ' wins">' + s.w + '</span>' : '') + '</' + t + '>';
}
const ICON = {
  S:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M6.6 17.4 17.4 6.6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  R:'<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h15l-3.6-3.6"/><path d="M20 15.5H5l3.6 3.6"/></svg>',
  X:'<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h4l10 10h4"/><path d="M3 17h4l3-3"/><path d="M14 10l3-3h4"/><path d="M18 4l3 3-3 3"/><path d="M18 14l3 3-3 3"/></svg>'
};
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
function suitHTML(c){ return '<i class="suit s-' + c + '"></i>'; }
function special(face, label, corner){
  return '<span class="corner tl">' + corner + '</span><span class="sp"><span class="face">' + face + '</span><span class="lbl">' + label +
    '</span></span><span class="corner br">' + corner + '</span>';
}
function cardHTML(c, cls, style){
  let inner, kind = '';
  const v = c[1];
  if (c === 'wT'){ kind = ' ten'; inner = special('+10', 'Wild', '+10'); }
  else if (c === 'wX'){ kind = ' shuf'; inner = special(ICON.X, 'Shuffle', ICON.X); }
  else if (v === 'L'){ kind = ' legend'; inner = special(STAR, 'All', STAR); }
  else if (v === 'M'){ kind = ' magic'; inner = special('7', 'Swap', '7' + suitHTML(c[0])); }
  else if (v === 'Z'){ kind = ' magic'; inner = special('0', 'Spin', '0' + suitHTML(c[0])); }
  else if (c === 'wW'){
    inner = '<span class="corner tl">W</span><span class="wheel">' + COLS.map(suitHTML).join('') + '</span><span class="corner br">W</span>';
  } else if (c === 'wF'){
    inner = '<span class="corner tl">+4</span><span class="wf"><span class="face plus">+4</span><span class="wheel row">' + COLS.map(suitHTML).join('') + '</span></span><span class="corner br">+4</span>';
  } else {
    const g = ICON[v] || (v === 'D' ? '+2' : v);
    const corner = g + suitHTML(c[0]);
    const fcls = 'face' + (v === 'D' ? ' plus' : '') + (v === '6' || v === '9' ? ' ul' : '');
    inner = '<span class="corner tl">' + corner + '</span><span class="' + fcls + '">' + g + '</span><span class="corner br">' + corner + '</span>';
  }
  return '<span class="card ' + (isWild(c) ? 'wild' : 'c-' + c[0]) + kind + (cls ? ' ' + cls : '') + '" role="img" aria-label="' + esc(cardName(c)) + '"' + (style ? ' style="' + style + '"' : '') + '>' + inner + '</span>';
}

/* ---------- state ---------- */
const CODE = cleanCode(new URLSearchParams(location.search).get('t')) || 'main';
function getPid(){
  let p = LS.get('lastcard.pid');
  if (!p || !/^p[a-z0-9]{8,24}$/.test(p)){ p = 'p' + randId(10); LS.set('lastcard.pid', p); }
  return p;
}
function storedAv(){ const n = Number(LS.get('lastcard.av')); return Number.isInteger(n) && n >= 0 && n < AV.length ? n : rint(AV.length); }
const S = {
  mode:'connecting', G:null, version:0, pid:getPid(), name:cleanName(LS.get('lastcard.name') || ''), av:storedAv(),
  online:new Map(), synced:false, connected:false, saving:false, busy:false, loadErr:false, lastFetch:0,
  pickCard:null, lastLpn:null, landUntil:0, lastHandStr:null, lastRd:null, handCards:[], freshMask:[], freshUntil:0,
  wasMyTurn:false, captionKey:null, captionT:null
};
let sb = null, ch = null;
const memo = {};
function setHTML(el, key, html){ if (memo[key] === html) return; memo[key] = html; el.innerHTML = html; }

function isPresent(k){
  if (S.mode !== 'live') return true;
  if (String(k).indexOf('bot:') === 0 || k === S.pid || !S.synced) return true;
  return S.online.has(k);
}
function view(G){
  return {
    ph:G.ph, rd:G.rd,
    seats:G.seats.map(s => ({k:s.k, n:s.n, av:s.av, h:(s.hand || []).join(''), c:!!s.called, s:s.score || 0, w:s.wins || 0, b:!!s.bot, r:!!s.rdy, o:!!s.out})),
    q:G.q.map(x => ({k:x.k, n:x.n, av:x.av})),
    pile:G.disc.slice(-3), pc:G.disc.length, col:COLS.indexOf(G.col) >= 0 ? G.col : 'r', dir:G.dir === -1 ? -1 : 1,
    turn:G.turn, pend:G.pend || 0, pt:G.pt, dr:!!G.drew, dn:G.dn, dk:G.deck.length,
    log:G.log.slice(-4), win:G.win, champ:G.champ, rules:RULES.reduce((o, r) => { o[r] = ruleOn(G, r); return o; }, {}), fx:G.fx || null,
    lpn:G.lpn || 0, lpk:G.lpk || null, again:!!G.again
  };
}
function mySeat(p){ return p ? p.seats.find(s => s.k === S.pid) || null : null; }
function ctxPub(p){ const pile = p.pile || []; return {top:pile[pile.length - 1] || 'r0', color:p.col, pend:p.pend, pt:p.pt}; }
function topCard(p){ const pile = p.pile || []; return pile[pile.length - 1] || ''; }
function jumpable(p, ms, c, myTurn){
  return !!ms && p.ph === 'play' && !myTurn && p.rules.jump && !p.pend && !ms.o && !isWild(c) && c === topCard(p) && p.lpk !== S.pid;
}
/* When the current turn began, by this device's clock. Used for the 15-second countdown. */
function turnSig(p){ return p && p.ph === 'play' ? [p.rd, p.turn, p.lpn, p.dr ? 1 : 0, p.pend, p.log[p.log.length - 1] || ''].join('|') : ''; }
function turnElapsed(){ return Date.now() - (S.turnStart || Date.now()); }
function shareUrl(){ return location.origin + location.pathname + (CODE === 'main' ? '' : '?t=' + CODE); }
function rejoinSeat(p, name){
  if (!p || !name) return null;
  const key = name.toLowerCase();
  return p.seats.find(s => !s.b && s.k !== S.pid && s.n.toLowerCase() === key && !isPresent(s.k)) || null;
}

/* ---------- syncing with Supabase ---------- */
function changed(){ render(); schedule(); }
function adopt(row, force){
  if (!row || !validG(row.state)) return;
  const v = +row.version || 0;
  if (force ? v < S.version : v <= S.version && S.G) return;
  S.G = clone(row.state); S.version = v;
  changed();
}
async function refresh(){
  if (!sb) return;
  S.lastFetch = Date.now();
  try {
    const r = await sb.from('lc_rooms').select('version,state').eq('code', CODE).maybeSingle();
    if (r.error) throw r.error;
    if (r.data) adopt(r.data, false);
    else if (!S.G){ S.G = newTable(); S.version = 0; changed(); }
    if (S.loadErr){ S.loadErr = false; render(); }
  } catch (e){
    S.loadErr = true; render();
  }
}
async function fetchRow(){
  const r = await sb.from('lc_rooms').select('version,state').eq('code', CODE).maybeSingle();
  if (r.error) throw r.error;
  return r.data;
}
async function commit(fn){
  for (let attempt = 0; attempt < 3; attempt++){
    if (!S.G) return false;
    const base = S.G, baseV = S.version;
    const G = clone(base);
    if (!fn(G)) return false;
    if (S.mode !== 'live'){ S.G = G; S.version++; changed(); return true; }
    S.G = G; S.saving = true; changed();
    let v = null, err = null;
    try {
      const r = await sb.rpc('lc_save', {p_code:CODE, p_version:baseV, p_state:G});
      if (r.error) err = r.error; else v = +r.data;
    } catch (e){ err = e; }
    S.saving = false;
    if (err){
      if (S.G === G){ S.G = base; S.version = baseV; }
      changed();
      toast("Couldn't reach the table. Check your connection and try again.");
      return false;
    }
    if (v > 0){
      if (S.version < v){ S.G = G; S.version = v; }
      changed();
      return true;
    }
    // Someone else saved first: load their version and try the move again on top of it.
    try {
      const row = await fetchRow();
      if (row) adopt(row, true);
      else { S.G = newTable(); S.version = 0; changed(); }
    } catch (e){
      if (S.G === G){ S.G = base; S.version = baseV; }
      changed();
      return false;
    }
  }
  return false;
}
let chain = Promise.resolve();
function queue(fn){ chain = chain.then(() => commit(fn)).catch(e => console.error(e)); return chain; }
function act(t, extra){
  if (!S.G) return;
  requestWake();
  const a = Object.assign({t:t}, extra || {});
  const name = S.name || 'Player';
  S.busy = true; render();
  queue(G => applyAct(G, S.pid, name, a, isPresent)).then(() => { S.busy = false; render(); });
}

/* Bots and bot catches are run by one browser at the table: the online player with the
   lowest id. Everyone else waits longer and only steps in if that browser goes quiet. */
let botT = null, catchT = null, catchKey = null, timerT = null;
function driverRank(){
  if (S.mode !== 'live') return 0;
  const ids = Array.from(S.online.keys()).filter(id => /^p[a-z0-9]+$/.test(id)).sort();
  const i = ids.indexOf(S.pid);
  return i < 0 ? ids.length : i;
}
let tidyT = null;
function staleLobby(G){
  return !!G && G.ph !== 'play' && S.mode === 'live' && S.synced && G.seats.length > 0 && !G.seats.some(s => !s.bot && isPresent(s.k));
}
function schedule(){
  clearTimeout(botT);
  const G = S.G;
  if (staleLobby(G)){
    if (!tidyT) tidyT = setTimeout(() => {
      tidyT = null;
      if (staleLobby(S.G) && driverRank() === 0) queue(G2 => applyAct(G2, S.pid, S.name || 'Player', {t:'reset'}, isPresent));
    }, 10000);
  } else if (tidyT){ clearTimeout(tidyT); tidyT = null; }
  if (!G || G.ph !== 'play'){ clearTimeout(catchT); clearTimeout(timerT); catchKey = null; return; }
  const rank = driverRank();
  const cur = G.seats[G.turn];
  clearTimeout(timerT);
  if (cur && !cur.bot && ruleOn(G, 'timer')){
    const sig = turnSig(view(G));
    const wait = TURN_SECONDS * 1000 - turnElapsed() + (rank === 0 ? 150 : 2500 + rank * 1500);
    timerT = setTimeout(() => {
      if (turnSig(S.G ? view(S.G) : null) !== sig) return;
      queue(G2 => applyAct(G2, S.pid, S.name || 'Player', {t:'timeout', x:cur.k}, isPresent));
    }, Math.max(200, wait));
  }
  if (cur && cur.bot){
    const v = S.version;
    const delay = rank === 0 ? 900 + rint(700) : 5000 + rank * 1500 + rint(1500);
    botT = setTimeout(() => { if (S.version === v) queue(G2 => botMove(G2)); }, delay);
  }
  const ct = botCatchTarget(G);
  if (!ct){ clearTimeout(catchT); catchKey = null; }
  else if (catchKey !== ct.t.k){
    clearTimeout(catchT);
    catchKey = ct.t.k;
    const delay = (rank === 0 ? 2600 : 7000 + rank * 1500) + rint(2600);
    catchT = setTimeout(() => {
      catchKey = null;
      queue(G2 => { const c2 = botCatchTarget(G2); return c2 ? doCatch(G2, c2.bot.k, c2.t.k) : false; });
    }, delay);
  }
}

function connect(){
  sb = window.supabase.createClient(CFG.url.replace(/\/$/, ''), CFG.key, {
    auth:{persistSession:false, autoRefreshToken:false, detectSessionInUrl:false}
  });
  S.mode = 'live';
  ch = sb.channel('table-' + CODE, {config:{presence:{key:S.pid}}});
  ch.on('postgres_changes', {event:'*', schema:'public', table:'lc_rooms', filter:'code=eq.' + CODE}, payload => {
    const n = payload && payload.new;
    if (n && validG(n.state)) adopt({version:n.version, state:n.state}, false);
    else refresh();
  });
  ch.on('broadcast', {event:'react'}, msg => {
    const d = msg && msg.payload;
    if (d && typeof d.t === 'string' && Number.isInteger(d.e)) showReaction(d.t, d.e);
  });
  ch.on('presence', {event:'sync'}, () => {
    const st = ch.presenceState();
    const m = new Map();
    for (const k in st){ const metas = st[k]; m.set(k, (metas && metas[0]) || {}); }
    S.online = m; S.synced = true;
    changed();
  });
  ch.subscribe(status => {
    S.connected = status === 'SUBSCRIBED';
    if (S.connected){ ch.track({name:S.name || ''}).catch(() => {}); refresh(); }
    render();
  });
  refresh();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!S.connected || S.loadErr || Date.now() - S.lastFetch > 20000) refresh();
  }, 5000);
}
function startPractice(){
  S.mode = 'practice';
  const G = newTable();
  G.seats.push(newSeat(S.pid, S.name || 'Player', false, S.av));
  addBot(G); addBot(G);
  G.log = [];
  S.G = G; S.version = 1;
  changed();
}

/* ---------- small device niceties ---------- */
let wake = null;
async function requestWake(){
  try {
    if (!wake && navigator.wakeLock && document.visibilityState === 'visible'){
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    }
  } catch (e){}
}
let toastT = null;
function toast(msg){
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- rendering ---------- */
const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
function arcAngles(m){
  if (m === 1) return [90];
  if (m === 2) return [148, 32];
  if (m === 3) return [165, 90, 15];
  const a = [];
  for (let i = 0; i < m; i++) a.push(172 - i * (164 / (m - 1)));
  return a;
}
function everyoneAway(p){
  if (S.mode !== 'live' || !S.synced || !p) return false;
  if (!p.seats.length && !p.q.length) return false;
  return !p.seats.some(s => !s.b && isPresent(s.k));
}
function render(){ try { renderInner(); } catch (e){ console.error(e); } }
function renderInner(){
  const p = S.G ? view(S.G) : null;
  if (p && p.ph === 'over') p.ph = 'lobby'; // tables saved by the earlier version
  const ms = mySeat(p);
  const playing = !!(p && p.ph === 'play');
  const cur = playing ? p.seats[p.turn] : null;
  const myTurn = !!(cur && cur.k === S.pid);
  document.title = myTurn ? '(Your turn) Last Card' : 'Last Card';
  if (myTurn && !S.wasMyTurn){ try { if (navigator.vibrate) navigator.vibrate(35); } catch (e){} }
  S.wasMyTurn = myTurn;
  const sig = turnSig(p);
  if (sig !== S.turnSigSeen){ S.turnSigSeen = sig; S.turnStart = Date.now(); }

  renderNet();
  const pos = renderSeats(p, ms);
  renderCenter(p, playing, myTurn, pos);
  renderDock(p, ms, myTurn);
  renderBeam(p, cur, pos);
  renderWin(p);
  renderMenu(p, ms);
  renderFx(p);
  animateDraws(p, pos);
}
const FX_TEXT = {ten:'+10!', legend:'Legendary!', swap:'Swap!', spin:'Spin!', shuffle:'Shuffle!'};
function renderFx(p){
  const key = p && p.fx ? p.rd + ':' + p.fx.n : null;
  if (S.fxSeen === undefined){ S.fxSeen = key; return; }
  if (!key || key === S.fxSeen) return;
  S.fxSeen = key;
  const el = $('#fx');
  el.textContent = FX_TEXT[p.fx.t] || '';
  el.className = 'fx ' + p.fx.t;
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add('go');
  clearTimeout(S.fxT);
  S.fxT = setTimeout(() => { el.hidden = true; }, 1500);
}
function renderNet(){
  const el = $('#net');
  let t = '';
  if (S.mode === 'practice') t = 'Practice';
  else if (S.mode === 'connecting') t = 'Connecting';
  else if (S.loadErr && !S.connected) t = 'Offline';
  else if (!S.connected) t = 'Connecting';
  el.hidden = !t; el.textContent = t;
}
function lobbyCounts(p){
  const here = p.seats.filter(s => !s.b && isPresent(s.k));
  return {here:here, ready:here.filter(s => s.r), bots:p.seats.filter(s => s.b).length};
}
function renderCenter(p, playing, myTurn, pos){
  $('#lobbyMark').hidden = playing;
  $('#piles').hidden = !playing;
  if (!playing){
    let t = 'Pull up a chair.';
    if (S.mode === 'connecting' || !p) t = S.loadErr ? "Can't reach the table. Retrying…" : 'Setting up the table…';
    else if (p.seats.length){
      const c = lobbyCounts(p);
      if (c.here.length + c.bots < 2) t = 'Waiting for one more player.';
      else t = c.ready.length + ' of ' + c.here.length + ' ready. It starts when everyone is.';
    }
    if (p && p.win && p.win.n && p.seats.length) t = '👑 ' + (p.win.k === S.pid ? 'You' : p.win.n) + ' won the last round. ' + t;
    $('#lobbyText').textContent = t;
    $('#caption').textContent = '';
    return;
  }
  const deck = $('#deckBtn');
  deck.disabled = !(myTurn && !p.dr) || S.busy;
  deck.classList.toggle('ready', myTurn && !p.dr);
  deck.setAttribute('aria-label', p.pend && myTurn ? 'Draw ' + p.pend + ' cards' : 'Draw a card');
  $('#deckN').textContent = p.dk;
  const pt = $('#pendTag');
  pt.hidden = !p.pend; pt.textContent = '+' + p.pend;
  $('#dir').classList.toggle('rev', p.dir === -1);

  // The card just played flies in from whoever played it.
  if (S.lastLpn !== null && S.lastLpn !== p.lpn){
    S.landUntil = Date.now() + 500;
    S.landFrom = '0px,-90px';
    const d = $('#discard').getBoundingClientRect(), tb = $('#table').getBoundingClientRect();
    const dcx = d.left + d.width / 2, dcy = d.top + d.height / 2;
    let sx = null, sy = null;
    if (p.lpk && p.lpk === S.pid){ const h = $('#hand').getBoundingClientRect(); sx = h.left + h.width / 2; sy = h.top + h.height / 2; }
    else if (p.lpk && pos[p.lpk]){ sx = tb.left + pos[p.lpk].x; sy = tb.top + pos[p.lpk].y; }
    if (sx !== null) S.landFrom = (sx - dcx).toFixed(0) + 'px,' + (sy - dcy).toFixed(0) + 'px';
  }
  S.lastLpn = p.lpn;
  const landing = Date.now() < S.landUntil;
  const pile = p.pile || [];
  const fxy = (S.landFrom || '0px,-90px').split(',');
  setHTML($('#discard'), 'discard', '<span class="ring" style="--cur:var(--c-' + p.col + ')"></span>' + pile.map((c, i) => {
    const idx = p.pc - pile.length + i;
    const rot = ((idx * 47) % 19) - 9;
    const top = i === pile.length - 1 && landing;
    return cardHTML(c, top ? 'land' : '', '--rot:' + rot + 'deg' + (top ? ';--fx:' + fxy[0] + ';--fy:' + fxy[1] : ''));
  }).join(''));

  // Show what just happened under the piles for a few seconds.
  const last = p.log[p.log.length - 1] || '';
  const key = p.lpn + '|' + p.log.length + '|' + last;
  const cap = $('#caption');
  if (key !== S.captionKey){
    S.captionKey = key;
    cap.textContent = last;
    cap.classList.remove('fade');
    clearTimeout(S.captionT);
    S.captionT = setTimeout(() => cap.classList.add('fade'), 4000);
  }
}
function seatHTML(s, p, ms, x, y){
  const n = s.h.length / 2;
  const playing = p.ph === 'play';
  const cur = p.seats[p.turn];
  const isTurn = playing && cur && cur.k === s.k;
  const away = !s.b && !isPresent(s.k);
  const catchable = playing && !!ms && n === 1 && !s.c && !s.o;
  let bubble = '';
  if (catchable) bubble = '<span class="bubble hot">Catch!</span>';
  else if (playing && n === 1 && s.c) bubble = '<span class="bubble">Last card!</span>';
  else if (isTurn && p.again) bubble = '<span class="bubble">Again!</span>';
  const backs = playing && !s.o ? '<span class="mini-hand" aria-label="' + n + ' cards">' +
    new Array(Math.min(n, 7)).fill('<i></i>').join('') + '<b>' + n + '</b></span>' : '';
  let tag = '';
  if (s.o) tag = '<span class="tagline">Out</span>';
  else if (away) tag = '<span class="tagline">Away</span>';
  else if (!playing) tag = (s.b || s.r) ? '<span class="tagline ok">Ready</span>' : '<span class="tagline">Not ready</span>';
  const timer = isTurn && !s.b && p.rules.timer ? turnElapsed() : undefined;
  return '<button type="button" class="seat' + (isTurn ? ' turn' : '') + (away || s.o ? ' away' : '') + '" data-seat="' + esc(s.k) +
    '" style="left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px" aria-label="' + esc(s.n) + (catchable ? ', catch them' : '') + '">' +
    bubble + avHTML(s, 'span', '', timer) + '<span class="nm">' + esc(s.n) + '</span>' + backs + tag + '</button>';
}
function renderSeats(p, ms){
  const box = $('#table').getBoundingClientRect();
  const W = box.width, H = box.height;
  const pos = {};
  if (!p){ setHTML($('#seats'), 'seats', ''); return pos; }
  const L = p.seats.length;
  const myIdx = p.seats.findIndex(s => s.k === S.pid);
  const others = myIdx >= 0 ? p.seats.map((_, i) => p.seats[(myIdx + 1 + i) % L]).slice(0, -1) : p.seats.slice();
  const angles = arcAngles(others.length);
  const cy = H * 0.46, rx = Math.min(W * 0.41, 300), ry = H * 0.31;
  const topMin = $('.bar').getBoundingClientRect().bottom - box.top + 46;
  const html = others.map((s, i) => {
    const a = angles[i] * Math.PI / 180;
    const x = clamp(W / 2 + rx * Math.cos(a), 46, W - 46);
    const y = Math.max(cy - ry * Math.sin(a), topMin);
    pos[s.k] = {x:x, y:y};
    return seatHTML(s, p, ms, x, y);
  }).join('');
  const el = $('#seats');
  el.classList.toggle('crowded', others.length >= 6);
  setHTML(el, 'seats', html);
  return pos;
}
function renderBeam(p, cur, pos){
  const beam = $('#beam');
  if (!p || p.ph !== 'play' || !cur){ beam.hidden = true; return; }
  const box = $('#table').getBoundingClientRect();
  const pr = $('#piles').getBoundingClientRect();
  const cx = pr.left + pr.width / 2 - box.left, cy = pr.top + pr.height / 2 - box.top;
  let tx, ty;
  if (cur.k === S.pid){
    const me = $('#meRow .av');
    if (!me){ beam.hidden = true; return; }
    const r = me.getBoundingClientRect();
    tx = r.left + r.width / 2 - box.left; ty = r.top + r.height / 2 - box.top;
  } else if (pos[cur.k]){ tx = pos[cur.k].x; ty = pos[cur.k].y; }
  else { beam.hidden = true; return; }
  const dx = tx - cx, dy = ty - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx) * 180 / Math.PI - 90;
  beam.hidden = false;
  beam.style.left = cx + 'px';
  beam.style.top = cy + 'px';
  beam.style.height = Math.max(0, dist - 34) + 'px';
  beam.style.transform = 'rotate(' + ang.toFixed(1) + 'deg)';
}
function renderDock(p, ms, myTurn){
  const playing = !!(p && p.ph === 'play');
  // you
  let meHTML = '';
  if (ms){
    const n = ms.h.length / 2;
    let sub = '', subCls = '';
    if (playing){
      if (ms.o) sub = "You're out this round";
      else if (myTurn){
        subCls = 'mine';
        sub = p.pend ? 'Your turn: stack a draw card or take ' + p.pend :
          p.dr ? 'Play it or keep it' : p.again ? 'Go again!' : 'Your turn';
      } else sub = n + (n === 1 ? ' card' : ' cards');
    } else {
      sub = ms.r ? 'Ready' : 'Not ready';
      subCls = ms.r ? 'mine' : '';
    }
    meHTML = avHTML(ms, 'button', ' type="button" id="meAv" aria-label="Change your face"', myTurn && p.rules.timer ? turnElapsed() : undefined) +
      '<span class="who"><b>' + esc(ms.n) + '</b><span class="' + subCls + '">' + esc(sub) + '</span></span>';
  }
  const meRow = $('#meRow');
  setHTML(meRow, 'me', meHTML);
  meRow.classList.toggle('turn', myTurn);

  // join form for people without a seat
  const queued = !!(p && p.q.some(x => x.k === S.pid));
  const away = everyoneAway(p);
  const showJoin = !!p && !ms && !queued && !(away && playing);
  $('#joinForm').hidden = !showJoin;
  if (showJoin){
    const nm = cleanName($('#nameInput').value);
    const back = rejoinSeat(p, nm);
    $('#joinBtn').textContent = back ? 'Rejoin as ' + back.n : playing ? 'Join next round' : 'Sit down';
    $('#joinText').textContent = back ? 'Your seat is waiting with your cards.' :
      playing ? "A round is going. Sit down and you're in the next one." : 'Pick a face and a name to sit down.';
    renderAvPick($('#avPick'), S.av);
  }

  // buttons
  let ah = '';
  if (p && !playing && ms){
    const c = lobbyCounts(p);
    const waiting = c.here.filter(s => !s.r && s.k !== S.pid).map(s => s.n);
    let hint = '';
    if (c.here.length + c.bots < 2) hint = 'Invite friends or add a bot to play.';
    else if (ms.r) hint = waiting.length ? 'Waiting for ' + waiting.slice(0, 3).join(', ') + (waiting.length > 3 ? ' and ' + (waiting.length - 3) + ' more' : '') : 'Shuffling…';
    if (hint) ah += '<span class="hint">' + esc(hint) + '</span>';
    ah += '<button type="button" class="btn" data-act="bot"' + (p.seats.length >= MAXP || S.busy ? ' disabled' : '') + '>Add a bot</button>';
    ah += ms.r ? '<button type="button" class="btn on" data-act="ready" data-v="0">Ready ✓</button>'
               : '<button type="button" class="btn go" data-act="ready" data-v="1"' + (S.busy ? ' disabled' : '') + '>Ready</button>';
  } else if (playing){
    if (!ms){
      if (away) ah += '<span class="hint">Everyone at this table has left.</span><button type="button" class="btn go" data-act="reset">Clear the table</button>';
      else if (queued) ah += "<span class=\"hint\">You're in next round. Watching for now.</span>";
    } else {
      const n = ms.h.length / 2;
      if (myTurn && p.dr) ah += '<button type="button" class="btn" data-act="pass"' + (S.busy ? ' disabled' : '') + '>Keep it</button>';
      const canCall = !ms.c && (n === 1 || (n === 2 && myTurn));
      if (canCall) ah += '<button type="button" class="btn call' + (n === 1 ? ' urgent' : '') + '" data-act="call">Last card!</button>';
    }
  }
  setHTML($('#actions'), 'actions', ah);

  // your hand
  const handStr = ms && playing ? ms.h : '';
  const rd = p ? p.rd : null;
  if (handStr !== S.lastHandStr || rd !== S.lastRd){
    const mine = sortHand(decode(handStr));
    let mask = mine.map(() => false), kind = 'draw';
    if (S.lastHandStr !== null){
      if (rd !== S.lastRd){ mask = mine.map(() => true); kind = 'deal'; }
      else {
        const m = {};
        decode(S.lastHandStr).forEach(c => { m[c] = (m[c] || 0) + 1; });
        mine.forEach((c, i) => { if (m[c]) m[c]--; else mask[i] = true; });
        // cards left that weren't played (a swap, spin or shuffle): show the new hand being dealt
        const gone = Object.keys(m).reduce((t, c) => t + m[c], 0);
        if (gone > 1 || (gone && mask.some(Boolean))) kind = 'deal';
      }
    }
    S.handCards = mine; S.freshMask = mask; S.freshKind = kind;
    S.freshUntil = Date.now() + 900 + mine.length * 50;
    clearTimeout(S.freshT);
    S.freshT = setTimeout(() => { memo.hand = null; render(); }, 1500 + mine.length * 50);
    S.lastHandStr = handStr; S.lastRd = rd;
  }
  const handEl = $('#hand');
  if (!ms || !playing || !S.handCards.length){ setHTML(handEl, 'hand', ''); return; }
  const fresh = Date.now() < S.freshUntil;
  const ctx = ctxPub(p);
  const n = S.handCards.length;
  const cw = window.innerWidth >= 560 ? 74 : (window.innerHeight <= 660 ? 56 : 64);
  const avail = Math.max(200, handEl.clientWidth - 12);
  const step = n > 1 ? Math.max(22, Math.min(cw * 0.78, (avail - cw) / (n - 1))) : cw;
  const overflow = cw + step * (n - 1) > avail;
  handEl.style.justifyContent = overflow ? 'flex-start' : 'center';
  let k = 0;
  setHTML(handEl, 'hand', S.handCards.map((c, i) => {
    const jump = jumpable(p, ms, c, myTurn);
    const ok = (myTurn && canPlay(c, ctx) && (!p.dr || c === p.dn)) || jump;
    const isNew = fresh && S.freshMask[i];
    const cls = isNew ? (S.freshKind === 'deal' || REDUCED ? ' dealt' : ' incoming') : '';
    const st = (i ? 'margin-left:' + (step - cw).toFixed(1) + 'px;' : '') + (isNew ? '--d:' + (k++ * 45) + 'ms' : '');
    return '<button type="button" class="card-btn' + (ok ? ' ok' : '') + (myTurn && !ok ? ' dim' : '') + cls +
      '" data-c="' + c + '"' + (st ? ' style="' + st + '"' : '') + ' aria-label="' + esc(cardName(c)) + (ok ? ', playable' : '') + '">' + cardHTML(c) + '</button>';
  }).join(''));
}
function renderAvPick(el, sel){
  setHTML(el, el.id, AV.map((f, i) => '<button type="button" data-av="' + i + '" aria-pressed="' + (i === sel) + '" aria-label="Face ' + (i + 1) + '">' + f + '</button>').join(''));
}
/* Winner splash: shown when a round ends while you're watching, then the table goes back to the lobby. */
let winT = null;
function renderWin(p){
  if (!p) return;
  const rd = p.win && p.win.rd ? p.win.rd : null;
  if (S.lastWinRd === undefined){ S.lastWinRd = rd; return; }
  if (rd === S.lastWinRd) return;
  S.lastWinRd = rd;
  if (!rd || !p.win.n) return;
  const w = p.win;
  setHTML($('#overAv'), 'overAv', avHTML({k:w.k, av:w.av, b:w.b, w:w.w}));
  $('#overTitle').textContent = w.k === S.pid ? 'You win!' : w.n + ' wins!';
  $('#overSub').textContent = 'Round ' + rd + (w.b ? '' : ' · ' + w.w + (w.w === 1 ? ' win' : ' wins') + ' total');
  setHTML($('#standings'), 'standings', p.seats.slice().sort((a, b) => b.w - a.w)
    .map(s => '<span>' + esc(s.k === S.pid ? 'You' : s.n) + ' <b>' + s.w + '</b></span>').join(''));
  $('#over').hidden = false;
  clearTimeout(winT);
  winT = setTimeout(() => { $('#over').hidden = true; }, 5000);
}
/* Cards fly from the deck to whoever drew them: into your hand, or to another player's seat. */
function fly(from, to, o){
  const w = from.width, h = from.height;
  const el = document.createElement('span');
  el.className = 'card back flyer';
  el.innerHTML = '<span class="logo">Last<br>Card</span>';
  el.style.cssText = '--w:' + w + 'px;left:' + from.left + 'px;top:' + from.top + 'px';
  document.body.appendChild(el);
  const dx = to.left + to.width / 2 - (from.left + w / 2), dy = to.top + to.height / 2 - (from.top + h / 2);
  const sc = o.scale || Math.max(.2, to.width / w);
  const done = () => { el.remove(); if (o.done) o.done(); };
  if (!el.animate){ done(); return; }
  const a = el.animate([
    {transform:'translate(0,0) scale(1) rotate(0deg)', opacity:1},
    {transform:'translate(' + dx + 'px,' + dy + 'px) scale(' + sc + ') rotate(' + (o.rot || 10) + 'deg)', opacity:o.fade ? .2 : 1}
  ], {duration:440, delay:o.delay || 0, easing:'cubic-bezier(.25,.8,.25,1)', fill:'both'});
  a.onfinish = done; a.oncancel = done;
}
function animateDraws(p, pos){
  const playing = !!(p && p.ph === 'play');
  const counts = {};
  if (playing) for (const s of p.seats) counts[s.k] = s.h.length / 2;
  const prev = S.prevCounts, prevRd = S.prevRd;
  S.prevCounts = counts; S.prevRd = p ? p.rd : null;
  const reveal = () => document.querySelectorAll('#hand .incoming').forEach(b => b.classList.remove('incoming'));
  const rearranged = p && p.fx && ['swap', 'spin', 'shuffle'].indexOf(p.fx.t) >= 0 && p.fx.n !== S.fxFlown;
  if (rearranged) S.fxFlown = p.fx.n;
  if (!playing || !prev || prevRd !== p.rd || REDUCED || rearranged){ reveal(); return; }
  const top = $('#deckBtn .deck-stack .card:last-child');
  if (!top){ reveal(); return; }
  const from = top.getBoundingClientRect();
  const tb = $('#table').getBoundingClientRect();
  for (const s of p.seats){
    const before = prev[s.k], now = counts[s.k];
    if (before === undefined || now <= before) continue;
    if (s.k === S.pid){
      Array.from(document.querySelectorAll('#hand .incoming')).forEach((b, i) => {
        fly(from, b.getBoundingClientRect(), {delay:i * 150, done:() => b.classList.remove('incoming')});
      });
    } else if (pos[s.k]){
      const target = {left:tb.left + pos[s.k].x - 12, top:tb.top + pos[s.k].y - 18, width:24, height:36};
      for (let i = 0; i < Math.min(now - before, 6); i++) fly(from, target, {delay:i * 150, scale:.3, fade:true, rot:-8});
    }
  }
  setTimeout(reveal, 1600);
}
const RULE_INFO = {
  seven:['Magic 7', 'Swap hands with anyone you pick'],
  zero:['Spin 0', 'Everyone passes their hand along (2 in the deck)'],
  ten:['Wild +10', 'Turns up on 1 in 100 cards dealt or drawn'],
  shuffle:['Shuffle Hands', "A wild that mixes and redeals everyone's cards"],
  jump:['Jump-in', 'Slam down the exact same card as the top card, any time'],
  timer:['15-second turns', 'Run out of time and you draw'],
  mercy:['Mercy rule', 'Hit 20 cards and you are out of the round']
};
function renderMenu(p, ms){
  const playing = !!(p && p.ph === 'play');
  setHTML($('#ruleList'), 'rules', RULES.map(r => {
    const on = p ? p.rules[r] : true, info = RULE_INFO[r];
    return '<label for="rule-' + r + '"><span>' + info[0] + '<small>' + info[1] + '</small></span><span class="switch"><input type="checkbox" id="rule-' + r +
      '" data-rule="' + r + '"' + (on ? ' checked' : '') + (!ms || playing ? ' disabled' : '') + '><span></span></span></label>';
  }).join(''));
  $('#ruleNote').textContent = playing ? 'House rules can change between rounds.' : ms ? 'Anyone at the table can change these before a round.' : 'Sit down to change house rules.';
  $('#mBot').hidden = !(ms && p && !playing && p.seats.length < MAXP);
  $('#mFace').hidden = !ms;
  $('#mLeave').hidden = !(ms || (p && p.q.some(x => x.k === S.pid)));
  $('#mReset').hidden = !(everyoneAway(p) && !ms);
  let st = '';
  if (S.mode === 'practice') st = 'Practice table on this device';
  else if (S.mode === 'live') st = (S.connected ? 'Live · ' + Math.max(1, S.online.size) + ' here' : 'Connecting') + ' · Table ' + CODE;
  $('#statusLine').textContent = st;
}

/* ---------- input ---------- */
function onHandTap(btn, c){
  const p = S.G ? view(S.G) : null, ms = mySeat(p);
  if (!ms || p.ph !== 'play') return;
  if (Date.now() < (S.tapLock || 0)) return; // one card per tap: ignore fast double taps
  S.tapLock = Date.now() + 650;
  const cur = p.seats[p.turn];
  const myTurn = !!cur && cur.k === S.pid;
  if (!myTurn && jumpable(p, ms, c, false)){ act('play', {c:c}); return; }
  if (!myTurn){ toast('Wait for your turn.'); return; }
  if (S.busy) return;
  if (!(canPlay(c, ctxPub(p)) && (!p.dr || c === p.dn))){
    btn.classList.remove('nope'); void btn.offsetWidth; btn.classList.add('nope');
    toast(p.pend ? 'Stack a ' + (p.pt === 'F' ? '+4' : '+2 or +4') + ', or tap the deck to draw ' + p.pend + '.' :
      p.dr ? 'You can only play the card you just drew.' : "That card doesn't match.");
    return;
  }
  if (isWild(c)){ S.pickCard = c; $('#picker').hidden = false; return; }
  if (c[1] === 'M' && ms.h.length > 2){ openTargets(p, c); return; }
  act('play', {c:c});
}
function openTargets(p, c){
  const others = p.seats.filter(s => s.k !== S.pid && !s.o);
  setHTML($('#targetList'), 'targets', others.map(s => '<button type="button" data-target="' + esc(s.k) + '">' +
    '<span class="tgt">' + avHTML(s) + '<span>' + esc(s.n) + '</span></span><small>' + (s.h.length / 2) + (s.h.length === 2 ? ' card' : ' cards') + '</small></button>').join(''));
  $('#targetSheet').dataset.c = c;
  $('#targetSheet').hidden = false;
}
const REACTS = ['😂','🔥','😤','👏','😱','💀','🤡','🫡'];
let lastReact = 0;
function sendReaction(k, e){
  if (Date.now() - lastReact < 700) return;
  lastReact = Date.now();
  showReaction(k, e);
  if (ch) ch.send({type:'broadcast', event:'react', payload:{f:S.pid, t:k, e:e}}).catch(() => {});
}
function showReaction(k, e){
  const face = REACTS[e];
  if (!face) return;
  const target = k === S.pid ? $('#meRow .av') : document.querySelector('.seat[data-seat="' + (window.CSS && CSS.escape ? CSS.escape(k) : k) + '"] .av');
  if (!target) return;
  const r = target.getBoundingClientRect();
  const el = document.createElement('span');
  el.className = 'react';
  el.textContent = face;
  el.style.left = (r.left + r.width / 2) + 'px';
  el.style.top = (r.top + r.height / 2) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}
function onSeatTap(k){
  const p = S.G ? view(S.G) : null, ms = mySeat(p);
  if (!p) return;
  const s = p.seats.find(x => x.k === k);
  if (!s) return;
  const n = s.h.length / 2;
  if (p.ph === 'play' && ms && n === 1 && !s.c && !s.o){ act('catch', {x:k}); return; }
  const away = !s.b && !isPresent(s.k);
  const cur = p.seats[p.turn];
  let acts = '';
  if (ms && away && p.ph === 'play' && cur && cur.k === k) acts += '<button type="button" data-sa="skip">Skip their turn</button>';
  if (ms && (s.b || away)) acts += '<button type="button" class="danger" data-sa="kick">Remove from the table</button>';
  $('#seatTitle').textContent = s.n;
  $('#seatSub').textContent = (s.b ? 'Bot · ' : away ? 'Away · ' : '') + s.w + (s.w === 1 ? ' win' : ' wins') +
    (p.ph === 'lobby' ? '' : ' · ' + n + (n === 1 ? ' card' : ' cards'));
  $('#seatActions').innerHTML = acts;
  $('#seatActions').hidden = !acts;
  setHTML($('#reactRow'), 'reacts', REACTS.map((f, i) => '<button type="button" data-react="' + i + '" aria-label="Send ' + f + '">' + f + '</button>').join(''));
  $('#seatSheet').dataset.k = k;
  $('#seatSheet').hidden = false;
}
function joinSubmit(e){
  if (e) e.preventDefault();
  const nm = cleanName($('#nameInput').value);
  if (!nm){ $('#nameInput').focus(); toast('Add your name first.'); return; }
  S.name = nm; LS.set('lastcard.name', nm); LS.set('lastcard.av', String(S.av));
  if (ch) ch.track({name:nm}).catch(() => {});
  $('#nameInput').blur();
  act('join', {av:S.av});
}
async function share(){
  const url = shareUrl();
  try {
    if (navigator.share){ await navigator.share({title:'Last Card', text:'Pull up a chair for Last Card', url:url}); return; }
  } catch (e){ if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch (e){ toast(url); }
}
const SHEETS = ['menu', 'seatSheet', 'faceSheet', 'picker', 'help', 'targetSheet'];
function closeSheets(){ SHEETS.forEach(id => { $('#' + id).hidden = true; }); S.pickCard = null; }
function openFace(){
  const p = S.G ? view(S.G) : null, ms = mySeat(p);
  renderAvPick($('#facePick'), ms ? avIndex(ms.av, ms.k) : S.av);
  $('#faceSheet').hidden = false;
}
function wire(){
  const ni = $('#nameInput');
  ni.value = S.name;
  ni.addEventListener('input', () => render());
  $('#joinForm').addEventListener('submit', joinSubmit);
  $('#menuBtn').addEventListener('click', () => { render(); $('#menu').hidden = false; });
  $('#menuClose').addEventListener('click', closeSheets);
  $('#inviteBtn').addEventListener('click', share);
  $('#mInvite').addEventListener('click', () => { closeSheets(); share(); });
  $('#mRules').addEventListener('click', () => { closeSheets(); $('#help').hidden = false; });
  $('#mBot').addEventListener('click', () => { closeSheets(); act('bot'); });
  $('#mFace').addEventListener('click', () => { closeSheets(); openFace(); });
  $('#mLeave').addEventListener('click', () => { closeSheets(); act('leave'); });
  $('#mReset').addEventListener('click', () => { closeSheets(); act('reset'); });
  $('#mNew').addEventListener('click', () => { location.href = location.pathname + '?t=' + randId(6); });
  $('#ruleList').addEventListener('change', e => { const r = e.target.dataset && e.target.dataset.rule; if (r) act('rule', {r:r, v:e.target.checked}); });
  $('#targetClose').addEventListener('click', closeSheets);
  $('#helpClose').addEventListener('click', closeSheets);
  $('#seatClose').addEventListener('click', closeSheets);
  $('#faceClose').addEventListener('click', closeSheets);
  $('#pickCancel').addEventListener('click', closeSheets);
  $('#deckBtn').addEventListener('click', () => act('draw'));
  $('#nextBtn').addEventListener('click', () => { $('#over').hidden = true; });
  document.querySelectorAll('[data-col]').forEach(b => b.addEventListener('click', () => {
    const c = S.pickCard; closeSheets();
    if (c) act('play', {c:c, col:b.dataset.col});
  }));
  $('#over').addEventListener('click', e => { if (e.target.id === 'over') $('#over').hidden = true; });
  SHEETS.forEach(id => $('#' + id).addEventListener('click', e => {
    if (e.target.id === id) closeSheets();
  }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.av !== undefined){
      const v = +b.dataset.av;
      S.av = v; LS.set('lastcard.av', String(v));
      if (b.closest('#facePick')){
        renderAvPick($('#facePick'), v);
        const ms = mySeat(S.G ? view(S.G) : null);
        if (ms) act('join', {av:v});
      } else render();
      return;
    }
    if (b.dataset.target !== undefined){
      const c = $('#targetSheet').dataset.c;
      closeSheets();
      return act('play', {c:c, x:b.dataset.target});
    }
    if (b.dataset.react !== undefined){
      const k = $('#seatSheet').dataset.k;
      closeSheets();
      return sendReaction(k, +b.dataset.react);
    }
    if (b.dataset.sa){
      const k = $('#seatSheet').dataset.k;
      closeSheets();
      return act(b.dataset.sa, {x:k});
    }
    if (b.dataset.seat !== undefined) return onSeatTap(b.dataset.seat);
    if (b.id === 'meAv') return openFace();
    if (b.dataset.act){
      const t = b.dataset.act;
      if (t === 'pass' && S.busy) return;
      if (t === 'ready') return act('ready', {v:b.dataset.v === '1'});
      return act(t);
    }
    if (b.dataset.c && b.closest('#hand')) return onHandTap(b, b.dataset.c);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    requestWake();
    if (S.mode === 'live') refresh();
  });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { memo.seats = null; memo.hand = null; render(); }, 120); });
}

/* ---------- startup ---------- */
$('#fan').innerHTML = ['r7', 'wW', 'b4'].map(c => cardHTML(c)).join('');
wire();
render();
if (CONFIGURED && window.supabase && typeof window.supabase.createClient === 'function'){
  try { connect(); } catch (e){ console.error(e); startPractice(); }
} else {
  startPractice();
}
})();
