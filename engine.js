/* Last Card game rules. Pure functions over a plain JSON table state,
   shared by every player's browser (app.js) and by tools/check.js. */
(function (root) {
'use strict';

const MAXP = 8;
const COLS = ['r','y','g','b'];
const CNAME = {r:'Red', y:'Yellow', g:'Green', b:'Blue'};
const CARD_RE = /^(?:[rygb][0-9SRD]|w[WF])$/;
const BOT_NAMES = ['Pixel','Clank','Nova','Dot','Gizmo','Bolt','Echo','Juno'];
const AV_COUNT = 16; /* avatars are picked by number; the page maps numbers to pictures */

function rint(n){
  if (typeof crypto !== 'undefined' && crypto.getRandomValues){ const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
  return Math.floor(Math.random() * n);
}
function shuffle(a){ for (let i = a.length - 1; i > 0; i--){ const j = rint(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function newDeck(){
  const d = [];
  for (const c of COLS){ d.push(c + '0'); for (const v of '123456789SRD'){ d.push(c + v, c + v); } }
  for (let i = 0; i < 4; i++) d.push('wW', 'wF');
  return shuffle(d);
}
function isWild(c){ return c[0] === 'w'; }
function pts(c){ if (isWild(c)) return 50; return 'SRD'.indexOf(c[1]) >= 0 ? 20 : +c[1]; }
function cardName(c){
  if (c === 'wW') return 'Wild';
  if (c === 'wF') return 'Wild +4';
  return CNAME[c[0]] + ' ' + ({S:'Skip', R:'Reverse', D:'+2'}[c[1]] || c[1]);
}
function canPlay(card, ctx){
  if (ctx.pend > 0){
    if (!ctx.stack) return false;
    return card === 'wF' || (card[1] === 'D' && !isWild(card) && ctx.pt === 'D');
  }
  if (isWild(card)) return true;
  return card[0] === ctx.color || card[1] === ctx.top[1];
}
function newTable(){
  return {v:0, ph:'lobby', rd:0, seats:[], q:[], deck:[], disc:[], turn:0, dir:1, col:'r', pend:0, pt:null,
    drew:false, dn:null, rules:{stack:false, goal:0}, log:[], win:null, champ:null, lpk:null, lpn:0, bots:0};
}
function validAv(v){ v = Number(v); return Number.isInteger(v) && v >= 0 && v < AV_COUNT ? v : null; }
function newSeat(k, n, bot, av){
  const a = validAv(av);
  return {k:k, n:n, bot:!!bot, av:a === null ? rint(AV_COUNT) : a, hand:[], called:false, score:0, wins:0, rdy:false};
}
function seatOf(G, k){ for (let i = 0; i < G.seats.length; i++) if (G.seats[i].k === k) return i; return -1; }
function addLog(G, m){ G.log.push(m); if (G.log.length > 6) G.log.splice(0, G.log.length - 6); }
function uniqueName(G, k, name){
  let n = name, i = 2;
  const taken = s => G.seats.some(x => x.k !== k && x.n === s) || G.q.some(x => x.k !== k && x.n === s);
  while (taken(n)){ n = name.slice(0, 13) + ' ' + i; i++; }
  return n;
}
function drawTo(G, s, n){
  let got = 0;
  for (let i = 0; i < n; i++){
    if (!G.deck.length){
      if (G.disc.length <= 1) break;
      const top = G.disc.pop();
      G.deck = shuffle(G.disc);
      G.disc = [top];
    }
    s.hand.push(G.deck.pop());
    got++;
  }
  if (got) s.called = false;
  return got;
}
function nextIdx(G, n){ const L = G.seats.length; return (((G.turn + G.dir * n) % L) + L) % L; }
function ctxOf(G){ return {top:G.disc[G.disc.length - 1], color:G.col, pend:G.pend, pt:G.pt, stack:G.rules.stack}; }

function startRound(G){
  if (G.ph === 'play') return false;
  for (const x of G.q){ if (seatOf(G, x.k) < 0 && G.seats.length < MAXP) G.seats.push(newSeat(x.k, x.n, false, x.av)); }
  G.q = [];
  if (G.seats.length < 2) return false;
  G.deck = newDeck(); G.disc = [];
  for (const s of G.seats){ s.hand = []; s.called = false; s.rdy = false; }
  for (let r = 0; r < 7; r++) for (const s of G.seats) s.hand.push(G.deck.pop());
  let i = G.deck.length - 1;
  while (i >= 0 && !/[0-9]/.test(G.deck[i][1])) i--;
  const first = G.deck.splice(i, 1)[0];
  G.disc = [first]; G.col = first[0];
  G.rd++; G.dir = 1; G.turn = (G.rd - 1) % G.seats.length;
  G.pend = 0; G.pt = null; G.drew = false; G.dn = null; G.win = null; G.ph = 'play';
  G.lpk = null; G.lpn++; G.again = false;
  addLog(G, 'Round ' + G.rd + ' dealt. First turn: ' + G.seats[G.turn].n + '.');
  return true;
}
function endRound(G, wi){
  const w = G.seats[wi];
  let p = 0;
  for (const s of G.seats) if (s !== w) for (const c of s.hand) p += pts(c);
  w.score += p; w.wins++;
  G.win = {k:w.k, n:w.n, av:w.av, b:!!w.bot, w:w.wins, p:p, rd:G.rd};
  addLog(G, w.n + ' wins round ' + G.rd + '!');
  // Back to the lobby: bots leave, anyone waiting sits down, and everyone readies up again.
  G.ph = 'lobby'; G.pend = 0; G.pt = null; G.drew = false; G.dn = null;
  G.seats = G.seats.filter(s => !s.bot);
  for (const x of G.q){ if (seatOf(G, x.k) < 0 && G.seats.length < MAXP) G.seats.push(newSeat(x.k, x.n, false, x.av)); }
  G.q = [];
  for (const s of G.seats){ s.hand = []; s.called = false; s.rdy = false; }
  G.deck = []; G.disc = [];
}
/* Start the round once every player at the table is ready (bots always are).
   Players who aren't here anymore lose their seat so they can't stall the game. */
function maybeStart(G, present){
  if (G.ph !== 'lobby') return false;
  const here = G.seats.filter(s => !s.bot && present(s.k));
  if (!here.length || here.some(s => !s.rdy)) return false;
  if (here.length + G.seats.filter(s => s.bot).length < 2) return false;
  G.seats = G.seats.filter(s => s.bot || present(s.k));
  return startRound(G);
}
function doReady(G, k, v, present){
  if (G.ph !== 'lobby') return false;
  const si = seatOf(G, k);
  if (si < 0) return false;
  const s = G.seats[si];
  if (s.rdy === !!v) return false;
  s.rdy = !!v;
  maybeStart(G, present);
  return true;
}
/* A lobby with no people left in it should not keep bots around. */
function tidy(G){
  if (G.ph !== 'play' && !G.seats.some(s => !s.bot)){ G.seats = []; G.q = G.q || []; }
  if (G.ph === 'play' && !G.seats.some(s => !s.bot)){
    G.ph = 'lobby'; G.seats = []; G.deck = []; G.disc = []; G.pend = 0; G.pt = null; G.drew = false; G.dn = null;
    addLog(G, 'Everyone left. The table is open.');
  }
}
function doPlay(G, k, card, col){
  if (G.ph !== 'play') return false;
  const si = seatOf(G, k);
  if (si < 0 || si !== G.turn) return false;
  if (!CARD_RE.test(card)) return false;
  const s = G.seats[si];
  const hi = s.hand.indexOf(card);
  if (hi < 0) return false;
  if (G.drew && card !== G.dn) return false;
  if (!canPlay(card, ctxOf(G))) return false;
  if (isWild(card) && COLS.indexOf(col) < 0) return false;
  s.hand.splice(hi, 1);
  G.disc.push(card);
  G.col = isWild(card) ? col : card[0];
  G.drew = false; G.dn = null; G.lpk = k; G.lpn++;
  let msg = s.n + ' played ' + cardName(card);
  if (isWild(card)) msg += ' and picked ' + CNAME[col];
  const v = card[1];
  if (v === 'S'){
    msg += '. ' + G.seats[nextIdx(G, 1)].n + ' is skipped';
    G.turn = nextIdx(G, 2);
  } else if (v === 'R'){
    if (G.seats.length === 2){ G.turn = nextIdx(G, 2); }
    else { G.dir *= -1; G.turn = nextIdx(G, 1); G.again = false; msg += '. Order reversed'; }
  } else if (v === 'D' || v === 'F'){
    const n = v === 'D' ? 2 : 4;
    if (G.rules.stack){
      G.pend += n; G.pt = (v === 'F' || G.pt === 'F') ? 'F' : 'D';
      G.turn = nextIdx(G, 1); G.again = false;
      msg += '. ' + G.seats[G.turn].n + ' faces +' + G.pend;
    } else {
      const vs = G.seats[nextIdx(G, 1)];
      drawTo(G, vs, n);
      msg += '. ' + vs.n + ' draws ' + n + ' and is skipped';
      G.turn = nextIdx(G, 2);
    }
  } else {
    G.turn = nextIdx(G, 1); G.again = false;
  }
  G.again = G.turn === si;
  if (G.again && s.hand.length) msg += '. ' + s.n + ' goes again';
  addLog(G, msg + '.');
  if (!s.hand.length) endRound(G, si);
  return true;
}
function doDraw(G, k){
  if (G.ph !== 'play') return false;
  const si = seatOf(G, k);
  if (si < 0 || si !== G.turn) return false;
  const s = G.seats[si];
  if (G.pend > 0){
    const got = drawTo(G, s, G.pend);
    G.pend = 0; G.pt = null; G.turn = nextIdx(G, 1); G.again = false;
    addLog(G, s.n + ' drew ' + got + '.');
    return true;
  }
  if (G.drew) return false;
  const got = drawTo(G, s, 1);
  if (!got){ G.turn = nextIdx(G, 1); G.again = false; addLog(G, s.n + ' passed. No cards left to draw.'); return true; }
  const c = s.hand[s.hand.length - 1];
  if (canPlay(c, ctxOf(G))){ G.drew = true; G.dn = c; addLog(G, s.n + ' drew a card.'); }
  else { G.turn = nextIdx(G, 1); G.again = false; addLog(G, s.n + ' drew a card and passed.'); }
  return true;
}
function doPass(G, k){
  if (G.ph !== 'play' || !G.drew) return false;
  const si = seatOf(G, k);
  if (si < 0 || si !== G.turn) return false;
  G.drew = false; G.dn = null; G.turn = nextIdx(G, 1); G.again = false;
  addLog(G, G.seats[si].n + ' kept the card.');
  return true;
}
function doCall(G, k){
  if (G.ph !== 'play') return false;
  const si = seatOf(G, k);
  if (si < 0) return false;
  const s = G.seats[si];
  if (s.called) return false;
  if (!(s.hand.length === 1 || (s.hand.length === 2 && si === G.turn))) return false;
  s.called = true;
  addLog(G, s.n + ': Last card!');
  return true;
}
function doCatch(G, k, x){
  if (G.ph !== 'play') return false;
  const ci = seatOf(G, k), ti = seatOf(G, x);
  if (ci < 0 || ti < 0 || ci === ti) return false;
  const t = G.seats[ti];
  if (t.hand.length !== 1 || t.called) return false;
  drawTo(G, t, 2);
  addLog(G, G.seats[ci].n + ' caught ' + t.n + '! Two cards for ' + t.n + '.');
  return true;
}
function doSkipAway(G, k, x, present){
  if (G.ph !== 'play' || seatOf(G, k) < 0) return false;
  const ti = seatOf(G, x);
  if (ti < 0 || ti !== G.turn) return false;
  const t = G.seats[ti];
  if (t.bot || present(x)) return false;
  if (G.pend > 0){ drawTo(G, t, G.pend); G.pend = 0; G.pt = null; }
  G.drew = false; G.dn = null; G.turn = nextIdx(G, 1); G.again = false;
  addLog(G, t.n + ' is away. Turn skipped.');
  return true;
}
function removeSeat(G, ti){
  const t = G.seats[ti];
  if (G.ph === 'play'){ for (const c of t.hand) G.deck.unshift(c); t.hand = []; }
  G.seats.splice(ti, 1);
  if (G.ph === 'play'){
    if (G.seats.length < 2){
      for (const s of G.seats){ for (const c of s.hand) G.deck.unshift(c); s.hand = []; }
      G.ph = 'lobby'; G.pend = 0; G.pt = null; G.drew = false; G.dn = null; G.deck = []; G.disc = [];
      for (const s of G.seats) s.rdy = false;
      addLog(G, 'Not enough players. Back to the lobby.');
    } else {
      if (ti < G.turn) G.turn--;
      else if (ti === G.turn){ G.drew = false; G.dn = null; if (G.dir === -1) G.turn--; }
      const L = G.seats.length;
      G.turn = ((G.turn % L) + L) % L;
    }
  }
}
function doLeave(G, k){
  const qi = G.q.findIndex(x => x.k === k);
  if (qi >= 0){ G.q.splice(qi, 1); return true; }
  const si = seatOf(G, k);
  if (si < 0) return false;
  const n = G.seats[si].n;
  removeSeat(G, si);
  addLog(G, n + ' left the table.');
  tidy(G);
  return true;
}
function doKick(G, k, x, present){
  if (seatOf(G, k) < 0) return false;
  const ti = seatOf(G, x);
  if (ti < 0) return false;
  const t = G.seats[ti];
  if (!t.bot && present(x)) return false;
  removeSeat(G, ti);
  addLog(G, t.n + (t.bot ? ' was removed.' : ' was removed for being away.'));
  tidy(G);
  return true;
}
function doJoin(G, k, name, present, av){
  const avv = validAv(av);
  const si = seatOf(G, k);
  if (si >= 0){
    const s = G.seats[si];
    let ch = false;
    const nn = uniqueName(G, k, name);
    if (s.n !== nn){ s.n = nn; ch = true; }
    if (avv !== null && s.av !== avv){ s.av = avv; ch = true; }
    return ch;
  }
  // Same name as a seat whose player isn't here (new phone, new browser): take that seat back.
  const key = name.toLowerCase();
  const ri = G.seats.findIndex(s => !s.bot && s.n.toLowerCase() === key && !present(s.k));
  if (ri >= 0){
    const s = G.seats[ri], old = s.k;
    s.k = k;
    if (avv !== null) s.av = avv;
    G.q = G.q.filter(x => x.k !== k);
    if (G.win && G.win.k === old) G.win.k = k;
    if (G.champ === old) G.champ = k;
    if (G.lpk === old) G.lpk = k;
    addLog(G, s.n + ' is back.');
    return true;
  }
  const qi = G.q.findIndex(x => x.k === k);
  if (qi >= 0){
    const q = G.q[qi], nn = uniqueName(G, k, name);
    let ch = false;
    if (q.n !== nn){ q.n = nn; ch = true; }
    if (avv !== null && q.av !== avv){ q.av = avv; ch = true; }
    return ch;
  }
  if (G.ph === 'play'){
    if (G.seats.length + G.q.length >= MAXP) return false;
    const nn = uniqueName(G, k, name);
    G.q.push({k:k, n:nn, av:avv === null ? rint(AV_COUNT) : avv});
    addLog(G, nn + ' will join next round.');
    return true;
  }
  if (G.seats.length >= MAXP) return false;
  const nn = uniqueName(G, k, name);
  G.seats.push(newSeat(k, nn, false, avv));
  addLog(G, nn + ' sat down.');
  return true;
}
function addBot(G){
  if (G.ph === 'play' || G.seats.length >= MAXP) return false;
  const used = new Set(G.seats.map(s => s.n));
  const nm = BOT_NAMES.find(n => !used.has(n)) || ('Bot ' + (G.bots + 1));
  G.bots++;
  G.seats.push(newSeat('bot:' + G.bots, nm, true));
  addLog(G, nm + ' (bot) sat down.');
  return true;
}
function setRule(G, r, v){
  if (G.ph === 'play') return false;
  if (r === 'stack'){ if (G.rules.stack === !!v) return false; G.rules.stack = !!v; return true; }
  if (r === 'goal'){ const n = +v; if ([0, 250, 500].indexOf(n) >= 0 && G.rules.goal !== n){ G.rules.goal = n; return true; } }
  return false;
}
function doReset(G, present){
  if (!G.seats.length && !G.q.length) return false;
  if (G.seats.some(s => !s.bot && present(s.k))) return false;
  const rules = G.rules, bots = G.bots, lpn = G.lpn;
  const fresh = newTable();
  Object.keys(G).forEach(key => { delete G[key]; });
  Object.assign(G, fresh, {rules:rules, bots:bots, lpn:lpn + 1});
  addLog(G, 'The table was cleared.');
  return true;
}
function applyAct(G, k, name, a, present){
  if (!a || typeof a.t !== 'string') return false;
  const seated = seatOf(G, k) >= 0;
  switch (a.t){
    case 'join': return doJoin(G, k, name, present, a.av);
    case 'leave': return doLeave(G, k) && (maybeStart(G, present), true);
    case 'start': return seated && startRound(G);
    case 'ready': return doReady(G, k, a.v, present);
    case 'bot': return seated && addBot(G) && (maybeStart(G, present), true);
    case 'rule': return seated && setRule(G, a.r, a.v);
    case 'play': return doPlay(G, k, String(a.c || ''), a.col);
    case 'draw': return doDraw(G, k);
    case 'pass': return doPass(G, k);
    case 'call': return doCall(G, k);
    case 'catch': return doCatch(G, k, String(a.x || ''));
    case 'skip': return doSkipAway(G, k, String(a.x || ''), present);
    case 'kick': return doKick(G, k, String(a.x || ''), present) && (maybeStart(G, present), true);
    case 'reset': return doReset(G, present);
  }
  return false;
}
function botChoose(G, si){
  const s = G.seats[si];
  const ctx = ctxOf(G);
  let cands = s.hand.filter(c => canPlay(c, ctx));
  if (G.drew) cands = cands.filter(c => c === G.dn);
  if (!cands.length) return null;
  const threat = G.seats[nextIdx(G, 1)].hand.length <= 2;
  let best = null, bs = -1;
  for (const c of cands){
    let sc;
    if (c === 'wF') sc = threat ? 9 : 1;
    else if (c === 'wW') sc = 2;
    else if ('SRD'.indexOf(c[1]) >= 0) sc = threat ? 8 : 5;
    else sc = 4 + (+c[1]) / 10;
    if (!isWild(c) && c[0] === G.col) sc += 0.5;
    sc += Math.random() * 0.3;
    if (sc > bs){ bs = sc; best = c; }
  }
  let col = null;
  if (isWild(best)){
    const cnt = {r:0, y:0, g:0, b:0};
    for (const c of s.hand) if (!isWild(c)) cnt[c[0]]++;
    col = COLS.reduce((a, b) => cnt[b] > cnt[a] ? b : a, COLS[rint(4)]);
  }
  return {c:best, col:col};
}
function botMove(G){
  if (G.ph !== 'play') return false;
  const s = G.seats[G.turn];
  if (!s || !s.bot) return false;
  const ch = botChoose(G, G.turn);
  if (ch){
    if (s.hand.length === 2 && !s.called && Math.random() < 0.8){ s.called = true; addLog(G, s.n + ': Last card!'); }
    return doPlay(G, s.k, ch.c, ch.col);
  }
  if (G.drew) return doPass(G, s.k);
  return doDraw(G, s.k);
}
function botCatchTarget(G){
  if (G.ph !== 'play') return null;
  const t = G.seats.find(s => s.hand.length === 1 && !s.called);
  if (!t) return null;
  const bots = G.seats.filter(s => s.bot && s !== t);
  if (!bots.length) return null;
  return {bot:bots[rint(bots.length)], t:t};
}

const api = {MAXP, AV_COUNT, maybeStart, doReady, tidy, botChoose, COLS, CNAME, CARD_RE, BOT_NAMES, rint, shuffle, newDeck, isWild, pts, cardName, canPlay,
  newTable, newSeat, seatOf, addLog, nextIdx, ctxOf, startRound, applyAct, botMove, botCatchTarget,
  doCatch, doCall, addBot, removeSeat, doReset};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.LCEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
