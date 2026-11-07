// Som sintetizado com Web Audio (sem ficheiros): pancadas, ressaltos, rede, público e interface.
// O áudio só arranca depois do primeiro toque (regra dos browsers móveis).
let ctx = null, master = null, white = null, brown = null, bed = null;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const vary = (v, p) => v * (1 + (Math.random() * 2 - 1) * p);

export function unlock() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    master = ctx.createGain(); master.gain.value = 0.85;
    master.connect(comp).connect(ctx.destination);
    white = makeNoise(false); brown = makeNoise(true);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
// desbloqueia no primeiro toque em qualquer sítio
for (const ev of ['pointerdown', 'touchend', 'keydown']) addEventListener(ev, unlock, { passive:true });

function makeNoise(isBrown) {
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; if (isBrown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
  return b;
}
function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function noise(t, { freq, q = 1, vol, dur, type = 'bandpass', att = 0.002, buf = white, to = null }) {
  const s = ctx.createBufferSource(); s.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + att + dur);
  const g = ctx.createGain(); env(g, t, att, vol, dur);
  s.connect(f).connect(g).connect(master); s.start(t, Math.random() * 1.5); s.stop(t + att + dur + 0.05);
}
function tone(t, { f0, f1 = f0, vol, dur, type = 'sine', att = 0.003, dest = master }) {
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + att + dur);
  const g = ctx.createGain(); env(g, t, att, vol, dur);
  o.connect(g).connect(dest); o.start(t); o.stop(t + att + dur + 0.05);
}
const distGain = d => clamp(1.25 - d / 38, 0.12, 1);

export const sfx = {
  // pancada na bola: cordas + corpo da bola + grave, com variação de tom e volume
  hit(strength = 0.5, dist = 10, perfect = false) {
    if (!ctx) return;
    const t = ctx.currentTime, v = distGain(dist) * (0.4 + strength * 0.6), p = vary(1, 0.06) * (perfect ? 1.06 : 1);
    noise(t, { freq:2700 * p, q:1.3, vol:v * 0.8, dur:0.045 });
    tone(t, { f0:1180 * p, f1:430 * p, vol:v * 0.5, dur:0.065, type:'triangle' });
    tone(t, { f0:220 * p, f1:120, vol:v * (0.25 + strength * 0.25), dur:0.06 });
    if (perfect) noise(t + 0.004, { freq:5400, q:2.2, vol:v * 0.3, dur:0.035 });
  },
  whoosh(dist = 10) {
    if (!ctx) return;
    const t = ctx.currentTime;
    noise(t, { freq:500, to:2400, q:1.4, vol:distGain(dist) * 0.18, dur:0.16, att:0.05 });
  },
  bounce(surface, dist, speed) {
    if (!ctx) return;
    const t = ctx.currentTime, v = clamp(1.05 - dist / 45, 0.05, 0.75) * clamp(speed / 16, 0.25, 1);
    const S = { hard:{ f:250, n:2000, q:0.9 }, clay:{ f:165, n:650, q:0.7 }, grass:{ f:150, n:480, q:0.6 } }[surface] || { f:220, n:1500, q:0.8 };
    tone(t, { f0:vary(S.f, 0.07) * 1.7, f1:S.f * 0.7, vol:v * 0.75, dur:0.055 });
    noise(t, { freq:S.n, q:S.q, vol:v * (surface === 'clay' ? 0.6 : 0.4), dur:surface === 'clay' ? 0.07 : 0.035, type:'lowpass' });
  },
  net(dist, strength = 0.6) {
    if (!ctx) return;
    const t = ctx.currentTime, v = distGain(dist) * (0.3 + strength * 0.5);
    tone(t, { f0:120, f1:70, vol:v * 0.5, dur:0.09 });
    noise(t, { freq:1100, q:0.8, vol:v * 0.45, dur:0.28, att:0.01 });
    noise(t + 0.05, { freq:700, q:0.6, vol:v * 0.25, dur:0.3, att:0.02 });
  },
  // aplauso granular: muitas palmas curtas espalhadas no tempo
  applause(intensity = 0.5) {
    if (!ctx) return;
    const t0 = ctx.currentTime, dur = 1.1 + intensity * 1.8, n = Math.round(50 + intensity * 220);
    for (let i = 0; i < n; i++) {
      const u = Math.random(), at = t0 + 0.05 + Math.pow(u, 1.6) * dur;
      noise(at, { freq:vary(2300, 0.45), q:1.1, vol:(0.012 + Math.random() * 0.03) * (0.6 + intensity * 0.7) * (1 - u * 0.6), dur:0.022 });
    }
    noise(t0, { freq:900, q:0.5, vol:0.05 + intensity * 0.07, dur:dur * 0.9, att:0.25, buf:brown, type:'lowpass' });
  },
  // "uuuh" do público (bola por pouco, rede)
  ooh(intensity = 0.5) {
    if (!ctx) return;
    const t = ctx.currentTime, f = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.frequency.value = 380; f.Q.value = 3; f2.type = 'bandpass'; f2.frequency.value = 820; f2.Q.value = 4;
    const mix = ctx.createGain(); mix.gain.value = 1; f.connect(mix); f2.connect(mix); mix.connect(g).connect(master);
    env(g, t, 0.18, 0.08 + intensity * 0.12, 0.9);
    for (let i = 0; i < 7; i++) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      const base = vary(175, 0.18); o.frequency.setValueAtTime(base * 1.08, t); o.frequency.exponentialRampToValueAtTime(base * 0.86, t + 1.1);
      const og = ctx.createGain(); og.gain.value = 0.12; o.connect(og); og.connect(f); og.connect(f2); o.start(t); o.stop(t + 1.25);
    }
  },
  cheer(intensity = 0.8) { this.applause(intensity); if (ctx) noise(ctx.currentTime, { freq:1400, q:0.7, vol:0.05 + intensity * 0.05, dur:1.4, att:0.12, to:900 }); },
  ui(kind = 'tap') {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (kind === 'tap') tone(t, { f0:880, f1:760, vol:0.12, dur:0.05 });
    else if (kind === 'toggle') { tone(t, { f0:660, vol:0.08, dur:0.04 }); tone(t + 0.045, { f0:990, vol:0.08, dur:0.05 }); }
    else if (kind === 'back') tone(t, { f0:520, f1:400, vol:0.1, dur:0.07 });
    else if (kind === 'start') [523, 659, 784].forEach((f, i) => tone(t + i * 0.08, { f0:f, vol:0.1, dur:0.12, type:'triangle' }));
    else if (kind === 'win') [523, 659, 784, 1046].forEach((f, i) => tone(t + i * 0.1, { f0:f, vol:0.11, dur:0.18, type:'triangle' }));
    else if (kind === 'lose') [392, 330, 262].forEach((f, i) => tone(t + i * 0.12, { f0:f, vol:0.09, dur:0.16, type:'triangle' }));
  },
  // murmúrio de fundo do estádio durante o jogo
  crowdBed(on) {
    if (!ctx) return;
    if (on && !bed) {
      const s = ctx.createBufferSource(); s.buffer = brown; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.4;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 1.2);
      s.connect(f).connect(g).connect(master); s.start(); bed = { s, g };
    } else if (!on && bed) {
      const b = bed; bed = null; b.g.gain.cancelScheduledValues(ctx.currentTime);
      b.g.gain.setValueAtTime(b.g.gain.value, ctx.currentTime); b.g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6); b.s.stop(ctx.currentTime + 0.7);
    }
  },
  // silêncio do público durante o ponto (como no ténis a sério)
  hush(on) { if (bed && ctx) { bed.g.gain.cancelScheduledValues(ctx.currentTime); bed.g.gain.setTargetAtTime(on ? 0.012 : 0.05, ctx.currentTime, 0.4); } },
};
