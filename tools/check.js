// Simulates many bot rounds against engine.js and checks the rules hold:
// every card accounted for (deck size plus any +10s created), turn always valid, every round ends back in the lobby with
// a recorded winner, bots gone and nobody ready, and the ready-up flow starts games correctly.
// Run: node tools/check.js
const E = require('../engine.js');

const total = G => G.deck.length + G.disc.length + G.seats.reduce((n, s) => n + s.hand.length, 0);
const everyone = () => true;
const nobody = () => false;
let rounds = 0, steps = 0, maxSteps = 0;
const fx = {};

for (let game = 0; game < 400; game++){
  const G = E.newTable();
  const here = new Set(['human']);
  const present = k => here.has(k);
  E.applyAct(G, 'human', 'H', {t:'join'}, present);
  // mix the house rules: most games use them all, some switch a few off
  for (const r of E.RULES) if (game % 5 === 0 && Math.random() < 0.5) E.applyAct(G, 'human', 'H', {t:'rule', r:r, v:false}, present);
  const bots = 1 + (game % 7);
  for (let r = 0; r < 3; r++){
    for (let i = 0; i < bots; i++) E.applyAct(G, 'human', 'H', {t:'bot'}, present);
    if (G.ph !== 'lobby') throw new Error('adding bots started a game before anyone was ready');
    if (!E.applyAct(G, 'human', 'H', {t:'ready', v:true}, present)) throw new Error('ready failed');
    if (G.ph !== 'play') throw new Error('everyone ready but no game');
    if (total(G) !== G.base + G.made) throw new Error('deal count ' + total(G));
    let s = 0;
    while (G.ph === 'play'){
      const cur = G.seats[G.turn];
      let ok;
      if (cur.k === 'human'){
        // the human picks cards like a bot but never calls "Last card!", so catches get exercised
        const pick = E.botChoose(G, G.turn);
        ok = pick ? E.applyAct(G, 'human', 'H', {t:'play', c:pick.c, col:pick.col, x:pick.x}, present)
          : E.applyAct(G, 'human', 'H', {t:G.drew ? 'pass' : 'draw'}, present);
      } else ok = E.botMove(G);
      if (!ok) throw new Error('stuck on ' + JSON.stringify({turn:G.turn, pend:G.pend, drew:G.drew, hand:cur.hand}));
      const ct = E.botCatchTarget(G);
      if (ct && Math.random() < 0.5) E.doCatch(G, ct.bot.k, ct.t.k);
      if (G.ph === 'play' && G.seats.length > 4 && Math.random() < 0.002){
        const bi = G.seats.findIndex(x => x.bot);
        if (bi >= 0) E.applyAct(G, 'human', 'H', {t:'kick', x:G.seats[bi].k}, present);
      }
      if (G.ph === 'play'){
        if (total(G) !== G.base + G.made) throw new Error('card count ' + total(G) + ' vs ' + (G.base + G.made));
        if (G.seats[G.turn].out) throw new Error('turn on a player who is out');
        if (E.ruleOn(G, 'mercy') && G.seats.some(x => x.hand.length >= E.MERCY)) throw new Error('mercy rule missed');
        if (G.turn < 0 || G.turn >= G.seats.length) throw new Error('bad turn');
      }
      if (++s > 8000) throw new Error('round too long');
      if (G.fx) fx[G.fx.t] = (fx[G.fx.t] || 0) + 1;
    }
    rounds++; steps += s; maxSteps = Math.max(maxSteps, s);
    if (G.ph !== 'lobby') throw new Error('round did not return to the lobby');
    if (!G.win || G.win.rd !== G.rd) throw new Error('no winner recorded');
    if (G.seats.some(x => x.bot)) throw new Error('bots stayed after the game');
    if (G.seats.some(x => x.rdy)) throw new Error('ready flags not reset');
  }
}

// Two people: the game waits for both, and someone who left can't hold it up.
{
  const G = E.newTable();
  const here = new Set(['a', 'b']);
  const present = k => here.has(k);
  E.applyAct(G, 'a', 'Ann', {t:'join'}, present);
  E.applyAct(G, 'b', 'Ben', {t:'join'}, present);
  E.applyAct(G, 'a', 'Ann', {t:'ready', v:true}, present);
  if (G.ph !== 'lobby') throw new Error('started before Ben was ready');
  here.delete('b'); here.add('c');
  E.applyAct(G, 'c', 'Cat', {t:'join'}, present);
  E.applyAct(G, 'c', 'Cat', {t:'ready', v:true}, present);
  if (G.ph !== 'play' || G.seats.some(s => s.k === 'b')) throw new Error('away player held up the start');
  // Leaving mid-game until only bots remain clears the table.
  const T = E.newTable();
  E.applyAct(T, 'a', 'Ann', {t:'join'}, everyone);
  E.applyAct(T, 'a', 'Ann', {t:'bot'}, everyone);
  E.applyAct(T, 'a', 'Ann', {t:'bot'}, everyone);
  E.applyAct(T, 'a', 'Ann', {t:'ready', v:true}, everyone);
  if (T.ph !== 'play') throw new Error('solo with bots did not start');
  E.applyAct(T, 'a', 'Ann', {t:'leave'}, everyone);
  if (T.ph !== 'lobby' || T.seats.length) throw new Error('bots kept playing alone');
  // A table everyone has left can be cleared; one with a present player cannot.
  const R = E.newTable();
  E.applyAct(R, 'a', 'Ann', {t:'join'}, everyone);
  if (E.applyAct(R, 'x', 'X', {t:'reset'}, everyone)) throw new Error('reset with players present');
  if (!E.applyAct(R, 'x', 'X', {t:'reset'}, nobody) || R.seats.length) throw new Error('reset failed');
}

// Targeted rule checks on hand-built tables.
function table(hands, top, extra){
  const G = E.newTable();
  hands.forEach((h, i) => { const s = E.newSeat('p' + i, 'P' + i, false, 0); s.hand = h.slice(); G.seats.push(s); });
  Object.assign(G, {ph:'play', disc:[top], col:top[0] === 'w' ? 'r' : top[0], deck:new Array(40).fill(0).map((_, i) => 'gy'[i % 2] + (1 + (i % 9))), turn:0, dir:1}, extra || {});
  return G;
}
{
  // Legendary dumps every card of its color
  const G = table([['bL','b3','bS','r4','b9'], ['g1','g2']], 'b5');
  if (!E.applyAct(G, 'p0', 'P0', {t:'play', c:'bL'}, everyone)) throw new Error('legendary not playable');
  if (G.seats[0].hand.join() !== 'r4' || G.disc[G.disc.length - 1] !== 'bL') throw new Error('legendary dump wrong ' + G.seats[0].hand);
  // ...and wins outright if that empties your hand
  const W = table([['gL','g3','g7'], ['r1','r2']], 'g5');
  E.applyAct(W, 'p0', 'P0', {t:'play', c:'gL'}, everyone);
  if (W.ph !== 'lobby' || W.win.k !== 'p0') throw new Error('legendary did not win');
}
{
  // Magic 7 swaps with the chosen player; it plays on any 7 and needs a target
  const G = table([['rM','g1','g2','g3'], ['b1'], ['y1','y2']], 'b7');
  if (E.applyAct(G, 'p0', 'P0', {t:'play', c:'rM'}, everyone)) throw new Error('magic 7 played without a target');
  if (!E.applyAct(G, 'p0', 'P0', {t:'play', c:'rM', x:'p2'}, everyone)) throw new Error('magic 7 failed');
  if (G.seats[0].hand.join() !== 'y1,y2' || G.seats[2].hand.join() !== 'g1,g2,g3') throw new Error('swap wrong');
}
{
  // Spin 0 passes every hand to the next player in play direction
  const G = table([['rZ','a1'.replace('a','r')], ['g1'], ['y1','y2']], 'r5');
  E.applyAct(G, 'p0', 'P0', {t:'play', c:'rZ'}, everyone);
  if (G.seats[1].hand.join() !== 'r1' || G.seats[2].hand.join() !== 'g1' || G.seats[0].hand.join() !== 'y1,y2') throw new Error('spin wrong ' + JSON.stringify(G.seats.map(x => x.hand)));
}
{
  // Stacking: +2 on +2, +4 on +2, +10 on anything, +2 not on +4; the last player draws it all
  const G = table([['rD','r1'], ['gD','b1'], ['wF','y1'], ['wT','g1']], 'r3');
  E.applyAct(G, 'p0', 'P0', {t:'play', c:'rD'}, everyone);
  E.applyAct(G, 'p1', 'P1', {t:'play', c:'gD'}, everyone);
  E.applyAct(G, 'p2', 'P2', {t:'play', c:'wF', col:'b'}, everyone);
  if (E.canPlay('rD', E.ctxOf(G))) throw new Error('+2 stacked on +4');
  E.applyAct(G, 'p3', 'P3', {t:'play', c:'wT', col:'b'}, everyone);
  if (G.pend !== 18) throw new Error('stack total ' + G.pend);
  E.applyAct(G, 'p0', 'P0', {t:'draw'}, everyone);
  if (G.seats[0].hand.length !== 1 + 18 || G.turn !== 1) throw new Error('stack draw wrong');
}
{
  // Mercy: reaching 20 cards puts you out; last one standing wins
  const big = new Array(18).fill('g9');
  const G = table([big, ['b1','b2']], 'r3', {pend:2, pt:'D'});
  E.applyAct(G, 'p0', 'P0', {t:'draw'}, everyone);
  if (G.ph !== 'lobby' || G.win.k !== 'p1') throw new Error('mercy did not end the round');
}
{
  // Jump-in with the identical card, out of turn; not allowed with a different card
  const G = table([['g1','g2'], ['r5','r6','y2'], ['b1','b2']], 'r5');
  if (E.applyAct(G, 'p1', 'P1', {t:'play', c:'r6'}, everyone)) throw new Error('jumped in with a different card');
  if (!E.applyAct(G, 'p1', 'P1', {t:'play', c:'r5'}, everyone)) throw new Error('jump-in failed');
  if (G.turn !== 2) throw new Error('turn after jump-in should pass from the jumper');
  // ...but nobody can jump in on their own card
  const D = table([['g4','g4','b1'], ['r1','r2']], 'r4');
  E.applyAct(D, 'p0', 'P0', {t:'play', c:'g4'}, everyone);
  if (E.applyAct(D, 'p0', 'P0', {t:'play', c:'g4'}, everyone)) throw new Error('jumped in on own card');
}
{
  // Turn timer: the player draws and the turn moves on
  const G = table([['g1','g2'], ['b1','b2']], 'r5');
  if (!E.applyAct(G, 'p1', 'P1', {t:'timeout', x:'p0'}, everyone)) throw new Error('timeout failed');
  if (G.turn !== 1 || G.seats[0].hand.length !== 3) throw new Error('timeout effect wrong');
  if (E.applyAct(G, 'p0', 'P0', {t:'timeout', x:'p0'}, everyone)) throw new Error('timeout on the wrong player');
}

const ctx = {top:'r5', color:'r', pend:0, pt:null};
const expect = (c, v, cx = ctx) => { if (E.canPlay(c, cx) !== v) throw new Error('canPlay ' + c + ' ' + JSON.stringify(cx)); };
expect('r9', true); expect('g5', true); expect('g6', false); expect('wW', true); expect('wF', true);
expect('gD', true, {top:'rD', color:'r', pend:2, pt:'D'});
expect('gD', false, {top:'wF', color:'g', pend:4, pt:'F'});
expect('wF', true, {top:'rD', color:'r', pend:2, pt:'D'});
expect('wT', true, {top:'wF', color:'r', pend:4, pt:'F'});
expect('wF', false, {top:'wT', color:'r', pend:10, pt:'T'});
expect('bM', true, {top:'r7', color:'r', pend:0, pt:null});
expect('gZ', true, {top:'y0', color:'y', pend:0, pt:null});
expect('yL', true, {top:'bL', color:'b', pend:0, pt:null});

console.log('ok:', rounds, 'rounds, avg', (steps / rounds).toFixed(1), 'moves, longest', maxSteps, '| effects seen:', JSON.stringify(fx));
