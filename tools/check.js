// Simulates many bot rounds against engine.js and checks the rules hold:
// 108 cards always accounted for, turn always valid, every round ends with an empty-handed winner.
// Run: node tools/check.js
const E = require('../engine.js');

const total = G => G.deck.length + G.disc.length + G.seats.reduce((n, s) => n + s.hand.length, 0);
const nobodyHere = () => false;
let rounds = 0, steps = 0, maxSteps = 0;

for (let game = 0; game < 400; game++){
  const G = E.newTable();
  const n = 2 + (game % 7);
  for (let i = 0; i < n; i++) E.addBot(G);
  // Seat 0 plays like a bot but never calls "Last card!", so catches get exercised.
  G.seats[0].bot = false; G.seats[0].k = 'human';
  if (game % 2) E.applyAct(G, 'human', 'H', {t:'rule', r:'stack', v:true}, nobodyHere);
  if (game % 3 === 0) E.applyAct(G, 'human', 'H', {t:'rule', r:'goal', v:250}, nobodyHere);
  for (let r = 0; r < 3; r++){
    if (!E.applyAct(G, 'human', 'H', {t:'start'}, nobodyHere)) throw new Error('start failed');
    if (total(G) !== 108) throw new Error('deal count ' + total(G));
    let s = 0;
    while (G.ph === 'play'){
      const cur = G.seats[G.turn];
      let ok;
      if (cur.k === 'human'){
        const before = cur.called;
        cur.bot = true; ok = E.botMove(G); cur.bot = false;
        if (cur.called && !before) cur.called = false;
      } else ok = E.botMove(G);
      if (!ok) throw new Error('stuck on ' + JSON.stringify({turn:G.turn, pend:G.pend, drew:G.drew, hand:cur.hand}));
      const ct = E.botCatchTarget(G);
      if (ct && Math.random() < 0.5) E.doCatch(G, ct.bot.k, ct.t.k);
      if (G.ph === 'play' && G.seats.length > 4 && Math.random() < 0.002){
        const bi = G.seats.findIndex(x => x.bot);
        if (bi >= 0) E.applyAct(G, 'human', 'H', {t:'kick', x:G.seats[bi].k}, nobodyHere);
      }
      if (G.ph === 'play'){
        if (total(G) !== 108) throw new Error('card count ' + total(G));
        if (G.turn < 0 || G.turn >= G.seats.length) throw new Error('bad turn');
        if (G.pend && !G.rules.stack) throw new Error('pending draw without stacking');
      }
      if (++s > 5000) throw new Error('round too long');
    }
    rounds++; steps += s; maxSteps = Math.max(maxSteps, s);
    const w = G.seats.find(x => x.k === G.win.k);
    if (!w || w.hand.length) throw new Error('winner still holds cards');
  }
  // A table everyone has left can be cleared; one with a present human cannot.
  if (E.applyAct(G, 'stranger', 'S', {t:'reset'}, () => true)) throw new Error('reset with players present');
  if (!E.applyAct(G, 'stranger', 'S', {t:'reset'}, nobodyHere)) throw new Error('reset failed');
  if (G.seats.length || G.ph !== 'lobby') throw new Error('reset left seats');
}

const ctx = {top:'r5', color:'r', pend:0, pt:null, stack:false};
const expect = (c, v, cx = ctx) => { if (E.canPlay(c, cx) !== v) throw new Error('canPlay ' + c + ' ' + JSON.stringify(cx)); };
expect('r9', true); expect('g5', true); expect('g6', false); expect('wW', true); expect('wF', true);
expect('gD', false, {top:'rD', color:'r', pend:2, pt:'D', stack:false});
expect('gD', true, {top:'rD', color:'r', pend:2, pt:'D', stack:true});
expect('gD', false, {top:'wF', color:'g', pend:4, pt:'F', stack:true});
expect('wF', true, {top:'rD', color:'r', pend:2, pt:'D', stack:true});

console.log('ok:', rounds, 'rounds, avg', (steps / rounds).toFixed(1), 'moves, longest', maxSteps);
