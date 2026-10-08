// Simulates many bot rounds against engine.js and checks the rules hold:
// 108 cards always accounted for, turn always valid, every round ends back in the lobby with
// a recorded winner, bots gone and nobody ready, and the ready-up flow starts games correctly.
// Run: node tools/check.js
const E = require('../engine.js');

const total = G => G.deck.length + G.disc.length + G.seats.reduce((n, s) => n + s.hand.length, 0);
const everyone = () => true;
const nobody = () => false;
let rounds = 0, steps = 0, maxSteps = 0;

for (let game = 0; game < 400; game++){
  const G = E.newTable();
  const here = new Set(['human']);
  const present = k => here.has(k);
  E.applyAct(G, 'human', 'H', {t:'join'}, present);
  if (game % 2) E.applyAct(G, 'human', 'H', {t:'rule', r:'stack', v:true}, present);
  const bots = 1 + (game % 7);
  for (let r = 0; r < 3; r++){
    for (let i = 0; i < bots; i++) E.applyAct(G, 'human', 'H', {t:'bot'}, present);
    if (G.ph !== 'lobby') throw new Error('adding bots started a game before anyone was ready');
    if (!E.applyAct(G, 'human', 'H', {t:'ready', v:true}, present)) throw new Error('ready failed');
    if (G.ph !== 'play') throw new Error('everyone ready but no game');
    if (total(G) !== 108) throw new Error('deal count ' + total(G));
    let s = 0;
    while (G.ph === 'play'){
      const cur = G.seats[G.turn];
      let ok;
      if (cur.k === 'human'){
        // the human picks cards like a bot but never calls "Last card!", so catches get exercised
        const pick = E.botChoose(G, G.turn);
        ok = pick ? E.applyAct(G, 'human', 'H', {t:'play', c:pick.c, col:pick.col}, present)
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
        if (total(G) !== 108) throw new Error('card count ' + total(G));
        if (G.turn < 0 || G.turn >= G.seats.length) throw new Error('bad turn');
        if (G.pend && !G.rules.stack) throw new Error('pending draw without stacking');
      }
      if (++s > 5000) throw new Error('round too long');
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

const ctx = {top:'r5', color:'r', pend:0, pt:null, stack:false};
const expect = (c, v, cx = ctx) => { if (E.canPlay(c, cx) !== v) throw new Error('canPlay ' + c + ' ' + JSON.stringify(cx)); };
expect('r9', true); expect('g5', true); expect('g6', false); expect('wW', true); expect('wF', true);
expect('gD', false, {top:'rD', color:'r', pend:2, pt:'D', stack:false});
expect('gD', true, {top:'rD', color:'r', pend:2, pt:'D', stack:true});
expect('gD', false, {top:'wF', color:'g', pend:4, pt:'F', stack:true});
expect('wF', true, {top:'rD', color:'r', pend:2, pt:'D', stack:true});

console.log('ok:', rounds, 'rounds, avg', (steps / rounds).toFixed(1), 'moves, longest', maxSteps);
