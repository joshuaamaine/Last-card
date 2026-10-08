/* Last Card client. Every player's browser keeps a copy of the table, applies moves with
   the rules in engine.js, and saves through Supabase (lc_save checks the version so two
   saves can't clobber each other). Realtime pushes each save to everyone at the table. */
(function () {
'use strict';

const E = window.LCEngine;
const {MAXP, COLS, CNAME, CARD_RE, rint, isWild, cardName, canPlay, newTable, newSeat,
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
function hue(k){ let h = 7; for (const ch of String(k)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
function initial(n){ const a = Array.from(String(n || '?').trim()); return (a[0] || '?').toUpperCase(); }
function decode(h){ return (typeof h === 'string' ? (h.match(/../g) || []) : []).filter(c => CARD_RE.test(c)); }
const CO = {r:0, y:1, g:2, b:3, w:4};
const VO = '0123456789SRDWF';
function sortHand(h){ return h.slice().sort((a, b) => CO[a[0]] - CO[b[0]] || VO.indexOf(a[1]) - VO.indexOf(b[1])); }
function clone(o){ return JSON.parse(JSON.stringify(o)); }
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

const ICON = {
  S:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M6.6 17.4 17.4 6.6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  R:'<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h15l-3.6-3.6"/><path d="M20 15.5H5l3.6 3.6"/></svg>'
};
function suitHTML(c){ return '<i class="suit s-' + c + '"></i>'; }
function cardHTML(c, cls, style){
  let inner;
  if (c === 'wW'){
    inner = '<span class="corner tl">W</span><span class="wheel">' + COLS.map(suitHTML).join('') + '</span><span class="corner br">W</span>';
  } else if (c === 'wF'){
    inner = '<span class="corner tl">+4</span><span class="wf"><span class="face plus">+4</span><span class="wheel row">' + COLS.map(suitHTML).join('') + '</span></span><span class="corner br">+4</span>';
  } else {
    const v = c[1];
    const g = ICON[v] || (v === 'D' ? '+2' : v);
    const corner = g + suitHTML(c[0]);
    const fcls = 'face' + (v === 'D' ? ' plus' : '') + (v === '6' || v === '9' ? ' ul' : '');
    inner = '<span class="corner tl">' + corner + '</span><span class="' + fcls + '">' + g + '</span><span class="corner br">' + corner + '</span>';
  }
  return '<span class="card ' + (isWild(c) ? 'wild' : 'c-' + c[0]) + (cls ? ' ' + cls : '') + '" role="img" aria-label="' + esc(cardName(c)) + '"' + (style ? ' style="' + style + '"' : '') + '>' + inner + '</span>';
}

/* ---------- state ---------- */
const CODE = cleanCode(new URLSearchParams(location.search).get('t')) || 'main';
function getPid(){
  let p = LS.get('lastcard.pid');
  if (!p || !/^p[a-z0-9]{8,24}$/.test(p)){ p = 'p' + randId(10); LS.set('lastcard.pid', p); }
  return p;
}
const S = {
  mode:'connecting', G:null, version:0, pid:getPid(), name:cleanName(LS.get('lastcard.name') || ''),
  online:new Map(), synced:false, connected:false, saving:false, busy:false, loadErr:false, lastFetch:0,
  pickCard:null, lastLpn:null, landUntil:0, lastHandStr:null, lastRd:null, handCards:[], freshMask:[], freshUntil:0,
  wasMyTurn:false
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
    seats:G.seats.map(s => ({k:s.k, n:s.n, h:(s.hand || []).join(''), c:!!s.called, s:s.score || 0, w:s.wins || 0, b:!!s.bot})),
    q:G.q.map(x => ({k:x.k, n:x.n})),
    pile:G.disc.slice(-3), pc:G.disc.length, col:COLS.indexOf(G.col) >= 0 ? G.col : 'r', dir:G.dir === -1 ? -1 : 1,
    turn:G.turn, pend:G.pend || 0, pt:G.pt, dr:!!G.drew, dn:G.dn, dk:G.deck.length,
    log:G.log.slice(-4), win:G.win, champ:G.champ, rules:{stack:!!G.rules.stack, goal:+G.rules.goal || 0},
    lpn:G.lpn || 0, lpk:G.lpk || null
  };
}
function mySeat(p){ return p ? p.seats.find(s => s.k === S.pid) || null : null; }
function ctxPub(p){ const pile = p.pile || []; return {top:pile[pile.length - 1] || 'r0', color:p.col, pend:p.pend, pt:p.pt, stack:p.rules.stack}; }
function shareUrl(){ return location.origin + location.pathname + (CODE === 'main' ? '' : '?t=' + CODE); }

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
let botT = null, catchT = null, catchKey = null;
function driverRank(){
  if (S.mode !== 'live') return 0;
  const ids = Array.from(S.online.keys()).filter(id => /^p[a-z0-9]+$/.test(id)).sort();
  const i = ids.indexOf(S.pid);
  return i < 0 ? ids.length : i;
}
function schedule(){
  clearTimeout(botT);
  const G = S.G;
  if (!G || G.ph !== 'play'){ clearTimeout(catchT); catchKey = null; return; }
  const rank = driverRank();
  const cur = G.seats[G.turn];
  if (cur && cur.bot){
    const v = S.version;
    const delay = rank === 0 ? 850 + rint(650) : 5000 + rank * 1500 + rint(1500);
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
  G.seats.push(newSeat(S.pid, S.name || 'Player', false));
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
function render(){ try { renderInner(); } catch (e){ console.error(e); } }
function renderInner(){
  const p = S.G ? view(S.G) : null;
  const inGame = !!(p && (p.ph === 'play' || p.ph === 'over'));
  $('#app').classList.toggle('in-lobby', !inGame);
  $('#lobby').hidden = inGame;
  $('#game').hidden = !inGame;
  renderHeader(p);
  if (inGame) renderGame(p); else renderLobby(p);
  renderOver(p);
  const cur = p && p.ph === 'play' ? p.seats[p.turn] : null;
  document.title = cur && cur.k === S.pid ? '(Your turn) Last Card' : 'Last Card';
}
function renderHeader(p){
  const rc = $('#roundChip');
  rc.hidden = !(p && p.rd && p.ph !== 'lobby');
  if (!rc.hidden) rc.textContent = 'Round ' + p.rd;
  let dot = '', txt = 'Connecting';
  if (S.mode === 'practice'){ dot = 'wait'; txt = 'Practice'; }
  else if (S.mode === 'live'){
    if (S.loadErr && !S.connected) txt = 'Offline';
    else if (!S.connected) txt = 'Connecting';
    else { dot = 'live'; txt = 'Live · ' + Math.max(1, S.online.size); }
  }
  $('#netDot').className = 'dot' + (dot ? ' ' + dot : '');
  $('#netText').textContent = txt;
}
function everyoneAway(p){
  if (S.mode !== 'live' || !S.synced || !p) return false;
  if (!p.seats.length && !p.q.length) return false;
  return !p.seats.some(s => !s.b && isPresent(s.k));
}
function renderLobby(p){
  const ms = mySeat(p);
  let note = '';
  if (S.mode === 'connecting') note = 'Connecting to the table…';
  else if (S.mode === 'practice') note = CONFIGURED ? "Can't load the game server, so this is a practice table: you against bots on this device."
    : 'Practice table: the game server is not set up yet, so it is you against bots on this device.';
  else if (S.loadErr) note = "Can't reach the table right now. Retrying…";
  else if (!p) note = 'Loading the table…';
  $('#lobbyNote').textContent = note;

  const nameNow = cleanName($('#nameInput').value);
  const sb_ = $('#seatBtn');
  sb_.disabled = !p;
  const rename = !!(ms && nameNow && nameNow !== ms.n);
  sb_.textContent = ms ? (rename ? 'Save name' : 'Leave seat') : 'Take a seat';
  sb_.classList.toggle('primary', !ms || rename);

  const seats = p ? p.seats : [];
  $('#seatCount').textContent = seats.length + ' of ' + MAXP + ' seats';
  let html;
  if (!seats.length) html = '<li class="seat empty">No one is seated yet. Take a seat, then wait for friends or add a bot.</li>';
  else html = seats.map(s => {
    const you = s.k === S.pid;
    const away = !s.b && !isPresent(s.k);
    const canRm = ms && !you && (s.b || away);
    return '<li class="seat"><span class="avatar" style="--h:' + hue(s.k) + '">' + esc(initial(s.n)) + '</span>' +
      '<span class="seat-name">' + esc(s.n) + (you ? ' <em>(you)</em>' : '') + '</span>' +
      (s.b ? '<span class="tag">Bot</span>' : '') + (away ? '<span class="tag warn">Away</span>' : '') +
      (s.s ? '<span class="pts">' + s.s + ' pts</span>' : '') +
      (canRm ? '<button type="button" class="mini" data-kick="' + esc(s.k) + '">Remove</button>' : '') + '</li>';
  }).join('');
  setHTML($('#seatList'), 'seats', html);

  $('#botBtn').disabled = !(ms && seats.length < MAXP);
  $('#dealBtn').disabled = !(ms && seats.length >= 2);
  $('#dealBtn').textContent = p && p.champ ? 'Start a new match' : 'Deal cards';
  const sr = $('#stackRule'), gr = $('#goalRule');
  sr.disabled = !ms; gr.disabled = !ms;
  if (p){ sr.checked = p.rules.stack; gr.value = String(p.rules.goal); }
  const seated = new Set(seats.map(s => s.k));
  const watching = S.mode === 'live' ? Array.from(S.online.keys()).filter(k => !seated.has(k)).length : 0;
  $('#watchNote').textContent = !p ? '' :
    (seats.length < 2 ? 'You need at least two players. Bots count. ' : '') +
    (watching ? watching + (watching === 1 ? ' person is' : ' people are') + ' here without a seat.' : '');
  $('#resetBtn').hidden = !(everyoneAway(p) && !ms);

  $('#shareUrl').textContent = shareUrl();
  $('#tableCode').textContent = CODE;
}
function oppHTML(s, p, ms){
  const n = s.h.length / 2;
  const cur = p.seats[p.turn];
  const isTurn = p.ph === 'play' && cur && cur.k === s.k;
  const away = !s.b && !isPresent(s.k);
  let btns = '';
  if (p.ph === 'play' && ms && n === 1 && !s.c) btns += '<button type="button" class="mini hot" data-catch="' + esc(s.k) + '">Catch!</button>';
  if (p.ph === 'play' && ms && away && isTurn) btns += '<button type="button" class="mini" data-skip="' + esc(s.k) + '">Skip turn</button>';
  if (ms && away) btns += '<button type="button" class="mini" data-kick="' + esc(s.k) + '">Remove</button>';
  const backs = new Array(Math.min(n, 10)).fill('<i></i>').join('');
  return '<div class="opp' + (isTurn ? ' turn' : '') + (away ? ' away' : '') + '">' +
    '<div class="opp-head"><span class="avatar sm" style="--h:' + hue(s.k) + '">' + esc(initial(s.n)) + '</span>' +
    '<span class="opp-name">' + esc(s.n) + '</span><span class="opp-n" aria-label="' + n + ' cards">' + n + '</span></div>' +
    '<div class="backs" aria-hidden="true">' + backs + '</div>' +
    '<div class="opp-foot">' + (n === 1 && s.c ? '<span class="tag hot">Last card</span>' : '') +
    (away ? '<span class="tag warn">Away</span>' : '') + (s.b ? '<span class="tag">Bot</span>' : '') + btns + '</div></div>';
}
function renderGame(p){
  const ms = mySeat(p);
  const L = p.seats.length;
  const myIdx = p.seats.findIndex(s => s.k === S.pid);
  const cur = p.seats[p.turn];
  const myTurn = p.ph === 'play' && !!cur && cur.k === S.pid;

  if (myTurn && !S.wasMyTurn){ try { if (navigator.vibrate) navigator.vibrate(35); } catch (e){} }
  S.wasMyTurn = myTurn;

  const order = myIdx >= 0 ? p.seats.map((_, i) => p.seats[(myIdx + 1 + i) % L]).slice(0, -1) : p.seats;
  setHTML($('#opps'), 'opps', order.map(s => oppHTML(s, p, ms)).join(''));

  const deck = $('#deckBtn');
  deck.disabled = !(myTurn && !p.dr) || S.busy;
  deck.classList.toggle('ready', myTurn && !p.dr);
  deck.setAttribute('aria-label', p.pend && myTurn ? 'Draw ' + p.pend + ' cards' : 'Draw a card');
  $('#deckN').textContent = p.dk;

  if (S.lastLpn !== null && S.lastLpn !== p.lpn) S.landUntil = Date.now() + 450;
  S.lastLpn = p.lpn;
  const landing = Date.now() < S.landUntil;
  const pile = p.pile || [];
  const from = p.lpk && p.lpk === S.pid ? '90px' : '-80px';
  const pileHTML = '<span class="ring" style="--cur:var(--c-' + p.col + ')"></span>' + pile.map((c, i) => {
    const idx = p.pc - pile.length + i;
    const rot = ((idx * 47) % 19) - 9;
    const top = i === pile.length - 1;
    return cardHTML(c, top && landing ? 'land' : '', '--rot:' + rot + 'deg;--from:' + from);
  }).join('');
  setHTML($('#discard'), 'discard', pileHTML);

  let st = '';
  if (p.ph === 'over') st += '<span class="turn-pill">Round over</span>';
  else if (myTurn) st += '<span class="turn-pill mine">' + (p.pend ? 'Your turn: +' + p.pend + ' on you' : 'Your turn') + '</span>';
  else st += '<span class="turn-pill">' + esc(cur ? cur.n : '') + "'s turn" + (p.pend ? ' (+' + p.pend + ')' : '') + '</span>';
  st += '<span class="chip"><i class="suit s-' + p.col + '" style="color:var(--c-' + p.col + ')"></i>' + CNAME[p.col] + '</span>';
  if (p.ph === 'play' && L > 1){
    const nx = p.seats[(((p.turn + p.dir) % L) + L) % L];
    st += '<span class="chip">' + (p.dir === 1 ? '↻' : '↺') + ' Next: ' + esc(nx.k === S.pid ? 'you' : nx.n) + '</span>';
  }
  setHTML($('#status'), 'status', st);

  setHTML($('#log'), 'log', p.log.slice(-3).map(m => '<p>' + esc(m) + '</p>').join(''));

  let ah = '';
  if (p.ph === 'play'){
    if (!ms){
      const queued = p.q.some(x => x.k === S.pid);
      if (everyoneAway(p)){
        ah += '<span class="hint">Everyone at this table has left.</span><button type="button" class="btn primary" data-act="reset">Clear the table</button>';
      } else {
        ah += '<span class="hint">You are watching this round.</span>';
        ah += queued ? '<span class="tag">Joining next round</span>' : '<button type="button" class="btn" data-act="join">Join next round</button>';
      }
    } else {
      const n = ms.h.length / 2;
      const dis = S.busy ? ' disabled' : '';
      if (myTurn){
        if (p.pend) ah += '<button type="button" class="btn primary" data-act="draw"' + dis + '>Draw ' + p.pend + '</button>';
        else if (p.dr) ah += '<button type="button" class="btn" data-act="pass"' + dis + '>Keep it and pass</button>';
        else ah += '<button type="button" class="btn" data-act="draw"' + dis + '>Draw a card</button>';
      } else {
        ah += '<span class="hint">Waiting for ' + esc(cur ? cur.n : 'the next player') + '…</span>';
      }
      const canCall = !ms.c && (n === 1 || (n === 2 && myTurn));
      if (canCall) ah += '<button type="button" class="btn call' + (n === 1 ? ' urgent' : '') + '" data-act="call">Last card!</button>';
      else if (ms.c && n <= 2) ah += '<span class="tag hot">Called</span>';
    }
  }
  setHTML($('#actions'), 'actions', ah);

  const handStr = ms ? ms.h : '';
  if (handStr !== S.lastHandStr || p.rd !== S.lastRd){
    const mine = sortHand(decode(handStr));
    let mask = mine.map(() => false);
    if (S.lastHandStr !== null){
      if (p.rd !== S.lastRd) mask = mine.map(() => true);
      else {
        const m = {};
        decode(S.lastHandStr).forEach(c => { m[c] = (m[c] || 0) + 1; });
        mine.forEach((c, i) => { if (m[c]) m[c]--; else mask[i] = true; });
      }
    }
    S.handCards = mine; S.freshMask = mask;
    S.freshUntil = Date.now() + 700 + mine.length * 50;
    S.lastHandStr = handStr; S.lastRd = p.rd;
  }
  const fresh = Date.now() < S.freshUntil;
  let hh;
  if (!ms) hh = '<p class="hand-empty">Take a seat next round to get a hand.</p>';
  else if (!S.handCards.length) hh = '<p class="hand-empty">No cards left.</p>';
  else {
    const ctx = ctxPub(p);
    let k = 0;
    hh = S.handCards.map((c, i) => {
      const ok = myTurn && canPlay(c, ctx) && (!p.dr || c === p.dn);
      const isNew = fresh && S.freshMask[i];
      const d = isNew ? ' style="--d:' + (k++ * 45) + 'ms"' : '';
      return '<button type="button" class="card-btn' + (ok ? ' ok' : '') + (myTurn && !ok ? ' dim' : '') + (isNew ? ' dealt' : '') +
        '" data-c="' + c + '"' + d + ' aria-label="' + esc(cardName(c)) + (ok ? ', playable' : '') + '">' + cardHTML(c) + '</button>';
    }).join('');
  }
  setHTML($('#hand'), 'hand', hh);
}
function renderOver(p){
  const show = !!(p && p.ph === 'over');
  $('#over').hidden = !show;
  if (!show) return;
  const ms = mySeat(p);
  const w = p.win ? p.seats.find(s => s.k === p.win.k) : null;
  const champ = p.champ ? p.seats.find(s => s.k === p.champ) : null;
  $('#overEyebrow').textContent = 'Round ' + p.rd + (p.rules.goal ? ' · first to ' + p.rules.goal : '');
  $('#overTitle').textContent = champ ? (champ.k === S.pid ? 'You win the match!' : champ.n + ' wins the match!')
    : w ? (w.k === S.pid ? 'You win the round!' : w.n + ' wins the round') : 'Round over';
  $('#overSub').textContent = w ? (w.k === S.pid ? 'You score ' : w.n + ' scores ') + p.win.p + " points from the cards left in everyone else's hands." : 'The round ended early.';
  const rows = p.seats.slice().sort((a, b) => b.s - a.s);
  const html = '<thead><tr><th>Player</th><th class="num">Cards left</th><th class="num">Rounds</th><th class="num">Points</th></tr></thead><tbody>' +
    rows.map(s => '<tr' + (p.win && s.k === p.win.k ? ' class="win"' : '') + '><td>' + esc(s.n) + (s.k === S.pid ? ' (you)' : '') + '</td><td class="num">' +
      (s.h.length / 2) + '</td><td class="num">' + s.w + '</td><td class="num">' + s.s + '</td></tr>').join('') + '</tbody>';
  setHTML($('#scores'), 'scores', html);
  const nb = $('#nextBtn');
  nb.textContent = champ ? 'Start a new match' : 'Deal next round';
  nb.disabled = !ms || p.seats.length < 2;
  $('#lobbyBtn').disabled = !ms;
}

/* ---------- input ---------- */
function onHandTap(btn, c){
  const p = S.G ? view(S.G) : null, ms = mySeat(p);
  if (!ms || p.ph !== 'play') return;
  const cur = p.seats[p.turn];
  if (!cur || cur.k !== S.pid){ toast('Wait for your turn.'); return; }
  if (S.busy) return;
  if (!(canPlay(c, ctxPub(p)) && (!p.dr || c === p.dn))){
    btn.classList.remove('nope'); void btn.offsetWidth; btn.classList.add('nope');
    toast(p.pend ? 'Stack a ' + (p.pt === 'F' ? '+4' : '+2 or +4') + ', or draw ' + p.pend + '.' :
      p.dr ? 'You can only play the card you just drew.' : 'That card does not match ' + CNAME[p.col] + ' or the top card.');
    return;
  }
  if (isWild(c)){ S.pickCard = c; $('#picker').hidden = false; return; }
  act('play', {c:c});
}
function seatToggle(){
  const p = S.G ? view(S.G) : null;
  if (!p) return;
  const ms = mySeat(p);
  const nm = cleanName($('#nameInput').value);
  if (ms && !(nm && nm !== ms.n)){ act('leave'); return; }
  if (!nm){ $('#nameInput').focus(); toast('Add your name first.'); return; }
  S.name = nm; LS.set('lastcard.name', nm);
  if (ch) ch.track({name:nm}).catch(() => {});
  act('join');
}
async function share(){
  const url = shareUrl();
  try {
    if (navigator.share){ await navigator.share({title:'Last Card', text:'Pull up a chair for Last Card', url:url}); return; }
  } catch (e){ if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch (e){
    const r = document.createRange(); r.selectNodeContents($('#shareUrl'));
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    toast('Copy the link above');
  }
}
let nameT = null;
function wire(){
  const ni = $('#nameInput');
  ni.value = S.name;
  ni.addEventListener('input', () => {
    S.name = cleanName(ni.value);
    LS.set('lastcard.name', S.name);
    clearTimeout(nameT);
    nameT = setTimeout(() => { if (ch) ch.track({name:S.name}).catch(() => {}); }, 600);
    render();
  });
  ni.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); seatToggle(); } });
  $('#seatBtn').addEventListener('click', seatToggle);
  $('#botBtn').addEventListener('click', () => act('bot'));
  $('#dealBtn').addEventListener('click', () => act('start'));
  $('#resetBtn').addEventListener('click', () => act('reset'));
  $('#stackRule').addEventListener('change', e => act('rule', {r:'stack', v:e.target.checked}));
  $('#goalRule').addEventListener('change', e => act('rule', {r:'goal', v:+e.target.value}));
  $('#deckBtn').addEventListener('click', () => act('draw'));
  $('#nextBtn').addEventListener('click', () => act('start'));
  $('#lobbyBtn').addEventListener('click', () => act('lobby'));
  $('#shareBtn').addEventListener('click', share);
  $('#newTableBtn').addEventListener('click', () => { location.href = location.pathname + '?t=' + randId(6); });
  $('#helpBtn').addEventListener('click', () => { $('#help').hidden = false; });
  $('#helpClose').addEventListener('click', () => { $('#help').hidden = true; });
  $('#pickCancel').addEventListener('click', () => { $('#picker').hidden = true; S.pickCard = null; });
  document.querySelectorAll('[data-col]').forEach(b => b.addEventListener('click', () => {
    const c = S.pickCard; $('#picker').hidden = true; S.pickCard = null;
    if (c) act('play', {c:c, col:b.dataset.col});
  }));
  ['help', 'picker'].forEach(id => $('#' + id).addEventListener('click', e => {
    if (e.target.id === id){ e.currentTarget.hidden = true; S.pickCard = null; }
  }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape'){ $('#help').hidden = true; $('#picker').hidden = true; S.pickCard = null; }
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.kick !== undefined) return act('kick', {x:b.dataset.kick});
    if (b.dataset.catch !== undefined) return act('catch', {x:b.dataset.catch});
    if (b.dataset.skip !== undefined) return act('skip', {x:b.dataset.skip});
    if (b.dataset.act){
      const t = b.dataset.act;
      if ((t === 'draw' || t === 'pass') && S.busy) return;
      return act(t);
    }
    if (b.dataset.c && b.closest('#hand')) return onHandTap(b, b.dataset.c);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    requestWake();
    if (S.mode === 'live') refresh();
  });
}

/* ---------- startup ---------- */
$('#fan').innerHTML = ['r7', 'wF', 'bR'].map(c => cardHTML(c)).join('');
wire();
render();
if (CONFIGURED && window.supabase && typeof window.supabase.createClient === 'function'){
  try { connect(); } catch (e){ console.error(e); startPractice(); }
} else {
  startPractice();
}
})();
