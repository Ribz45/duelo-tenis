// Jogador automático para testar o modo online de ponta a ponta (dois separadores, dois perfis).
// Na consola de cada separador, com um jogo online a decorrer:
//   const bot = await import('./tests/online-bot.js'); bot.start(); … bot.status(); bot.stop();
// Corre em tempo real mesmo com o separador em segundo plano (MessageChannel não é travado como o requestAnimationFrame).
const D = () => window.__dt;
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
let run = null;

export function start({ timing = 0.05 } = {}) {
  stop();
  const { M, B, P } = D(), cv = document.getElementById('c');
  const pe = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId:9, clientX:x, clientY:y, bubbles:true, isPrimary:true, pointerType:'touch' }));
  const st = run = { on:true, last:performance.now(), swipes:0, serves:0, sched:null, lastId:-1, toss:null, errors:[] };
  const ch = new MessageChannel();
  addEventListener('error', e => st.errors.push(String(e.message)));
  ch.port1.onmessage = () => {
    if (!st.on) return;
    const now = performance.now(), dt = (now - st.last) / 1000;
    if (dt >= 0.016) {
      st.last = now;
      try {
        D().advance(Math.min(0.05, dt));
        if (M.mode === 'online' && M.phase !== 'over') act();
      } catch (e) { st.errors.push(String(e && e.message)); }
    }
    ch.port2.postMessage(0);
  };
  function act() {
    const me = P[M.me], sim = D().simTime;
    // serviço: lança e bate no ponto alto (com algum erro de tempo)
    if (M.phase === 'preserve' && M.server === M.me && !M.toss && !st.toss) { D().startToss(M.me); st.toss = { at:sim + 0.56 + gauss() * 0.04 }; }
    if (st.toss && M.toss && M.toss.idx === M.me && sim >= st.toss.at) {
      st.toss = null; st.serves++;
      D().releaseServe(M.me, D().serveTarget(M.me, (Math.random() - 0.5) * 1.6, 0.55 + Math.random() * 0.4));
    }
    if (M.phase !== 'preserve') st.toss = null;
    // devolver: swipe perto do instante ideal
    if (M.phase === 'rally' && B.live && B.hitter === (1 - M.me) && me.incoming && isFinite(me.incoming.absT) && st.lastId !== B.hitId) {
      st.lastId = B.hitId; st.sched = { t:me.incoming.absT + gauss() * timing, id:B.hitId };
    }
    if (st.sched && sim >= st.sched.t && B.hitId === st.sched.id) {
      st.sched = null; st.swipes++;
      const cx = innerWidth / 2, h = innerHeight, dx = (Math.random() - 0.5) * 120;
      pe('pointerdown', cx, h * 0.8); pe('pointermove', cx + dx * 0.5, h * 0.7); pe('pointerup', cx + dx, h * (0.6 - Math.random() * 0.15));
    }
  }
  ch.port2.postMessage(0);
  return 'bot a jogar';
}
export function stop() { if (run) run.on = false; run = null; return 'parado'; }
export function status() {
  const { M } = D();
  return { mode:M.mode, phase:M.phase, me:M.me, score:M.score.slice(), names:M.names, matchId:M.matchId, game:M.game,
    serves:run && run.serves, swipes:run && run.swipes, errors:run ? run.errors.slice(-5) : [], rtt:+(D().NET.rtt * 1000).toFixed(0), via:D().online.via() };
}
