/* Last Card game rules. Pure functions over a plain JSON table state,
   shared by every player's browser (app.js) and by tools/check.js.

   Cards are two characters: a color (r y g b, or w for wild) and a value.
   0-9, S skip, R reverse, D +2, L Legendary (dumps every card of its color),
   M Magic 7 (swap hands with a player you pick), Z Spin 0 (everyone passes their hand),
   wW wild, wF wild +4, wT wild +10 (1% of cards dealt or drawn), wX Shuffle Hands. */
(function (root) {
'use strict';

const MAXP = 8;
const COLS = ['r','y','g','b'];
const CNAME = {r:'Red', y:'Yellow', g:'Green', b:'Blue'};
const CARD_RE = /^(?:[rygb][0-9SRDLMZ]|w[WFTX])$/;
const BOT_NAMES = ['Pixel','Clank','Nova','Dot','Gizmo','Bolt','Echo','Juno'];
const AV_COUNT = 16; /* avatars are picked by number; the page maps numbers to pictures */
const MERCY = 20;
const TURN_SECONDS = 15;
/* House rules people can switch off in the lobby. Stacking and Legendary cards are always on. */
const RULES = ['seven', 'zero', 'ten', 'shuffle', 'jump', 'timer', 'mercy'];
const DRAW_RANK = {D:1, F:2, T:3};
const DRAW_N = {D:2, F:4, T:10};

function rint(n){
  if (typeof crypto !== 'undefined' && crypto.getRandomValues){ const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
  return Math.floor(Math.random() * n);
}
function shuffle(a){ for (let i = a.length - 1; i > 0; i--){ const j = rint(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function ruleOn(G, r){ return !G.rules || G.rules[r] !== false; }
function newDeck(G){
  const d = [];
  for (const c of COLS){
    d.push(c + '0', c + 'L', c + '7', ruleOn(G, 'seven') ? c + 'M' : c + '7');
    for (const v of '12345689SRD') d.push(c + v, c + v);
  }
  for (let i = 0; i < 4; i++) d.push('wW', 'wF');
  if (ruleOn(G, 'shuffle')) d.push('wX', 'wX');
  if (ruleOn(G, 'zero')) d.push(COLS[rint(4)] + 'Z', COLS[rint(4)] + 'Z');
  return shuffle(d);
}
function isWild(c){ return c[0] === 'w'; }
function numOf(v){ return v === 'M' ? '7' : v === 'Z' ? '0' : v; }
function drawKind(c){ return c === 'wF' ? 'F' : c === 'wT' ? 'T' : (c[1] === 'D' && !isWild(c)) ? 'D' : null; }
function maxKind(a, b){ return !a ? b : !b ? a : (DRAW_RANK[a] >= DRAW_RANK[b] ? a : b); }
function pts(c){
  if (isWild(c)) return 50;
  const v = c[1];
  if (v === 'L') return 40;
  if ('SRDMZ'.indexOf(v) >= 0) return 20;
  return +v;
}
const VNAME = {S:'Skip', R:'Reverse', D:'+2'};
function cardName(c){
  if (c === 'wW') return 'Wild';
  if (c === 'wF') return 'Wild +4';
  if (c === 'wT') return 'Wild +10';
  if (c === 'wX') return 'Shuffle Hands';
  const v = c[1];
  if (v === 'L') return 'Legendary ' + CNAME[c[0]];
  if (v === 'M') return 'Magic 7 (' + CNAME[c[0]] + ')';
  if (v === 'Z') return 'Spin 0 (' + CNAME[c[0]] + ')';
  return CNAME[c[0]] + ' ' + (VNAME[v] || v);
}
/* ctx: {top, color, pend, pt}. While a draw pile is building, only an equal or bigger draw card stacks:
   +2 on +2, +4 on +2 or +4, +10 on anything. */
function canPlay(card, ctx){
  if (ctx.pend > 0){
    const k = drawKind(card);
    return !!k && DRAW_RANK[k] >= DRAW_RANK[ctx.pt || 'D'];
  }
  if (isWild(card)) return true;
  return card[0] === ctx.color || numOf(card[1]) === numOf(ctx.top[1]);
}
function newTable(){
  const rules = {};
  for (const r of RULES) rules[r] = true;
  return {v:0, ph:'lobby', rd:0, seats:[], q:[], deck:[], disc:[], turn:0, dir:1, col:'r', pend:0, pt:null,
    drew:false, dn:null, rules:rules, log:[], win:null, champ:null, lpk:null, lpn:0, bots:0, base:0, made:0, fx:null, again:false};
}
function validAv(v){ v = Number(v); return Number.isInteger(v) && v >= 0 && v < AV_COUNT ? v : null; }
function newSeat(k, n, bot, av){
  const a = validAv(av);
  return {k:k, n:n, bot:!!bot, av:a === null ? rint(AV_COUNT) : a, hand:[], called:false, score:0, wins:0, rdy:false, out:false};
}
function seatOf(G, k){ for (let i = 0; i < G.seats.length; i++) if (G.seats[i].k === k) return i; return -1; }
function active(G){ return G.seats.filter(s => !s.out); }
function addLog(G, m){ G.log.push(m); if (G.log.length > 6) G.log.splice(0, G.log.length - 6); }
function uniqueName(G, k, name){
  let n = name, i = 2;
  const taken = s => G.seats.some(x => x.k !== k && x.n === s) || G.q.some(x => x.k !== k && x.n === s);
  while (taken(n)){ n = name.slice(0, 13) + ' ' + i; i++; }
  return n;
}
/* One card off the deck. 1% of the time (when +10s are on) it turns into a Wild +10 instead. */
function takeCard(G){
  if (!G.deck.length){
    if (G.disc.length <= 1) return null;
    const top = G.disc.pop();
    G.deck = shuffle(G.disc);
    G.disc = [top];
  }
  let c = G.deck.pop();
  if (ruleOn(G, 'ten') && rint(100) === 0){ G.deck.unshift(c); c = 'wT'; G.made = (G.made || 0) + 1; }
  return c;
}
function drawTo(G, s, n){
  let got = 0;
  for (let i = 0; i < n; i++){
    const c = takeCard(G);
    if (!c) break;
    s.hand.push(c);
    got++;
  }
  if (got) s.called = false;
  return got;
}
/* Next seat still in the round, n steps along the play direction (out players are skipped). */
function stepFrom(G, i, dir){
  const L = G.seats.length;
  let guard = 0;
  do { i = (((i + dir) % L) + L) % L; guard++; } while (G.seats[i].out && guard <= L);
  return i;
}
function nextIdx(G, n){
  let i = G.turn;
  for (let s = 0; s < n; s++) i = stepFrom(G, i, G.dir);
  return i;
}
function ctxOf(G){ return {top:G.disc[G.disc.length - 1], color:G.col, pend:G.pend, pt:G.pt}; }

function startRound(G){
  if (G.ph === 'play') return false;
  for (const x of G.q){ if (seatOf(G, x.k) < 0 && G.seats.length < MAXP) G.seats.push(newSeat(x.k, x.n, false, x.av)); }
  G.q = [];
  if (G.seats.length < 2) return false;
  if (!G.rules || typeof G.rules !== 'object') G.rules = {};
  G.made = 0;
  G.deck = newDeck(G); G.disc = [];
  G.base = G.deck.length;
  for (const s of G.seats){ s.hand = []; s.called = false; s.rdy = false; s.out = false; }
  for (let r = 0; r < 7; r++) for (const s of G.seats) s.hand.push(takeCard(G));
  let i = G.deck.length - 1;
  while (i >= 0 && !/^[rygb][0-9]$/.test(G.deck[i])) i--;
  const first = G.deck.splice(i, 1)[0];
  G.disc = [first]; G.col = first[0];
  G.rd++; G.dir = 1; G.turn = (G.rd - 1) % G.seats.length;
  G.pend = 0; G.pt = null; G.drew = false; G.dn = null; G.win = null; G.ph = 'play';
  G.lpk = null; G.lpn++; G.again = false; G.fx = null;
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
  G.ph = 'lobby'; G.pend = 0; G.pt = null; G.drew = false; G.dn = null; G.again = false;
  G.seats = G.seats.filter(s => !s.bot);
  for (const x of G.q){ if (seatOf(G, x.k) < 0 && G.seats.length < MAXP) G.seats.push(newSeat(x.k, x.n, false, x.av)); }
  G.q = [];
  for (const s of G.seats){ s.hand = []; s.called = false; s.rdy = false; s.out = false; }
  G.deck = []; G.disc = [];
}
/* Mercy rule: reach 20 cards and you're out of the round. Returns true if the player went out. */
function mercyOut(G, si){
  const s = G.seats[si];
  if (!ruleOn(G, 'mercy') || s.hand.length < MERCY) return false;
  for (const c of s.hand) G.deck.unshift(c);
  s.hand = []; s.out = true; s.called = false;
  G.drew = false; G.dn = null; G.again = false;
  addLog(G, s.n + ' hit ' + MERCY + ' cards and is out!');
  const left = active(G);
  if (left.length === 1){ endRound(G, G.seats.indexOf(left[0])); return true; }
  if (G.turn === si) G.turn = nextIdx(G, 1);
  return true;
}
function spinHands(G){
  const idx = G.seats.map((s, i) => i).filter(i => !G.seats[i].out);
  const hands = idx.map(i => G.seats[i].hand);
  const L = idx.length;
  idx.forEach((si, j) => {
    G.seats[si].hand = hands[(((j - G.dir) % L) + L) % L];
    G.seats[si].called = false;
  });
}
function shuffleHands(G, from){
  const idx = G.seats.map((s, i) => i).filter(i => !G.seats[i].out);
  const all = [];
  for (const i of idx){ all.push(...G.seats[i].hand); G.seats[i].hand = []; G.seats[i].called = false; }
  shuffle(all);
  let j = idx.indexOf(from);
  for (const c of all){ j = (j + 1) % idx.length; G.seats[idx[j]].hand.push(c); }
}
function doPlay(G, k, card, col, x){
  if (G.ph !== 'play') return false;
  const si = seatOf(G, k);
  if (si < 0 || si !== G.turn) return false;
  if (!CARD_RE.test(card)) return false;
  const s = G.seats[si];
  if (s.out) return false;
  const hi = s.hand.indexOf(card);
  if (hi < 0) return false;
  if (G.drew && card !== G.dn) return false;
  if (!canPlay(card, ctxOf(G))) return false;
  if (isWild(card) && COLS.indexOf(col) < 0) return false;
  const v = card[1];
  let ti = -1;
  if (v === 'M' && s.hand.length > 1){
    ti = seatOf(G, String(x || ''));
    if (ti < 0 || ti === si || G.seats[ti].out) return false;
  }
  s.hand.splice(hi, 1);
  G.disc.push(card);
  G.col = isWild(card) ? col : card[0];
  G.drew = false; G.dn = null; G.lpk = k; G.lpn++; G.fx = null; G.dry = 0;
  let msg = s.n + ' played ' + cardName(card);
  if (isWild(card)) msg += ' and picked ' + CNAME[col];
  const two = active(G).length === 2;
  const dk = drawKind(card);
  if (v === 'S'){
    msg += '. ' + G.seats[nextIdx(G, 1)].n + ' is skipped';
    G.turn = nextIdx(G, 2);
  } else if (v === 'R'){
    if (two) G.turn = nextIdx(G, 2);
    else { G.dir *= -1; G.turn = nextIdx(G, 1); msg += '. Order reversed'; }
  } else if (dk){
    G.pend += DRAW_N[dk]; G.pt = maxKind(G.pt, dk);
    G.turn = nextIdx(G, 1);
    msg += '. ' + G.seats[G.turn].n + ' faces +' + G.pend;
    if (dk === 'T') G.fx = {t:'ten', n:G.lpn};
  } else if (v === 'L'){
    const c = card[0];
    const dump = s.hand.filter(h => h[0] === c);
    s.hand = s.hand.filter(h => h[0] !== c);
    G.disc.splice(G.disc.length - 1, 0, ...dump);
    if (dump.length) msg += ' and dumped ' + dump.length + ' more ' + CNAME[c].toLowerCase() + (dump.length === 1 ? ' card' : ' cards');
    G.fx = {t:'legend', n:G.lpn, c:dump.length};
    G.turn = nextIdx(G, 1);
  } else if (v === 'M'){
    if (ti >= 0 && s.hand.length){
      const t = G.seats[ti], tmp = s.hand;
      s.hand = t.hand; t.hand = tmp; s.called = false; t.called = false;
      msg += ' and swapped hands with ' + t.n;
      G.fx = {t:'swap', n:G.lpn, a:k, b:t.k};
    }
    G.turn = nextIdx(G, 1);
  } else if (v === 'Z'){
    if (s.hand.length){ spinHands(G); msg += '. Everyone passes their hand along'; G.fx = {t:'spin', n:G.lpn}; }
    G.turn = nextIdx(G, 1);
  } else if (card === 'wX'){
    if (s.hand.length){ shuffleHands(G, si); msg += ". Everyone's cards were shuffled and dealt back out"; G.fx = {t:'shuffle', n:G.lpn}; }
    G.turn = nextIdx(G, 1);
  } else {
    G.turn = nextIdx(G, 1);
  }
  G.again = G.turn === si;
  if (G.again && s.hand.length) msg += '. ' + s.n + ' goes again';
  addLog(G, msg + '.');
  if (!s.hand.length){ endRound(G, si); return true; }
  const empty = G.seats.findIndex(o => !o.out && !o.hand.length);
  if (empty >= 0) endRound(G, empty);
  return true;
}
function doDraw(G, k){
  if (G.ph !== 'play') return false;
  const si = seatOf(G, k);
  if (si < 0 || si !== G.turn) return false;
  const s = G.seats[si];
  if (G.pend > 0){
    const got = drawTo(G, s, G.pend);
    G.pend = 0; G.pt = null;
    addLog(G, s.n + ' drew ' + got + '.');
    if (mercyOut(G, si)) return true;
    G.turn = nextIdx(G, 1); G.again = false;
    return true;
  }
  if (G.drew) return false;
  const got = drawTo(G, s, 1);
  if (!got){
    // Every card is in someone's hand. If nobody can play a full lap in a row, fewest cards wins.
    G.dry = (G.dry || 0) + 1;
    addLog(G, s.n + ' passed. No cards left to draw.');
    if (G.dry >= active(G).length){
      const act = active(G), low = act.reduce((m, o) => o.hand.length < m.hand.length ? o : m, act[0]);
      addLog(G, 'Nobody can play. Fewest cards wins.');
      endRound(G, G.seats.indexOf(low));
      return true;
    }
    G.turn = nextIdx(G, 1); G.again = false;
    return true;
  }
  if (mercyOut(G, si)) return true;
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
/* Turn timer ran out: draw what you owe (or one card) and the turn moves on. */
function doTimeout(G, x){
  if (G.ph !== 'play' || !ruleOn(G, 'timer')) return false;
  const si = seatOf(G, x);
  if (si < 0 || si !== G.turn) return false;
  const s = G.seats[si];
  if (s.bot) return false;
  addLog(G, s.n + ' ran out of time.');
  if (G.drew) return doPass(G, x);
  doDraw(G, x);
  if (G.ph === 'play' && G.drew && G.turn === si) doPass(G, x);
  return true;
}
function doCall(G, k){
  if (G.ph !== 'play') return false;
  const si = seatOf(G, k);
  if (si < 0) return false;
  const s = G.seats[si];
  if (s.called || s.out) return false;
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
  if (t.out || t.hand.length !== 1 || t.called) return false;
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
  addLog(G, t.n + ' is away. Turn skipped.');
  if (G.pend > 0){ drawTo(G, t, G.pend); G.pend = 0; G.pt = null; if (mercyOut(G, ti)) return true; }
  G.drew = false; G.dn = null; G.turn = nextIdx(G, 1); G.again = false;
  return true;
}
function removeSeat(G, ti){
  const t = G.seats[ti];
  if (G.ph === 'play'){ for (const c of t.hand) G.deck.unshift(c); t.hand = []; }
  G.seats.splice(ti, 1);
  if (G.ph !== 'play') return;
  const left = active(G);
  if (left.length === 1 && G.seats.length > 1){ endRound(G, G.seats.indexOf(left[0])); return; }
  if (left.length < 2){
    for (const s of G.seats){ for (const c of s.hand) G.deck.unshift(c); s.hand = []; s.rdy = false; s.out = false; }
    G.ph = 'lobby'; G.pend = 0; G.pt = null; G.drew = false; G.dn = null; G.deck = []; G.disc = [];
    addLog(G, 'Not enough players. Back to the lobby.');
    return;
  }
  if (ti < G.turn) G.turn--;
  else if (ti === G.turn){ G.drew = false; G.dn = null; G.again = false; if (G.dir === -1) G.turn--; }
  const L = G.seats.length;
  G.turn = ((G.turn % L) + L) % L;
  if (G.seats[G.turn].out) G.turn = nextIdx(G, 1);
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
/* A table with no people left in it should not keep bots around. */
function tidy(G){
  if (G.ph !== 'play' && !G.seats.some(s => !s.bot)) G.seats = [];
  if (G.ph === 'play' && !G.seats.some(s => !s.bot)){
    G.ph = 'lobby'; G.seats = []; G.deck = []; G.disc = []; G.pend = 0; G.pt = null; G.drew = false; G.dn = null;
    addLog(G, 'Everyone left. The table is open.');
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
  if (G.ph === 'play' || RULES.indexOf(r) < 0) return false;
  if (!G.rules || typeof G.rules !== 'object') G.rules = {};
  if (ruleOn(G, r) === !!v) return false;
  G.rules[r] = !!v;
  return true;
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
/* Jump-in: play the exact same card as the top card even when it isn't your turn. */
function canJump(G, si, card){
  if (G.ph !== 'play' || !ruleOn(G, 'jump') || G.pend > 0 || si === G.turn) return false;
  const s = G.seats[si];
  if (!s || s.out || isWild(card)) return false;
  if (G.lpk === s.k) return false; // no jumping in on your own card
  return card === G.disc[G.disc.length - 1] && s.hand.indexOf(card) >= 0;
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
    case 'play': {
      const c = String(a.c || ''), si = seatOf(G, k);
      if (si >= 0 && canJump(G, si, c)){
        const saved = {turn:G.turn, drew:G.drew, dn:G.dn, again:G.again, log:G.log.slice()};
        addLog(G, G.seats[si].n + ' jumped in!');
        G.turn = si; G.drew = false; G.dn = null;
        if (doPlay(G, k, c, a.col, a.x)) return true;
        G.turn = saved.turn; G.drew = saved.drew; G.dn = saved.dn; G.again = saved.again; G.log = saved.log;
        return false;
      }
      return doPlay(G, k, c, a.col, a.x);
    }
    case 'draw': return doDraw(G, k);
    case 'pass': return doPass(G, k);
    case 'call': return doCall(G, k);
    case 'catch': return doCatch(G, k, String(a.x || ''));
    case 'skip': return doSkipAway(G, k, String(a.x || ''), present);
    case 'timeout': return doTimeout(G, String(a.x || ''));
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
  const n = s.hand.length;
  const others = active(G).filter(o => o !== s);
  const small = others.reduce((m, o) => (!m || o.hand.length < m.hand.length) ? o : m, null);
  const avg = others.reduce((t, o) => t + o.hand.length, 0) / Math.max(1, others.length);
  const threat = G.seats[nextIdx(G, 1)].hand.length <= 2;
  const giver = G.seats[stepFrom(G, si, -G.dir)];
  let best = null, bs = -1;
  for (const c of cands){
    const v = c[1];
    let sc;
    if (G.pend > 0) sc = DRAW_RANK[drawKind(c)] + 4;
    else if (c === 'wT') sc = threat ? 10 : 1.5;
    else if (c === 'wF') sc = threat ? 9 : 1;
    else if (c === 'wX') sc = n - 1 > avg + 1 ? 6 : 0.5;
    else if (c === 'wW') sc = 2;
    else if (v === 'L') sc = 3 + s.hand.filter(h => h[0] === c[0]).length * 1.5;
    else if (v === 'M') sc = small && small.hand.length < n - 1 ? 6 + (n - 1 - small.hand.length) : 0.5;
    else if (v === 'Z') sc = giver && giver !== s && giver.hand.length < n - 1 ? 5 : 0.5;
    else if ('SRD'.indexOf(v) >= 0) sc = threat ? 8 : 5;
    else sc = 4 + (+v) / 10;
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
  return {c:best, col:col, x:best[1] === 'M' && small ? small.k : null};
}
function botMove(G){
  if (G.ph !== 'play') return false;
  const s = G.seats[G.turn];
  if (!s || !s.bot) return false;
  const ch = botChoose(G, G.turn);
  if (ch){
    if (s.hand.length === 2 && !s.called && Math.random() < 0.8){ s.called = true; addLog(G, s.n + ': Last card!'); }
    return doPlay(G, s.k, ch.c, ch.col, ch.x);
  }
  if (G.drew) return doPass(G, s.k);
  return doDraw(G, s.k);
}
function botCatchTarget(G){
  if (G.ph !== 'play') return null;
  const t = G.seats.find(s => !s.out && s.hand.length === 1 && !s.called);
  if (!t) return null;
  const bots = G.seats.filter(s => s.bot && s !== t && !s.out);
  if (!bots.length) return null;
  return {bot:bots[rint(bots.length)], t:t};
}

const api = {MAXP, AV_COUNT, MERCY, TURN_SECONDS, RULES, COLS, CNAME, CARD_RE, BOT_NAMES, rint, shuffle, newDeck, isWild, numOf,
  drawKind, pts, cardName, canPlay, canJump, ruleOn, newTable, newSeat, seatOf, addLog, nextIdx, ctxOf, active, startRound,
  applyAct, botChoose, botMove, botCatchTarget, doCatch, doCall, addBot, removeSeat, doReset, maybeStart, doReady, tidy};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.LCEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
