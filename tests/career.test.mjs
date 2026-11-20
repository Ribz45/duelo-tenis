import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../career-engine.js';

const total = o => C.STATS.reduce((s, k) => s + o[k], 0);
const byTier = opts => Object.fromEntries(opts.filter(o => o.kind === 'event').map(o => [o.tier, o]));
const tierRank = o => (o.tier === 'finals' ? 99 : C.TIER_ORDER.indexOf(o.tier));
const rec = (st, id) => st.players.find(p => p.i === id);

// Força extra (em pontos de atributos) de quem ganha 65 % dos encontros contra adversários do seu nível.
const BIAS_65 = (() => { let lo = -20, hi = 20; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (C.winChance(m) < 0.65) lo = m; else hi = m; } return lo; })();

// Gasta tudo o que der: pontos no atributo mais baixo, material, e um treinador quando possível.
function spendAll(st) {
  for (;;) {
    const k = C.STATS.filter(s => st.player.stats[s] < 10).sort((a, b) => st.player.stats[a] - st.player.stats[b])[0];
    if (!k || !C.spendAttr(st, k).ok) break;
  }
  for (const slot of Object.keys(C.GEAR)) while (C.buyGear(st, slot).ok);
  if (C.canChangeCoach(st)) for (const id of ['mental', 'power', 'touch', 'serve', 'fitness']) if (C.hireCoach(st, id).ok) break;
}
// Uma semana: entra no torneio elegível mais alto e joga-o com simulateMatch(bias).
function playWeek(st, bias = 0) {
  const ev = C.weekOptions(st).filter(o => o.kind === 'event' && o.eligible);
  assert.ok(ev.length > 0, `semana sem torneios elegíveis (época ${st.season}, semana ${st.week}, ranking ${st.rank})`);
  ev.sort((a, b) => tierRank(b) - tierRank(a));
  C.enterEvent(st, ev[0].id);
  let w = 0, l = 0;
  while (st.event) { const r = C.simulateMatch(st, { bias }); if (r.won) w++; else l++; C.recordMatch(st, r); }
  spendAll(st);
  const week = st.week, season = st.season;
  const res = C.finishWeek(st);
  return { res, w, l, tier:ev[0].tier, when:season - 1 + Math.min(week, 12) / 12 }; // when: épocas decorridas no fim da semana
}
function playCareer(seed, bias, seasons) {
  const st = C.newCareer({ name:'Teste', style:Object.keys(C.STYLES)[seed % 6], seed });
  const out = { st, w:0, l:0, top100:null, top20:null, no1:null, endRank:[], level:[] };
  while (st.season <= seasons) {
    const { res, w, l, when } = playWeek(st, bias);
    out.w += w; out.l += l;
    if (out.top100 === null && res.rank <= 100) out.top100 = when;
    if (out.top20 === null && res.rank <= 20) out.top20 = when;
    if (out.no1 === null && res.rank === 1) out.no1 = when;
    if (res.seasonEnded) { out.endRank.push(res.rank); out.level.push(st.player.level); }
  }
  return out;
}
const median = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/* ───────── atributos ───────── */

test('statsFor soma o total, respeita 1–10 e a forma do estilo', () => {
  for (const style of Object.keys(C.STYLES)) {
    assert.deepEqual(C.statsFor(style, 30), C.STYLES[style].shape);
    for (let t = 5; t <= 50; t++) {
      const s = C.statsFor(style, t);
      assert.equal(total(s), t, `${style} ${t}`);
      for (const k of C.STATS) assert.ok(s[k] >= 1 && s[k] <= 10);
      const j = C.statsFor(style, t, C.makeRng(t * 7 + 1));
      assert.equal(total(j), t);
      for (const k of C.STATS) assert.ok(j[k] >= 1 && j[k] <= 10);
    }
    assert.equal(total(C.statsFor(style, 99)), 50);
    assert.equal(total(C.statsFor(style, 0)), 5);
  }
  const c = C.statsFor('canhao', 15);
  assert.ok(c.srv >= c.pow && c.pow >= c.spd, 'o Canhão continua a servir melhor do que corre');
  assert.deepEqual(Object.keys(C.STAT_LABELS), C.STATS);
});

/* ───────── criação e determinismo ───────── */

test('nova carreira: jogador no fundo, 199 adversários variados, rival de estilo oposto', () => {
  const st = C.newCareer({ name:'Ana', look:3, style:'canhao', seed:5 });
  assert.equal(st.players.length, 199);
  assert.equal(new Set(st.players.map(p => p.i)).size, 199);
  assert.equal(new Set(st.players.map(p => p.n)).size, 199);
  for (const p of st.players) {
    assert.match(p.c, /^[A-Z]{2}$/);
    assert.ok(C.STYLES[p.y]);
    assert.equal(p.s.length, 5);
    assert.equal(p.p.length, 12);
  }
  const totals = st.players.map(p => p.s.reduce((a, b) => a + b, 0));
  assert.ok(Math.min(...totals) <= 14 && Math.max(...totals) >= 43, `forças ${Math.min(...totals)}–${Math.max(...totals)}`);
  assert.ok(new Set(st.players.map(p => p.y)).size === 6);
  const top10 = C.ranking(st, { limit:10 });
  assert.ok(top10.reduce((s, r) => s + r.total, 0) / 10 >= 38, 'o topo do ranking é forte');
  assert.deepEqual(st.player.stats, C.statsFor('canhao', 15));
  assert.equal(st.player.level, 1); assert.equal(st.player.xp, 0); assert.equal(st.player.attr, 0); assert.equal(st.player.money, 0);
  assert.equal(st.rank, 200);
  assert.equal(rec(st, st.rival).y, 'muralha');
  assert.ok(C.rivalInfo(st).rank >= 170, `rival começa perto de ti (${C.rivalInfo(st).rank}.º)`);
  for (const [mine, theirs] of [['martelo', 'artista'], ['relampago', 'tudo'], ['muralha', 'canhao']])
    assert.equal(rec(C.newCareer({ style:mine, seed:1 }), C.newCareer({ style:mine, seed:1 }).rival).y, theirs);
});

test('mesma semente → mesma carreira; outra semente → outro circuito', () => {
  const a = C.newCareer({ name:'Rui', style:'artista', seed:42 }), b = C.newCareer({ name:'Rui', style:'artista', seed:42 });
  assert.equal(C.serialize(a), C.serialize(b));
  assert.notEqual(C.serialize(C.newCareer({ name:'Rui', style:'artista', seed:43 })), C.serialize(a));
  for (let i = 0; i < 8; i++) { playWeek(a, 1); playWeek(b, 1); }
  assert.equal(C.serialize(a), C.serialize(b));
  assert.equal(JSON.stringify(C.trainingChallenges(a)), JSON.stringify(C.trainingChallenges(b)));
});

test('gravar e carregar a meio de um torneio continua exatamente igual', () => {
  const a = C.newCareer({ seed:77 });
  for (let i = 0; i < 3; i++) playWeek(a, 2);
  const opt = C.weekOptions(a).find(o => o.eligible && o.kind === 'event');
  C.enterEvent(a, opt.id);
  C.recordMatch(a, C.simulateMatch(a));
  const b = C.deserialize(C.serialize(a));
  for (const st of [a, b]) {
    while (st.event) C.recordMatch(st, C.simulateMatch(st));
    C.finishWeek(st);
    playWeek(st, 2);
  }
  assert.equal(C.serialize(a), C.serialize(b));
});

/* ───────── calendário e inscrições ───────── */

test('calendário: Grand Slams nas semanas 3, 6, 9, 12 e Futuros + treino todas as semanas', () => {
  const majors = { 3:['Open do Atlântico', 'hard'], 6:['Taça da Terra', 'clay'], 9:['Relva Real', 'grass'], 12:['Open da Cidade', 'hard'] };
  for (let w = 1; w <= 12; w++) {
    const evs = C.weekEvents(w);
    assert.ok(evs.length >= 2 && evs.length <= 3, `semana ${w}`);
    assert.equal(new Set(evs.map(e => e.tier)).size, evs.length, 'escalões diferentes');
    assert.ok(evs.some(e => e.tier === 'futures'));
    for (const e of evs) assert.ok(['hard', 'clay', 'grass'].includes(e.surface));
    const mj = evs.find(e => e.tier === 'major');
    if (majors[w]) assert.deepEqual([mj.name, mj.surface], majors[w]); else assert.equal(mj, undefined);
  }
  assert.equal(C.weekEvents(12).find(e => e.tier === 'major').night, true);
  assert.deepEqual(C.weekEvents(13).map(e => e.tier), ['finals']);
  const st = C.newCareer({ seed:3 });
  for (let w = 1; w <= 12; w++) {
    st.week = w;
    const o = C.weekOptions(st);
    assert.ok(o.some(x => x.tier === 'futures' && x.eligible), `futuros elegíveis na semana ${w}`);
    assert.ok(o.some(x => x.kind === 'training' && x.eligible));
  }
});

test('elegibilidade pelo ranking e convite (wildcard) de um escalão acima', () => {
  const st = C.newCareer({ seed:7 });
  let o = byTier(C.weekOptions(st)); // semana 1: futuros, challenger, 250
  assert.ok(o.futures.eligible && !o.futures.wildcard);
  assert.ok(!o.challenger.eligible); assert.match(o.challenger.reason, /top 180/);
  assert.ok(!o.t250.eligible);
  st.wildcard = true;
  o = byTier(C.weekOptions(st));
  assert.ok(o.challenger.eligible && o.challenger.wildcard);
  assert.ok(!o.t250.eligible, 'o convite só salta um escalão');
  st.wildcard = false; st.rank = 150;
  o = byTier(C.weekOptions(st));
  assert.ok(o.challenger.eligible && !o.challenger.wildcard);
  assert.ok(!o.t250.eligible);
  st.wildcard = true;
  assert.ok(byTier(C.weekOptions(st)).t250.wildcard);
  st.wildcard = false; st.rank = 15; st.week = 3;
  o = byTier(C.weekOptions(st));
  assert.ok(o.major.eligible && o.challenger.eligible && o.futures.eligible);
  st.rank = 25;
  assert.ok(!byTier(C.weekOptions(st)).major.eligible);
  st.wildcard = true;
  assert.ok(byTier(C.weekOptions(st)).major.wildcard, 'convite para o Grand Slam a partir do top 30');
  assert.throws(() => C.enterEvent(st, 'nao-existe'));

  // a sério: ganhar um torneio dá o convite na semana seguinte (e só nessa)
  const s2 = C.newCareer({ seed:8 });
  s2.week = 2;
  C.enterEvent(s2, byTier(C.weekOptions(s2)).futures.id);
  while (s2.event) C.recordMatch(s2, { won:true, score:[10, 5] });
  C.finishWeek(s2);
  assert.equal(s2.week, 3);
  assert.equal(s2.wildcard, true);
  const ch = byTier(C.weekOptions(s2)).challenger;
  assert.ok(ch.eligible);
  assert.equal(ch.wildcard, s2.rank > 180);
  C.enterEvent(s2, ch.id);
  while (s2.event) C.recordMatch(s2, { won:false, score:[3, 10] });
  C.finishWeek(s2);
  assert.equal(s2.wildcard, false);
});

/* ───────── quadros ───────── */

test('quadro: ganhar as 3 rondas dos Futuros dá o título', () => {
  const st = C.newCareer({ seed:11 });
  const ev = C.enterEvent(st, byTier(C.weekOptions(st)).futures.id);
  assert.equal(st.event, ev);
  assert.equal(ev.round, 0); assert.equal(ev.rounds, 3); assert.equal(ev.alive, true); assert.deepEqual(ev.results, []);
  assert.equal(ev.bracket.length, 8);
  assert.equal(ev.bracket.filter(x => x === 'me').length, 1);
  assert.equal(new Set(ev.bracket).size, 8);
  for (const id of ev.bracket) if (id !== 'me') assert.ok(rec(st, id));
  assert.throws(() => C.enterEvent(st, ev.id), /meio de um torneio/);
  const names = [], rewards = [];
  for (let i = 0; i < 3; i++) {
    const m = C.nextMatch(st);
    assert.equal(m.round, i); assert.equal(m.bestOf, 1);
    assert.ok(m.opp.name && m.opp.country && C.STYLES[m.opp.style]);
    assert.equal(total(m.opp.stats), m.opp.total);
    names.push(m.roundName);
    rewards.push(C.recordMatch(st, { won:true, score:[10, 6] }));
  }
  assert.deepEqual(names, ['Quartos-de-final', 'Meias-finais', 'Final']);
  assert.ok(!rewards[0].champion && !rewards[1].champion && rewards[2].champion);
  assert.ok(rewards.every(r => !r.eliminated));
  assert.deepEqual(rewards[0].milestones.map(m => m.id), ['firstWin']);
  assert.ok(rewards[2].milestones.some(m => m.id === 'firstTitle'));
  assert.equal(rewards[2].points, 25); assert.equal(rewards[2].money, 2000);
  assert.equal(rewards[0].points, 0);
  assert.equal(st.event, null);
  assert.equal(st.titles, 1); assert.equal(st.trophies.length, 1);
  assert.equal(st.history.at(-1).champion, true);
  assert.equal(st.lastEvent.championId, 'me');
  assert.equal(C.nextMatch(st), null);
  assert.throws(() => C.recordMatch(st, { won:true }));
  assert.ok(C.weekOptions(st).every(o => !o.eligible), 'um torneio por semana');
  C.finishWeek(st);
  assert.equal(st.player.pts[0], 25);
  assert.ok(st.rank < 200);
});

test('quadro: perder elimina e fecha o torneio; o resto do quadro é jogado', () => {
  const st = C.newCareer({ seed:12 });
  st.rank = 150;
  C.enterEvent(st, byTier(C.weekOptions(st)).challenger.id);
  assert.equal(C.nextMatch(st).roundName, 'Primeira ronda');
  C.recordMatch(st, { won:true, score:[11, 9] });
  assert.equal(C.nextMatch(st).roundName, 'Quartos-de-final');
  const r = C.recordMatch(st, { won:false, score:[8, 10] });
  assert.ok(r.eliminated && !r.champion);
  assert.equal(r.points, C.eventPoints('challenger', 1));
  assert.equal(r.money, C.eventPrize('challenger', 1));
  assert.equal(st.event, null);
  assert.equal(st.lastEvent.adv.length, 4);
  assert.notEqual(st.lastEvent.championId, 'me');
  assert.equal(Object.keys(st.pending).length, 16, 'todos os do quadro têm pontos desta semana');
  assert.ok(Object.values(st.pending).every(p => p >= 1));
  assert.equal(st.wins, 1); assert.equal(st.losses, 1);
});

test('quadro por força: os adversários mais fortes ficam para as rondas finais', () => {
  let first = 0, lastHalf = 0, n = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const st = C.newCareer({ seed });
    st.rank = 90;
    const ev = C.enterEvent(st, byTier(C.weekOptions(st)).t250.id);
    const m = ev.bracket.indexOf('me'), tot = id => rec(st, id).s.reduce((a, b) => a + b, 0);
    first += tot(ev.bracket[m ^ 1]);
    const other = ev.bracket.filter((id, i) => (i >> 3) !== (m >> 3));
    lastHalf += other.reduce((s, id) => s + tot(id), 0) / other.length;
    n++;
    for (const id of ev.bracket) if (id !== 'me') assert.ok(tot(id) >= 23 - 3 && tot(id) <= 30 + 3, 'força do escalão (23–30)');
  }
  assert.ok(first / n < lastHalf / n - 2, `1.ª ronda ${(first / n).toFixed(1)} vs outra metade ${(lastHalf / n).toFixed(1)}`);
});

test('Grand Slam: 32 jogadores, meias e final à melhor de 3, rival na tua metade no primeiro', () => {
  const st = C.newCareer({ seed:13 });
  rec(st, st.rival).s = [8, 8, 8, 8, 8];
  st.rank = 10; st.week = 3;
  const ev = C.enterEvent(st, byTier(C.weekOptions(st)).major.id);
  assert.equal(ev.bracket.length, 32);
  const m = ev.bracket.indexOf('me'), r = ev.bracket.indexOf(st.rival);
  assert.ok(r >= 0, 'o rival está no quadro');
  assert.ok((m >> 4) === (r >> 4) && (m >> 3) !== (r >> 3), 'rival no outro quarto da tua metade (meias-finais)');
  const names = [], bo = [];
  while (st.event) {
    const x = C.nextMatch(st);
    names.push(x.roundName); bo.push(x.bestOf);
    const sim = C.simulateMatch(st, { bias:30 });
    if (x.bestOf === 3) {
      assert.equal(sim.sets.length, sim.score[0] + sim.score[1]);
      assert.ok(Math.max(...sim.score) === 2);
    }
    C.recordMatch(st, sim);
  }
  assert.deepEqual(names, ['Primeira ronda', 'Oitavos-de-final', 'Quartos-de-final', 'Meias-finais', 'Final']);
  assert.deepEqual(bo, [1, 1, 1, 3, 3]);
  assert.equal(st.majors, 1);
  assert.ok(st.milestones.includes('firstMajor'));
  assert.equal(st.history.at(-1).points, 2000);
});

test('primeira final da carreira: o adversário é o rival (quando plausível)', () => {
  let checked = 0;
  for (let seed = 100; seed < 130 && checked < 3; seed++) {
    const st = C.newCareer({ seed });
    const ev = C.enterEvent(st, byTier(C.weekOptions(st)).futures.id);
    if (ev.bracket.includes(st.rival)) continue;
    C.recordMatch(st, { won:true, score:[10, 4] });
    C.recordMatch(st, { won:true, score:[10, 8] });
    const f = C.nextMatch(st);
    assert.equal(f.roundName, 'Final');
    assert.equal(f.isRival, true);
    assert.equal(f.lines.length, 2);
    C.recordMatch(st, { won:false, score:[9, 11] });
    assert.deepEqual(st.h2h, [0, 1]);
    assert.equal(st.lastEvent.championId, st.rival);
    checked++;
  }
  assert.equal(checked, 3);
});

/* ───────── recompensas ───────── */

test('XP: vitória 100 × fator, derrota 40 %, simulado 50 %, bónus; níveis e pontos de atributo', () => {
  const st = C.newCareer({ seed:21 });
  C.enterEvent(st, byTier(C.weekOptions(st)).futures.id);
  let r = C.recordMatch(st, { won:true, score:[10, 7] });
  assert.equal(r.xp, 100);
  assert.equal(C.xpToNext(1), 100);
  assert.equal(r.levelUps, 1); assert.equal(r.attrGained, 1); assert.equal(st.player.level, 2); assert.equal(st.player.attr, 1);
  r = C.recordMatch(st, { won:false, score:[6, 10] });
  assert.equal(r.xp, 40); assert.ok(r.eliminated);

  const s2 = C.newCareer({ seed:22 });
  C.enterEvent(s2, byTier(C.weekOptions(s2)).futures.id);
  assert.equal(C.recordMatch(s2, { won:true, score:[10, 2], simulated:true }).xp, 50);
  assert.equal(C.recordMatch(s2, { won:true, score:[12, 10], matchStats:{ aces:3, winners:5, longestRally:22, comeback:true } }).xp, 100 + 15 + 10 + 30 + 40);
  const champ = C.recordMatch(s2, { won:true, score:[10, 8] });
  assert.ok(champ.champion); assert.equal(champ.xp, 200, 'bónus de campeão');

  const s3 = C.newCareer({ seed:23 });
  s3.rank = 150;
  C.enterEvent(s3, byTier(C.weekOptions(s3)).challenger.id);
  s3.player.level = 4; s3.player.xp = C.xpToNext(4) - 1;
  r = C.recordMatch(s3, { won:true, score:[10, 7] });
  assert.equal(r.xp, 150, 'fator 1,5 no Challenger');
  assert.equal(s3.player.level, 5); assert.equal(r.attrGained, 2, 'nível 5: 2 pontos');
  assert.equal(C.recordMatch(s3, { won:false, score:[5, 10] }).xp, 60);
  for (let l = 1; l < 40; l++) assert.ok(C.xpToNext(l + 1) > C.xpToNext(l));
  assert.ok(C.xpToNext(20) > 10 * C.xpToNext(1));
  assert.deepEqual(C.levelInfo(s3), { level:5, xp:s3.player.xp, need:C.xpToNext(5), attr:s3.player.attr });
});

/* ───────── gastar ───────── */

test('atributos, material e treinadores: regras e limites', () => {
  const st = C.newCareer({ style:'tudo', seed:31 });
  const P = st.player;
  assert.deepEqual(C.spendAttr(st, 'spd'), { ok:false, error:'Não tens pontos para gastar.' });
  P.attr = 3;
  assert.ok(C.spendAttr(st, 'spd').ok); assert.equal(P.stats.spd, 4); assert.equal(P.attr, 2);
  assert.equal(C.spendAttr(st, 'xyz').ok, false);
  P.stats.pow = 10;
  assert.equal(C.spendAttr(st, 'pow').ok, false); assert.equal(P.attr, 2);

  assert.equal(C.buyGear(st, 'racket').ok, false, 'sem dinheiro');
  assert.equal(C.buyGear(st, 'bola').ok, false);
  P.money = 1e6;
  const before = C.effectiveStats(st);
  assert.equal(C.gearPrice(st, 'shoes'), C.GEAR.shoes.prices[0]);
  assert.ok(C.buyGear(st, 'shoes').ok);
  assert.equal(P.money, 1e6 - C.GEAR.shoes.prices[0]);
  assert.equal(C.effectiveStats(st).spd, before.spd + 1);
  assert.ok(C.buyGear(st, 'shoes').ok);
  assert.equal(C.effectiveStats(st).spd, before.spd + 2);
  assert.equal(C.buyGear(st, 'shoes').ok, false, 'máximo +2');
  assert.equal(C.gearPrice(st, 'shoes'), null);
  assert.ok(C.GEAR.shoes.prices[1] > C.GEAR.shoes.prices[0]);
  assert.ok(C.buyGear(st, 'racket').ok);
  assert.equal(C.effectiveStats(st).pow, 10, 'efetivo nunca passa de 10');
  assert.equal(C.GEAR.racket.stat, 'pow'); assert.equal(C.GEAR.strings.stat, 'ctl'); assert.equal(C.GEAR.shoes.stat, 'spd');

  const perks = Object.values(C.COACHES).map(c => c.perk.id).sort();
  assert.deepEqual(perks, ['clutchWindow', 'dropControl', 'perfectServeWindow', 'powerWinner', 'recovery']);
  for (const c of Object.values(C.COACHES)) { assert.equal(c.bonus, 1); assert.ok(C.STATS.includes(c.stat)); assert.ok(c.label && c.perk.text); }
  assert.match(C.hireCoach(st, 'mental').error, /top 30/);
  assert.equal(C.hireCoach(st, 'ninguem').ok, false);
  assert.match(C.hireCoach(st, 'fitness').error, /top 180/);
  st.bestRank = 150;
  P.money = 0;
  assert.match(C.hireCoach(st, 'fitness').error, /dinheiro/);
  P.money = 1e6;
  const srv = C.effectiveStats(st).srv;
  st.week = 4; // a meio da época, mas ainda sem treinador: pode contratar
  assert.ok(C.hireCoach(st, 'serve').ok);
  assert.equal(C.effectiveStats(st).srv, srv + 1);
  assert.equal(P.money, 1e6 - C.COACHES.serve.cost);
  st.bestRank = 20;
  assert.match(C.hireCoach(st, 'mental').error, /entre épocas/);
  assert.equal(C.hireCoach(st, 'serve').ok, false);
  st.week = 1;
  assert.ok(C.canChangeCoach(st));
  assert.ok(C.hireCoach(st, 'mental').ok, 'na 1.ª semana, antes de jogar, pode trocar');
  C.recordTraining(st, { results:[] });
  assert.equal(C.canChangeCoach(st), false);
});

/* ───────── semana, ranking, época ───────── */

test('finishWeek: ranking muda, o circuito joga, marcos só uma vez', () => {
  const st = C.newCareer({ seed:41 });
  const old = st.players.map(p => p.p[0]);
  st.player.pts[6] = 400;
  const r = C.finishWeek(st);
  assert.equal(r.prevRank, 200);
  assert.ok(r.rank <= 100, `ranking ${r.rank}`);
  assert.equal(r.bestRank, r.rank);
  assert.ok(r.milestones.some(m => m.id === 'top100' && m.title && m.text));
  assert.equal(r.seasonEnded, false);
  assert.equal(st.week, 2);
  assert.ok(st.players.some((p, i) => p.p[0] !== old[i]), 'os pontos da semana 1 da época anterior foram substituídos');
  assert.ok(r.news.length > 0 && r.news.every(s => typeof s === 'string'));
  assert.equal(C.ranking(st).find(x => x.me).rank, r.rank);
  const r2 = C.finishWeek(st);
  assert.ok(!r2.milestones.some(m => m.id === 'top100'));
  st.player.pts[6] = 20000;
  const r3 = C.finishWeek(st);
  assert.equal(r3.rank, 1);
  assert.deepEqual(r3.milestones.map(m => m.id).filter(id => id !== 'top100'), ['top50', 'top20', 'top10', 'no1']);
  assert.equal(st.weeksNo1, 1);
});

test('ranking(): 200 jogadores ordenados, janela à volta de ti', () => {
  const st = C.newCareer({ seed:42 });
  const all = C.ranking(st);
  assert.equal(all.length, 200);
  all.forEach((r, i) => { assert.equal(r.rank, i + 1); if (i) assert.ok(all[i - 1].points >= r.points); });
  assert.equal(all.filter(r => r.me).length, 1);
  assert.equal(all.filter(r => r.rival).length, 1);
  assert.equal(C.ranking(st, { limit:10 }).length, 10);
  const win = C.ranking(st, { limit:11, around:'me' });
  assert.equal(win.length, 11);
  assert.ok(win.some(r => r.me));
  assert.ok(C.ranking(st, { limit:5, around:st.rival }).some(r => r.rival));
  assert.deepEqual(Object.keys(C.summary(st)).sort(), ['bestRank', 'level', 'majors', 'name', 'rank', 'season', 'titles']);
});

test('época: 12 semanas e nova época; o circuito envelhece e o rival cresce', () => {
  const st = C.newCareer({ seed:51 });
  const tot0 = st.players.map(p => p.s.reduce((a, b) => a + b, 0)).join();
  const rival0 = C.rivalInfo(st).total;
  for (let w = 1; w <= 11; w++) assert.equal(C.finishWeek(st).seasonEnded, false);
  assert.equal(st.week, 12);
  st.player.stats = C.statsFor(st.player.style, 30);
  const r = C.finishWeek(st);
  assert.ok(r.seasonEnded);
  assert.equal(st.season, 2); assert.equal(st.week, 1);
  assert.notEqual(st.players.map(p => p.s.reduce((a, b) => a + b, 0)).join(), tot0);
  assert.ok(C.rivalInfo(st).total > rival0, 'o rival acompanha o teu crescimento');
  assert.equal(st.seasons.length, 1);
  const totals = st.players.map(p => p.s.reduce((a, b) => a + b, 0));
  assert.ok(Math.max(...totals) >= 43 && Math.min(...totals) <= 15, 'o circuito continua com fortes e fracos');
});

test('Finais da Época: só para o top 8, semana 13, final à melhor de 3', () => {
  const st = C.newCareer({ seed:61 });
  for (let w = 1; w <= 11; w++) C.finishWeek(st);
  st.player.pts = st.player.pts.map(() => 800);
  const r = C.finishWeek(st);
  assert.equal(r.seasonEnded, false);
  assert.equal(st.week, 13);
  assert.ok(r.milestones.some(m => m.id === 'finalsQualified'));
  const o = C.weekOptions(st);
  assert.deepEqual(o.map(x => x.kind), ['event', 'training']);
  assert.ok(o[0].eligible && o[0].tier === 'finals');
  const ev = C.enterEvent(st, o[0].id);
  assert.equal(ev.bracket.length, 8);
  const top7 = C.ranking(st, { limit:8 }).filter(x => !x.me).map(x => x.id).slice(0, 7).sort();
  assert.deepEqual(ev.bracket.filter(id => id !== 'me').sort(), top7);
  const bo = [];
  while (st.event) { bo.push(C.nextMatch(st).bestOf); C.recordMatch(st, { won:true, score:bo.at(-1) === 3 ? [2, 1] : [10, 8] }); }
  assert.deepEqual(bo, [1, 1, 3]);
  assert.equal(st.finalsWon, 1);
  const end = C.finishWeek(st);
  assert.ok(end.seasonEnded);
  assert.equal(st.season, 2); assert.equal(st.week, 1);

  const s2 = C.newCareer({ seed:62 });
  for (let w = 1; w <= 12; w++) C.finishWeek(s2);
  assert.equal(s2.season, 2, 'sem top 8 a época passa logo à seguinte');
  assert.ok(!s2.milestones.includes('finalsQualified'));
});

/* ───────── treino e simulação ───────── */

test('treino: 3 desafios que crescem com o nível e dão bom XP', () => {
  const st = C.newCareer({ seed:71 });
  const ch = C.trainingChallenges(st);
  assert.equal(ch.length, 3);
  assert.equal(new Set(ch.map(c => c.kind)).size, 3);
  for (const c of ch) {
    assert.ok(['serveTarget', 'rally', 'winners', 'dropWinner', 'aces'].includes(c.kind));
    assert.ok(c.id && c.label && c.text && c.goal >= 1);
    if (c.kind === 'serveTarget') assert.ok(['T', 'wide'].includes(c.zone));
  }
  assert.deepEqual(C.trainingChallenges(st), ch, 'os mesmos desafios durante a semana');
  const hi = C.newCareer({ seed:71 });
  hi.player.level = 21;
  C.trainingChallenges(hi).forEach((c, i) => assert.ok(c.goal >= ch[i].goal));
  assert.ok(C.trainingChallenges(hi).some((c, i) => c.goal > ch[i].goal || c.kind === 'dropWinner'));
  const all = C.recordTraining(st, { results:ch.map(c => ({ id:c.id, score:c.goal, goal:c.goal, passed:true })) });
  assert.equal(all.xp, 200, 'metade de um título nos Futuros (400 XP)');
  assert.ok(all.levelUps >= 1);
  assert.throws(() => C.recordTraining(st, { results:[] }), /Já jogaste/);
  assert.ok(C.weekOptions(st).every(o => !o.eligible));
  const none = C.recordTraining(C.newCareer({ seed:72 }), { results:ch.map(c => ({ id:c.id, score:0, goal:c.goal, passed:false })) });
  assert.ok(none.xp > 0 && none.xp < all.xp);
  const s3 = C.newCareer({ seed:73 });
  s3.rank = 10;
  assert.ok(C.recordTraining(s3, { results:ch.map(c => ({ ...c, passed:true })) }).xp > 1000, 'o XP do treino acompanha o teu nível');
});

test('simulateMatch: tie-breaks realistas; Simular só como favorito claro', () => {
  const st = C.newCareer({ seed:81 });
  C.enterEvent(st, byTier(C.weekOptions(st)).futures.id);
  const save = C.serialize(st);
  let wins = 0;
  for (let i = 0; i < 200; i++) {
    const s = C.deserialize(save);
    s.rng = (s.rng + i * 7919) >>> 0;
    const { won, score } = C.simulateMatch(s);
    const [a, b] = score, w = Math.max(a, b), l = Math.min(a, b);
    assert.equal(won, a > b);
    assert.ok(w >= 10 && w - l >= 2 && (w === 10 || w - l === 2), `resultado ${a}–${b}`);
    if (won) wins++;
  }
  assert.ok(wins > 20 && wins < 190);
  const m = C.nextMatch(st);
  assert.equal(m.canSimulate, total(C.effectiveStats(st)) - m.opp.total >= 6);
  st.player.stats = C.statsFor('tudo', 40);
  assert.equal(C.nextMatch(st).canSimulate, true);
});

/* ───────── gravação, reforma ───────── */

test('5 épocas completas: gravação ≤ 64 KB, carrega igual, reforma no Hall da Fama', () => {
  const { st } = playCareer(9001, BIAS_65, 5);
  assert.equal(st.season, 6);
  const json = C.serialize(st);
  console.log(`  gravação após 5 épocas: ${json.length} bytes (${(json.length / 1024).toFixed(1)} KB)`);
  assert.ok(json.length <= 64 * 1024, `${json.length} bytes`);
  assert.deepEqual(C.deserialize(json), st);
  assert.ok(st.history.length <= 40);
  assert.ok(C.canRetire(st));
  const { legacyScore, entry } = C.retire(st);
  assert.ok(legacyScore > 0);
  assert.equal(entry.legacyScore, legacyScore);
  assert.equal(entry.seasons, 5);
  assert.equal(entry.titles, st.titles);
  assert.equal(C.canRetire(st), false);
  assert.deepEqual(C.weekOptions(st), []);
  const young = C.newCareer({ seed:1 });
  assert.equal(C.canRetire(young), false);
  assert.throws(() => C.retire(young));
});

test('deserialize recusa lixo e versões desconhecidas', () => {
  for (const bad of ['', 'não é json', 'null', '[]', '{}', '42', JSON.stringify({ v:99 })]) assert.throws(() => C.deserialize(bad), bad);
  const st = C.newCareer({ seed:2 });
  const broken = JSON.parse(C.serialize(st));
  broken.players.pop();
  assert.throws(() => C.deserialize(JSON.stringify(broken)));
  assert.equal(C.deserialize(C.serialize(st)).player.name, st.player.name);
});

/* ───────── equilíbrio ───────── */

test(`equilíbrio: quem ganha 65 % contra o seu nível (força +${BIAS_65.toFixed(2)}) chega ao topo em 3–4 épocas`, () => {
  const N = 16, runs = [];
  for (let i = 0; i < N; i++) runs.push(playCareer(2000 + i, BIAS_65, 4));
  const w = runs.reduce((s, r) => s + r.w, 0), l = runs.reduce((s, r) => s + r.l, 0);
  const in1 = runs.filter(r => r.top100 !== null && r.top100 <= 1).length;
  const t20 = runs.map(r => r.top20 ?? 99), no1 = runs.map(r => r.no1 ?? 99);
  const no1by4 = no1.filter(t => t <= 4).length, no1by2 = no1.filter(t => t <= 2).length;
  console.log(`  ${N} carreiras, vitórias ${(100 * w / (w + l)).toFixed(1)} % no total;`
    + ` top 100 na 1.ª época: ${in1}/${N} (mediana ${median(runs.map(r => r.top100 ?? 99)).toFixed(2)} épocas);`
    + ` top 20: mediana ${median(t20).toFixed(2)} épocas; n.º 1: ${no1by4}/${N} até ao fim da 4.ª (mediana ${median(no1).toFixed(2)}),`
    + ` ${no1by2}/${N} até ao fim da 2.ª; ranking no fim de cada época (mediana): ${[0, 1, 2, 3].map(s => median(runs.map(r => r.endRank[s]))).join(' → ')}`);
  assert.ok(in1 >= N * 0.75, 'top 100 durante a 1.ª época');
  assert.ok(median(t20) > 1 && median(t20) <= 2.5, 'top 20 por volta da 2.ª época');
  assert.ok(no1by4 >= N * 0.5, 'hipótese real de n.º 1 até à 3.ª–4.ª época');
  assert.ok(no1by2 <= N * 0.25, 'mas não logo na 2.ª');
});

test('equilíbrio: quem perde quase sempre progride devagar e nunca fica sem torneio', () => {
  const runs = [];
  for (let i = 0; i < 6; i++) runs.push(playCareer(3000 + i, -10, 3));
  const w = runs.reduce((s, r) => s + r.w, 0), l = runs.reduce((s, r) => s + r.l, 0);
  console.log(`  vitórias ${(100 * w / (w + l)).toFixed(1)} %; nível no fim de cada época (mediana): ${[0, 1, 2].map(s => median(runs.map(r => r.level[s]))).join(' → ')};`
    + ` ranking: ${[0, 1, 2].map(s => median(runs.map(r => r.endRank[s]))).join(' → ')}`);
  assert.ok(w / (w + l) < 0.4);
  for (const r of runs) {
    assert.ok(r.level[0] >= 3 && r.level[2] > r.level[0], `nível ${r.level.join('→')}`);
    assert.ok(r.st.bestRank < 200);
    assert.equal(r.top20, null);
  }
});
