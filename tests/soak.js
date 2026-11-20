// Teste de resistência (no browser, com o jogo aberto em localhost): joga muitos pontos em todos os modos offline
// e verifica a cada passo da simulação que nada fica preso, nada vira NaN e o marcador bate certo.
//   const s = await import('./tests/soak.js'); s.match({ points:60 }); s.challenges();
const D = () => window.__dt;
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const CH = ['tudo', 'canhao', 'muralha', 'relampago', 'artista', 'martelo', 'rede'];
const SURF = ['hard', 'clay', 'grass'];
const ok = v => Number.isFinite(v);

// jogador simulado: serve quando é a vez dele, faz swipe perto do instante certo; tsig = erro de tempo
function driver(tsig = 0.05) {
  const { M, B, P } = D(), cv = document.getElementById('c');
  const pe = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId:7, clientX:x, clientY:y, bubbles:true, isPrimary:true, pointerType:'touch' }));
  let sched = null, lastId = -1, served = false;
  return () => {
    const o = M.objective, me = P[M.me];
    if (M.phase === 'preserve' && M.server === M.me && !M.toss && (served === false || D().simTime - served > 1.5)) {
      served = D().simTime;
      const ax = o && o.zone === 'wide' ? -0.9 : o && o.zone === 'T' ? 0.9 : (Math.random() - 0.5) * 1.8;
      M.toss = { idx:M.me, t0:D().simTime, aim:D().serveTarget(M.me, ax, 0.5 + Math.random() * 0.5), releaseAt:0.56 + gauss() * 0.07 }; B.held = false;
    }
    if (M.phase !== 'preserve') served = false;
    if (M.phase === 'rally' && B.live && B.hitter === 1 - M.me && me.incoming && isFinite(me.incoming.absT) && lastId !== B.hitId) {
      lastId = B.hitId; sched = { t:me.incoming.absT + gauss() * tsig, id:B.hitId };
    }
    if (sched && D().simTime >= sched.t && B.hitId === sched.id) {
      sched = null; const kind = Math.random(), dx = (Math.random() - 0.5) * 160, cx = innerWidth / 2, h = innerHeight;
      pe('pointerdown', cx, h * 0.8);
      if (kind < 0.1) { pe('pointermove', cx + dx * 0.3, h * 0.86); pe('pointerup', cx + dx * 0.5, h * 0.97); }          // balão
      else if (kind < 0.16) { pe('pointermove', cx, h * 0.83); pe('pointerup', cx + dx * 0.2, h * 0.86); }             // amorti
      else { pe('pointermove', cx + dx * 0.5, h * 0.7); pe('pointerup', cx + dx, h * (0.62 - Math.random() * 0.2)); }
    }
  };
}
// invariantes verificados a cada passo
function check(errs) {
  const { M, B, P } = D();
  if (![B.p.x, B.p.y, B.p.z, B.v.x, B.v.y, B.v.z].every(ok)) errs.push('bola NaN ' + JSON.stringify([B.p, B.v]));
  for (const p of P) {
    if (!ok(p.pos.x) || !ok(p.pos.z)) errs.push('jogador NaN ' + p.idx);
    else if (Math.abs(p.pos.x) > 16 || Math.abs(p.pos.z) > 26) errs.push(`jogador ${p.idx} fora do mundo ${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}`);
  }
  if (B.live && (B.p.y < -0.5 || B.p.y > 40)) errs.push('bola fora do mundo y=' + B.p.y.toFixed(2));
  if (!M.objective && M.score[0] + M.score[1] !== M.pointsPlayed) errs.push(`marcador ${M.score} ≠ pontos ${M.pointsPlayed}`);
}
// jogos rápidos contra o CPU em todas as combinações; devolve resumo e erros
export function match({ points = 60, level, mine, opp, surface, night, bestOf = 1, stats = null, cpuTotal } = {}) {
  const { M } = D(), errs = [], step = driver();
  let pts = 0, matches = 0, stuckAt = D().simTime, lastPP = -1, counted = false, maxRally = 0;
  const start = () => {
    matches++;
    D().startMatch({ mode:'cpu', me:0, names:['Eu', 'CPU'], level:level ?? (matches % 3), surface:surface || SURF[matches % 3], night:night ?? matches % 2 === 0,
      first:matches % 2, chars:[mine || CH[matches % 7], opp || CH[(matches * 3 + 1) % 7]], bestOf, stats, cpuTotal });
  };
  start();
  while (pts < points) {
    D().simulate(1 / 120); step(); check(errs);
    if (errs.length > 5) break;
    if (M.phase === 'over') { start(); continue; }
    if (M.phase === 'pointover' && !counted && M.lastWinner >= 0) { counted = true; pts++; stuckAt = D().simTime; maxRally = Math.max(maxRally, M.pointHits || 0); }
    if (M.phase !== 'pointover') counted = false;
    if (D().simTime - stuckAt > 150) { errs.push(`preso: fase ${M.phase}, servidor ${M.server}, lançamento ${!!M.toss}, bola viva ${B().live}, pancadas ${M.pointHits}`); break; }
  }
  return { pontos:pts, jogos:matches, maxRally, erros:errs };
}
const B = () => D().B;
// todos os desafios até ao fim
export function challenges() {
  const { M } = D(), out = {};
  for (const [kind, goal, zone] of [['serveTarget', 5, 'T'], ['serveTarget', 5, 'wide'], ['aces', 2], ['rally', 12], ['winners', 3], ['dropWinner', 1]]) {
    const errs = [], step = driver(0.04);
    D().startChallenge({ id:kind, kind, goal, zone, level:1 });
    let n = 0;
    while (M.phase !== 'over' && n++ < 120 * 400) { D().simulate(1 / 120); step(); check(errs); if (errs.length > 3) break; }
    out[kind + (zone ? '-' + zone : '')] = { acabou:M.phase === 'over', resultado:M.objective && M.objective.score, tentativas:M.objective && M.objective.n, erros:errs };
  }
  return out;
}
