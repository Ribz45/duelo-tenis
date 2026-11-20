// Testes de equilíbrio do jogo (correm no browser, com o jogo aberto em localhost).
// Na consola:  const b = await import('./tests/balance.js');  b.serves(40);  b.play(1, 80);
// Simulam um jogador humano razoável (erro de tempo ~60 ms, ângulos ao acaso) contra o CPU.
const D = () => window.__dt;
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const start = level => D().startMatch({ mode:'cpu', me:0, names:['Eu', 'CPU'], surface:'hard', level, first:0, looks:[0, 1] });

// um serviço meu (0-0, lado direito): devolve 'fault' | 'unret' (ás ou resposta falhada) | 'cpuErr' | 'ret'
export function serveOnce(level, ax, ad, err) {
  const { M, B } = D(); start(level);
  let n = 0; while (M.phase !== 'preserve' && n++ < 2000) D().simulate(0.05);
  M.toss = { idx:0, t0:D().simTime, aim:D().serveTarget(0, ax, ad), releaseAt:0.56 + err }; B.held = false;
  const sc = M.score.slice(); let hid = null, k = 0;
  while (M.score[0] === sc[0] && M.score[1] === sc[1] && k++ < 1500) {
    D().simulate(0.02);
    if (hid === null && B.hitter === 0 && B.isServe) hid = B.hitId;
    if (M.serveNum === 2 && M.phase !== 'rally') return 'fault';
  }
  if (M.serveNum === 2) return 'fault';
  return M.score[0] > sc[0] ? (B.hitId > hid ? 'cpuErr' : 'unret') : 'ret';
}
// % de serviços sem resposta por nível, direção (T / aberto / ao corpo) e tempo (perfeito / bom)
export function serves(N = 40) {
  const out = {};
  for (const level of [0, 1, 2]) for (const [ax, ad, lab] of [[1, 1, 'T'], [-1, 1, 'aberto'], [0, 0.9, 'corpo']]) for (const err of [0, 0.1]) {
    const c = {}; for (let i = 0; i < N; i++) { const r = serveOnce(level, ax, ad, err); c[r] = (c[r] || 0) + 1; }
    const tot = N - (c.fault || 0) || 1;
    out[`L${level} ${lab} ${err ? 'bom' : 'perfeito'}`] = `sem resposta ${Math.round(100 * (c.unret || 0) / tot)}% · erro CPU ${Math.round(100 * (c.cpuErr || 0) / tot)}% · faltas ${Math.round(100 * (c.fault || 0) / N)}%`;
  }
  return out;
}
// pontos jogados com swipes reais no canvas; devolve % ganhos, pancadas por ponto, altura dos balões e porquê
// stopAtEnd: para no fim do primeiro jogo (para ver o ecrã final) em vez de começar outro
export function play(level, points = 80, tsig = 0.06, stopAtEnd = false) {
  const { M, B, P } = D(), cv = document.getElementById('c');
  const pe = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId:7, clientX:x, clientY:y, bubbles:true, isPrimary:true, pointerType:'touch' }));
  start(level);
  const st = { pts:0, won:0, rallies:[], lobs:[], why:{} };
  let sched = null, lastId = -1, served = false, apex = 0, lobOn = false, counted = false, lastPoint = D().simTime;
  const cx = innerWidth / 2, h = innerHeight;
  while (st.pts < points) {
    D().simulate(1 / 120);
    // vigia: um ponto que nunca acaba é um bug do jogo — devolve o estado em vez de ficar preso
    if (D().simTime - lastPoint > 90) return { preso:true, pontos:st.pts, pancadasNoPonto:M.pointHits, phase:M.phase, server:M.server, serveNum:M.serveNum, toss:!!M.toss, held:B.held, live:B.live,
      bounces:B.bounces, hitter:B.hitter, isServe:B.isServe, ball:[+B.p.x.toFixed(2), +B.p.y.toFixed(2), +B.p.z.toFixed(2)], v:[+B.v.x.toFixed(2), +B.v.y.toFixed(2), +B.v.z.toFixed(2)] };
    if (M.phase === 'over') { if (stopAtEnd) break; start(level); continue; }
    if (M.phase === 'preserve' && M.server === 0 && !M.toss && (served === false || D().simTime - served > 1.5)) {   // se o lançamento falhar, lança outra vez
      served = D().simTime;
      M.toss = { idx:0, t0:D().simTime, aim:D().serveTarget(0, (Math.random() < 0.5 ? 1 : -1) * Math.random(), 0.6 + Math.random() * 0.4), releaseAt:0.56 + gauss() * 0.07 }; B.held = false;
    }
    if (M.phase !== 'preserve') served = false;
    if (M.phase === 'rally' && B.live && B.hitter === 1 && P[0].incoming && isFinite(P[0].incoming.absT) && lastId !== B.hitId) {
      lastId = B.hitId; sched = { t:P[0].incoming.absT + gauss() * tsig, id:B.hitId };
    }
    if (sched && D().simTime >= sched.t && B.hitId === sched.id) {
      sched = null; const lob = Math.random() < 0.12, dx = (Math.random() - 0.5) * 140;
      pe('pointerdown', cx, h * 0.8); pe('pointermove', cx + dx * 0.5, lob ? h * 0.86 : h * 0.7); pe('pointerup', cx + dx, lob ? h * 0.97 : h * (0.62 - Math.random() * 0.2));
    }
    if (B.live && B.hitter === 0 && !B.isServe && B.spin === 0.2) { lobOn = true; apex = Math.max(apex, B.p.y); }
    if (lobOn && (B.hitter !== 0 || B.bounces > 0)) { st.lobs.push(+apex.toFixed(1)); lobOn = false; apex = 0; }
    if (M.phase === 'pointover' && !counted && M.lastWinner >= 0) {
      counted = true; st.pts++; lastPoint = D().simTime; if (M.lastWinner === 0) st.won++; st.rallies.push(M.pointHits || 0);
      const k = (M.lastWinner === 0 ? 'ganho: ' : 'perdido: ') + document.querySelector('#toast .b-title').textContent;
      st.why[k] = (st.why[k] || 0) + 1;
    }
    if (M.phase !== 'pointover') counted = false;
  }
  const avg = st.rallies.reduce((a, b) => a + b, 0) / st.rallies.length;
  const lobAvg = st.lobs.length ? +(st.lobs.reduce((a, b) => a + b, 0) / st.lobs.length).toFixed(1) : null;
  return { ganhos:Math.round(100 * st.won / st.pts) + '%', pancadasMedia:+avg.toFixed(1), pancadasMax:Math.max(...st.rallies), balaoMedio:lobAvg, balaoMax:Math.max(0, ...st.lobs), porque:st.why };
}
