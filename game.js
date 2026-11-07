import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { Athlete, LOOK_PRESETS, TRACK_END } from './player3d.js?v=3';
import { FX } from './fx.js?v=3';
import { sfx, unlock } from './audio.js?v=3';
import { HL, HW, SVC, BR, serverFor, servePositions as rulePositions, judgeFirstBounce, isMatchOver, matchPointFor, outBy } from './rules.js?v=3';

// ---------------------------------------------------------------- constantes
const DW = 5.485, NET_H = 0.914, GRAV = 9.81;
const STEP = 1 / 120, PLANE = 0.45, RUN_SPEED = 6.2, WALK_SPEED = 2.4;
const TOSS_Y0 = 1.3, TOSS_V = 5.1, T_IDEAL = 0.56, T_FAIL = 1.05;   // contacto ideal a ≈2,6 m, onde a raquete chega
const SURFACES = {
  hard:  { label:'Piso rápido', court:0x2b64ad, outer:0x37805a, e:0.68, f:0.80 },
  clay:  { label:'Terra batida', court:0xc0623a, outer:0xb3592f, e:0.72, f:0.72 },
  grass: { label:'Relva', court:0x5a9a3a, outer:0x4b8731, e:0.6, f:0.86 },
};
const LEVELS = [
  { label:'Fácil',   q:0.45, speed:4.4, react:0.42, pow:[0.2, 0.45], width:1.8, depth:[6.8, 9.2],  svSig:0.13, svPow:0.45, miss:0.22 },
  { label:'Médio',   q:0.66, speed:5.2, react:0.28, pow:[0.35, 0.7], width:2.8, depth:[7.5, 10.3], svSig:0.08, svPow:0.7,  miss:0.14 },
  { label:'Difícil', q:0.84, speed:6.0, react:0.16, pow:[0.55, 0.9], width:3.5, depth:[8.4, 11.0], svSig:0.05, svPow:0.9,  miss:0.08 },
];
const HELPS = {
  total:  { label:'Total',  green:0.12, auto:true,  recover:true,  assist:99,  preview:true,  marker:true,  err:0.65, reach:1.9 },
  normal: { label:'Normal', green:0.09, auto:false, recover:false, assist:4.5, preview:true,  marker:true,  err:1.0,  reach:1.65 },
  pro:    { label:'Pro',    green:0.06, auto:false, recover:false, assist:0,   preview:false, marker:false, err:1.12, reach:1.5 },
};
const TOUR = [
  { round:'Quartos-de-final', opp:'Tiago Rocha',   level:0, surface:'clay',  look:2 },
  { round:'Meias-finais',     opp:'Lucas Moreau',  level:1, surface:'grass', look:3 },
  { round:'Final',            opp:'Andrei Volkov', level:2, surface:'hard',  look:4 },
];

const $ = id => document.getElementById(id);
const V3 = THREE.Vector3;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const store = {
  get(k, d) { try { const v = localStorage.getItem('dt_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('dt_' + k, JSON.stringify(v)); } catch (e) {} },
};

// ---------------------------------------------------------------- som (audio.js)
const audio = unlock;
const buzz = ms => { try { if (navigator.vibrate && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate(ms); } catch (e) {} };

// ---------------------------------------------------------------- cena 3D
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 220);
scene.add(new THREE.HemisphereLight(0xe4f0ff, 0x3a4636, 1.05));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.7);
sun.position.set(-9, 22, 7); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left:-16, right:16, top:20, bottom:-20, near:1, far:60 });
sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
scene.add(sun);

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
// céu de dia em gradiente
scene.background = canvasTex(4, 256, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#4f8fcb'); gr.addColorStop(0.55, '#8fbde3'); gr.addColorStop(1, '#d5e6f2');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
scene.fog = new THREE.Fog(0xbcd5ea, 60, 120);

// público: filas de cadeiras com espectadores, cores sóbrias, sombra da cobertura no topo
const SHIRTS = ['#eef1f5', '#d4dce6', '#2c3e5c', '#5a7aa6', '#9fb7d4', '#d9c9a8', '#b3473f', '#e0b84a', '#3d6b4f', '#7a6a8f', '#f2f2f2', '#1f2a3d'];
const SKINS = ['#f1c9a5', '#e0b48f', '#c68a5e', '#8d5a3b', '#f5d6bc'];
const crowdCanvasTex = canvasTex(512, 256, (g, w, h) => {
  g.fillStyle = '#121d31'; g.fillRect(0, 0, w, h);
  for (let row = 0; row < 19; row++) {
    const y = 4 + row * 13.5;
    g.fillStyle = row % 2 ? '#1c3051' : '#192b49'; g.fillRect(0, y + 7, w, 6);
    for (let x = 1 + (row % 2) * 4; x < w; x += 9.5) {
      if (Math.random() < 0.2) continue;
      const cx = x + Math.random() * 1.5;
      g.fillStyle = SHIRTS[(Math.random() * SHIRTS.length) | 0];
      g.beginPath(); g.roundRect ? g.roundRect(cx, y + 4, 7.5, 9, 3) : g.rect(cx, y + 4, 7.5, 9); g.fill();
      g.fillStyle = SKINS[(Math.random() * SKINS.length) | 0];
      g.beginPath(); g.arc(cx + 3.75, y + 2, 2.6, 0, Math.PI * 2); g.fill();
      if (Math.random() < 0.18) { g.fillStyle = Math.random() < 0.5 ? '#f4f4f4' : '#22324d'; g.fillRect(cx + 1, y - 1.2, 5.5, 1.8); }
    }
  }
  const gr = g.createLinearGradient(0, 0, 0, h * 0.4);
  gr.addColorStop(0, 'rgba(4,10,22,.6)'); gr.addColorStop(1, 'rgba(4,10,22,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h * 0.4);
});
function adCanvas() {
  return canvasTex(1024, 64, (g, w, h) => {
    g.fillStyle = '#0b1f3a'; g.fillRect(0, 0, w, h);
    const items = [['DUELO TÉNIS', '#d7f34a'], ['TIE-BREAK A 10', '#ffffff'], ['JOGA COM AMIGOS', '#ffffff'], ['SERVIÇO · RESPOSTA · PONTO', '#9fc2ea']];
    g.font = "800 34px 'Barlow Condensed', 'Arial Narrow', sans-serif"; g.textBaseline = 'middle';
    let x = 18;
    for (let k = 0; x < w; k++) {
      const [t, c] = items[k % items.length];
      g.fillStyle = c; g.fillText(t, x, h / 2 + 2); x += g.measureText(t).width + 26;
      g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x - 14, 14, 2, h - 28); x += 12;
    }
  });
}
let adTex = adCanvas();
const netTex = canvasTex(128, 64, (g, w, h) => {
  g.strokeStyle = 'rgba(20,20,22,.88)'; g.lineWidth = 1.3;
  for (let x = 0; x <= w; x += 6) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y <= h; y += 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
});
netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping; netTex.repeat.set(10, 1);
// grão do piso (cinzento à volta de 1, multiplica a cor do piso)
function grainTex(kind) {
  const t = canvasTex(256, 256, (g, w, h) => {
    const img = g.createImageData(w, h), d = img.data, amp = kind === 'clay' ? 14 : kind === 'grass' ? 16 : 8;
    for (let i = 0; i < d.length; i += 4) { const v = 236 + (Math.random() * 2 - 1) * amp; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    if (kind === 'clay') for (let i = 0; i < 70; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.06)'; g.fillRect(0, Math.random() * h, w, 1 + Math.random() * 2); }
    if (kind === 'grass') for (let i = 0; i < 900; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)'; g.fillRect(Math.random() * w, Math.random() * h, 1, 3 + Math.random() * 4); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
// desgaste junto à linha de fundo (onde os jogadores pisam mais)
const wearTex = canvasTex(256, 256, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
const WEAR = { hard:[0x6f9bd4, 0.22], clay:[0xe7a479, 0.4], grass:[0xa8935e, 0.62] };

const lam = c => new THREE.MeshLambertMaterial({ color:c });
let courtGroup = null, courtKey = null;
function buildCourt(key) {
  if (courtKey === key) return;
  if (courtGroup) scene.remove(courtGroup);
  courtKey = key;
  const S = SURFACES[key], g = new THREE.Group();
  const flat = (w, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true; g.add(m); return m; };
  const grain = grainTex(key), outerGrain = grain.clone();
  outerGrain.repeat.set(20, 26); outerGrain.needsUpdate = true; grain.repeat.set(4, 8);
  flat(60, 80, new THREE.MeshLambertMaterial({ color:S.outer, map:outerGrain }), 0, 0, 0);
  flat(DW * 2 + 0.1, HL * 2 + 0.1, new THREE.MeshLambertMaterial({ color:S.court, map:grain }), 0, 0.001, 0);
  if (key === 'grass') {
    const light = new THREE.MeshLambertMaterial({ color:0x6aad48, map:grain, transparent:true, opacity:0.55 });
    for (let i = 0; i < 16; i++) if (i % 2) flat(DW * 2 + 6, 2.6, light, 0, 0.0015, -20.8 + i * 2.6);
  }
  const wm = new THREE.MeshLambertMaterial({ color:WEAR[key][0], map:wearTex, transparent:true, opacity:WEAR[key][1], depthWrite:false });
  for (const sz of [-1, 1]) { flat(5.2, 3.4, wm, 0, 0.0018, sz * (HL - 0.2)); flat(2.4, 1.6, wm, 0, 0.0019, sz * (HL + 1.4)); }
  const lm = new THREE.MeshBasicMaterial({ color:0xf3f3ee });
  const line = (x1, z1, x2, z2, w = 0.05) => {
    const vert = x1 === x2, len = vert ? Math.abs(z2 - z1) : Math.abs(x2 - x1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(vert ? w : len + w, vert ? len + w : w), lm);
    m.rotation.x = -Math.PI / 2; m.position.set((x1 + x2) / 2, 0.003, (z1 + z2) / 2); g.add(m);
  };
  line(-DW, -HL, DW, -HL, 0.09); line(-DW, HL, DW, HL, 0.09);
  line(-DW, -HL, -DW, HL); line(DW, -HL, DW, HL); line(-HW, -HL, -HW, HL); line(HW, -HL, HW, HL);
  line(-HW, -SVC, HW, -SVC); line(-HW, SVC, HW, SVC); line(0, -SVC, 0, SVC);
  line(0, -HL, 0, -HL + 0.18); line(0, HL, 0, HL - 0.18);
  // rede: postes, malha, fita e cinta central
  const NW = DW + 0.914, dark = lam(0x173a2a);
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 1.07, 12), dark); p.position.set(sx * NW, 0.535, 0); p.castShadow = true; g.add(p);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), dark); cap.position.set(sx * NW, 1.07, 0); g.add(cap);
  }
  const net = new THREE.Mesh(new THREE.PlaneGeometry(NW * 2, NET_H, 60, 8), new THREE.MeshBasicMaterial({ map:netTex, transparent:true, side:THREE.DoubleSide, depthWrite:false }));
  net.position.set(0, NET_H / 2, 0); g.add(net); fx.setNet(net);
  const white = new THREE.MeshLambertMaterial({ color:0xf7f7f7 });
  const band = new THREE.Mesh(new THREE.BoxGeometry(NW * 2, 0.07, 0.03), white);
  band.position.set(0, NET_H - 0.035, 0); band.castShadow = true; g.add(band);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, NET_H, 0.025), white); strap.position.set(0, NET_H / 2, 0); g.add(strap);
  // cadeira do árbitro (lado direito) e bancos dos jogadores (lado esquerdo)
  const ump = new THREE.Group(), frame = lam(0x1d4433), navy = lam(0x14284a), skin = lam(0xe0b48f);
  for (const lx of [-0.3, 0.3]) for (const lz of [-0.3, 0.3]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.9, 0.06), frame); leg.position.set(lx, 0.95, lz); leg.castShadow = true; ump.add(leg); }
  const plat = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.08, 0.85), frame); plat.position.y = 1.9; plat.castShadow = true; ump.add(plat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.7), frame); back.position.set(0.36, 2.3, 0); ump.add(back);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.55, 0.42), navy); torso.position.set(0.12, 2.25, 0); torso.castShadow = true; ump.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), skin); head.position.set(0.1, 2.66, 0); ump.add(head);
  const thighs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.36), lam(0x2b2f38)); thighs.position.set(-0.08, 2.0, 0); ump.add(thighs);
  ump.position.set(NW + 1.0, 0, 0); g.add(ump);
  for (const bz of [-2.2, 2.2]) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 1.6), navy); bench.position.set(-(NW + 1.6), 0.225, bz); bench.castShadow = true; g.add(bench);
    const towel = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.32), white); towel.position.set(-(NW + 1.55), 0.47, bz + 0.4); g.add(towel);
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), lam(0xd7f34a)); bottle.position.set(-(NW + 1.5), 0.56, bz - 0.4); g.add(bottle);
  }
  // bancadas, placards e cobertura
  const crowdMat = w => { const t = crowdCanvasTex.clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(w / 9, 2.2); t.needsUpdate = true; return new THREE.MeshLambertMaterial({ map:t }); };
  const adMat = w => { const t = adTex.clone(); t.wrapS = THREE.RepeatWrapping; t.repeat.set(w / 16, 1); t.needsUpdate = true; return new THREE.MeshBasicMaterial({ map:t, toneMapped:false }); };
  const roofMat = lam(0x0b1a30);
  const stand = (width, rotY, dist, wallDist) => {
    const sg = new THREE.Group();
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(width, 12), crowdMat(width));
    pl.rotation.x = -0.62; pl.position.set(0, 5.4, -dist); sg.add(pl);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(width, 0.6, 4), roofMat); roof.position.set(0, 10.6, -dist - 4.2); sg.add(roof);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, 1.0, 0.2), adMat(width));
    wall.position.set(0, 0.5, -wallDist); sg.add(wall);
    const apron = new THREE.Mesh(new THREE.BoxGeometry(width, 0.9, 0.2), lam(0x0e2340)); apron.position.set(0, 0.45, -dist + 4.2); sg.add(apron);
    sg.rotation.y = rotY; g.add(sg);
  };
  stand(46, 0, HL + 13, HL + 6.2);
  stand(46, Math.PI, HL + 13, HL + 6.2);
  stand(60, Math.PI / 2, DW + 8, DW + 4.2);
  stand(60, -Math.PI / 2, DW + 8, DW + 4.2);
  scene.add(g); courtGroup = g;
}
// os placards usam a fonte condensada: redesenha quando a fonte carregar
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { adTex = adCanvas(); const k = courtKey; courtKey = null; if (k) buildCourt(k); });

// bola, sombra, rasto, marcadores, mira e trajetória
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshStandardMaterial({ color:0xd9f53c, emissive:0x3a4a00, roughness:0.6 }));
scene.add(ballMesh);
const blob = new THREE.Mesh(new THREE.CircleGeometry(0.11, 20), new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:0.35, depthWrite:false }));
blob.rotation.x = -Math.PI / 2; blob.renderOrder = 3; scene.add(blob);
const fx = new FX(scene);
const UP = new V3(0, 1, 0), _dir = new V3();
const squash = { t:1, k:1, axis:new V3(0, 1, 0) };
let hitStopUntil = 0;
function ringMesh(color, r1, r2) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r1, r2, 40), new THREE.MeshBasicMaterial({ color, transparent:true, opacity:0, depthWrite:false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.006; m.renderOrder = 2; scene.add(m); return m;
}
const tapRing = ringMesh(0xffffff, 0.28, 0.36);
const landRing = ringMesh(0xd7f34a, 0.16, 0.26);
const aimRing = ringMesh(0xffffff, 0.86, 1.0);
const aimDot = ringMesh(0xffffff, 0, 0.09);
const PREV_N = 30;
const prevGeo = new THREE.BufferGeometry(); prevGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREV_N * 3), 3));
const prevLine = new THREE.Line(prevGeo, new THREE.LineDashedMaterial({ color:0xffffff, dashSize:0.3, gapSize:0.2, transparent:true, opacity:0.85 }));
prevLine.frustumCulled = false; prevLine.visible = false; scene.add(prevLine);

// ---------------------------------------------------------------- estado
const sideOf = i => (i === 0 ? 1 : -1);
const other = i => 1 - i;
function newPlayer(idx) {
  return { idx, side:sideOf(idx), pos:{ x:0, z:sideOf(idx) * (HL + 0.5) }, mv:{ x:0, z:0 }, vel:{ x:0, z:0 }, target:null, walk:false,
    pp:{ x:0, z:sideOf(idx) * (HL + 0.5) }, isCPU:false, remote:false, netPos:null, swipe:null, prevD:null, crossT:null, whiff:false, act:null,
    incoming:null, incAt:-1, autoPlan:null, manualId:-1, ai:{ planId:-1, planAt:0, plan:null }, fig:null };
}
const P = [newPlayer(0), newPlayer(1)];
P[0].fig = new Athlete(scene, LOOK_PRESETS[0]);
P[1].fig = new Athlete(scene, LOOK_PRESETS[1]);

const M = { mode:'menu', me:0, level:1, surface:'hard', help:'normal', names:['Tu', 'CPU'], score:[0, 0], first:0, server:0,
  serveNum:1, phase:'idle', boxSign:-1, tourRound:0, pointsPlayed:0, wantRematch:false, remoteRematch:false,
  toss:null, lastWinner:-1, pointEndT:-9, tips:{}, counts:{} };
const B = { p:new V3(0, 1, 0), pp:new V3(0, 1, 0), v:new V3(), g:GRAV, spin:0, bounces:0, hitter:-1, isServe:false, live:false, held:false, netHit:false, hitId:0 };
let simTime = 0;
const timers = [];
const after = (sec, fn) => timers.push({ t:simTime + sec, fn });
function runTimers(force) {
  for (let i = 0; i < timers.length; i++) {
    if (force || timers[i].t <= simTime) { const t = timers.splice(i, 1)[0]; i--; t.fn(); }
  }
}
const inMatch = () => M.mode !== 'menu';
const authority = () => M.mode !== 'online' || (B.hitter >= 0 && other(B.hitter) === M.me);
const H = () => HELPS[M.help] || HELPS.normal;
const errMul = idx => (M.mode === 'online' || idx !== M.me) ? 1 : H().err;
const greenWin = () => (M.mode === 'online' ? HELPS.normal.green : H().green);
const reachOf = pl => (pl.isCPU || pl.remote || M.mode === 'online') ? 1.6 : H().reach;
// dentro do verde = perfeito; no amarelo (≈0,16 s à volta) continua "Bom"; depois cai devagar
function timingQ(err, g) { const a = Math.abs(err); return a <= g ? 1 : clamp(0.92 - (a - g) / 0.34, 0, 0.92); }
function timingLabel(q, err) { if (q >= 1) return 'Perfeito'; if (q >= 0.65) return 'Bom'; if (q >= 0.3) return err < 0 ? 'Cedo' : 'Tarde'; return err < 0 ? 'Muito cedo' : 'Muito tarde'; }
const tossY = t => TOSS_Y0 + TOSS_V * t - 0.5 * GRAV * t * t;

// ---------------------------------------------------------------- física
function solve(from, tx, tz, T, g) {
  return new V3((tx - from.x) / T, (BR - from.y + 0.5 * g * T * T) / T, (tz - from.z) / T);
}
function netClearance(from, v, g) {
  if (Math.abs(v.z) < 1e-6) return 99;
  const tn = -from.z / v.z; if (tn <= 0) return 99;
  return from.y + v.y * tn - 0.5 * g * tn * tn - NET_H;
}
function makeShot(from, tx, tz, speedH, g, margin) {
  let T = Math.hypot(tx - from.x, tz - from.z) / speedH, v;
  for (let i = 0; i < 60; i++) { v = solve(from, tx, tz, T, g); if (netClearance(from, v, g) >= margin) break; T *= 1.035; }
  return v;
}
function predictBall(maxT = 3) {
  const out = [], p = B.p.clone(), v = B.v.clone(), S = SURFACES[M.surface], dt = 1 / 60;
  let g = B.g, b = B.bounces, sp = B.spin;
  for (let t = dt; t <= maxT; t += dt) {
    v.y -= g * dt; p.addScaledVector(v, dt);
    if (p.y < BR && v.y < 0) { p.y = BR; sp = bounceVel(v, sp, S); g = GRAV; b++; if (b > 2) break; }
    out.push({ x:p.x, y:p.y, z:p.z, vz:v.z, t, b });
  }
  return out;
}
// ressalto com efeito: o topspin salta mais e conserva velocidade; o efeito gasta-se no ressalto
function bounceVel(v, spin, S) {
  v.y = -v.y * (S.e + spin * 0.06);
  const f = Math.min(0.95, S.f + spin * 0.07);
  v.x *= f; v.z *= f;
  return spin * 0.4;
}
const fhSide = (pl, x) => ((x ?? B.p.x) - pl.pos.x) * pl.side >= 0;

function launch(idx, from, v, g, isServe, fromNet, q = 0.7, spin = 0.3) {
  const volley = !isServe && B.bounces === 0 && B.hitter >= 0;
  const fh = fhSide(P[idx], from.x);
  B.p.copy(from); B.pp.copy(from); B.v.copy(v); B.g = g; B.spin = spin; B.bounces = 0; B.hitter = idx; B.isServe = isServe;
  B.live = true; B.held = false; B.netHit = false; B.netCord = false; B.hitId++;
  M.phase = 'rally'; M.toss = null;
  for (const pl of P) { pl.prevD = null; pl.crossT = null; pl.whiff = false; pl.swipe = null; pl.incoming = null; pl.autoPlan = null; }
  P[idx].act = { type:isServe ? 'sv' : volley ? (fh ? 'vf' : 'vb') : (fh ? 'fh' : 'bh'), t:0, phase:'swing',
    h:isServe ? undefined : from.y, lat:Math.abs(from.x - P[idx].pos.x) };
  const speed = v.length(), strong = isServe ? speed > 41 : speed > 21.5;
  sfx.hit(clamp((speed - 8) / 30, 0, 1), camera.position.distanceTo(from), q >= 1);
  squash.t = 0; squash.k = 0.7; squash.axis.copy(v).normalize();
  if (strong && q >= 0.9 && (M.mode !== 'online' || idx === M.me)) hitStopUntil = last + (isServe ? 55 : 40);
  if (from.y > 1.9 && !isServe && speed > 20) fx.shake(0.06, 0.25);      // smash
  if (isServe) sfx.hush(true);
  M.pointHits = (M.pointHits || 0) + 1;
  P[other(idx)].splitAt = simTime;
  if (idx === M.me) {
    buzz(q >= 1 ? 30 : 14);
    if (H().recover && !isServe) { const me = P[idx]; me.target = { x:0, z:me.side * (HL + 0.5) }; me.walk = false; }
  } else M.lastMine = {};
  if (M.mode === 'online' && idx === M.me && !fromNet) netSend({ t:'hit', p:[from.x, from.y, from.z], v:[v.x, v.y, v.z], g, s:isServe ? 1 : 0, sp:spin });
  landRing.material.opacity = 0;
  if (idx !== M.me && H().marker) {
    const fb = predictBall(3).find(s => s.b === 1);
    if (fb && Math.sign(fb.z) === sideOf(M.me)) { landRing.position.set(fb.x, 0.006, fb.z); landRing.material.opacity = 0.8; }
  }
}

// pancada: alvo escolhido (tx,tz), potência e qualidade do tempo → trajetória com erro
function shotSpec(type, power, q, volley) {
  if (type === 'lob') return { speedH:7.5 + power * 2.8, g:GRAV + 0.6, margin:1.8 };
  return { speedH:10 + power * 8.5 + q * 2 - (volley ? 1.5 : 0), g:GRAV + 2.5 + power * 4, margin:0.6 - power * 0.35 };
}
function executeShot(idx, sh) {
  const pl = P[idx], s = pl.side, r = -s;
  const from = B.p.clone(); if (from.y < 0.3) from.y = 0.3;
  const press = clamp((B.v.length() - 15) / 18, 0, 1);
  const spec = shotSpec(sh.type, sh.power, sh.q, B.bounces === 0);
  const em = errMul(idx), q = sh.q;
  const sig = (sh.type === 'lob' ? 0.3 + (1 - q) * 1.1 + press * 0.35 : 0.1 + (1 - q) * 1.3 + sh.power * 0.35 + press * 0.45) * em;
  const pull = Math.sign(sh.err || 0) * (fhSide(pl) ? 1 : -1) * s * (1 - q) * 0.9 * em;
  const tx = sh.tx + gauss() * sig + pull;
  const tz = sh.tz + r * (gauss() * sig * 0.85 + (1 - q) * 0.35 * Math.random() * em);
  const margin = sh.margin ?? (spec.margin - Math.random() * (1 - q) * 0.9 * em - press * Math.random() * 0.2);
  const v = makeShot(from, tx, tz, spec.speedH, spec.g, margin);
  launch(idx, from, v, spec.g, false, false, q, sh.type === 'lob' ? 0.2 : 0.35 + sh.power * 0.6);
  return v;
}

// ---------------------------------------------------------------- serviço: lançar, apontar, largar no verde
function serveTarget(idx, ax, ad) {
  const s = sideOf(idx), r = -s;
  return { tx:M.boxSign * HW / 2 + s * ax * HW * 0.42, tz:r * SVC * (0.45 + 0.5 * ad), ax, ad };
}
function startToss(idx, cpuAim) {
  if (M.phase !== 'preserve' || M.server !== idx || M.toss) return;
  M.toss = { idx, t0:simTime, aim:cpuAim || null, releaseAt:null };
  B.held = false;
  if (cpuAim) M.toss.releaseAt = T_IDEAL + gauss() * LEVELS[M.level].svSig;
  if (M.mode === 'online' && idx === M.me) netSend({ t:'toss' });
}
function failToss() {
  const idx = M.toss.idx; M.toss = null; B.held = true;
  if (idx === M.me) { toast('Lança outra vez', 'info', 'Larga o dedo quando a bola estiver no verde', 1100); touch.mode = null; hideAim(); }
  else if (P[idx].isCPU) after(0.8, cpuServe);
}
function releaseServe(idx, aim) {
  if (!M.toss || M.toss.idx !== idx || M.phase !== 'preserve') return;
  const tt = simTime - M.toss.t0;
  if (tt < 0.28) { M.toss = null; B.held = true; if (idx === M.me) toast('Segura mais', 'info', 'Larga quando a bola estiver lá em cima', 1000); return; }
  const err = tt - T_IDEAL, q = timingQ(err, greenWin());
  const pl = P[idx], s = pl.side, r = -s, second = M.serveNum === 2;
  const from = new V3(pl.pos.x - s * 0.1, tossY(tt), pl.pos.z - s * 0.35);
  const sig = (0.07 + (1 - q) * 0.75) * (second ? 0.55 : 1) * errMul(idx);
  const tx = aim.tx + gauss() * sig;
  const tz = aim.tz + r * (gauss() * sig + (1 - q) * 0.3 * (Math.random() - 0.3));
  const lvl = pl.isCPU ? 0.62 + 0.3 * LEVELS[M.level].svPow : 1;
  const speed = (second ? 20 + q * 6 : 25 + q * 17 + aim.ad * 1.5) * lvl;
  const g = second ? GRAV + 7 : GRAV + 2;
  const margin = second ? 0.45 : 0.1 + (1 - q) * 0.15 - Math.random() * (1 - q) * 0.35;
  const v = makeShot(from, tx, tz, speed, g, margin);
  launch(idx, from, v, g, true, false, q, second ? 0.9 : 0.2);
  const kmh = Math.round(v.length() * 3.6);
  popText(kmh + ' km/h', 'info', new V3(pl.pos.x, 2.4, pl.pos.z));
  if (idx === M.me) {
    M.lastMine = { q, err, power:q, type:'serve' };
    shotInfo((second ? '2.º serviço' : 'Serviço') + ' · ' + kmh + ' km/h', q, err);
    popText(timingLabel(q, err), qCls(q), new V3(pl.pos.x, 1.7, pl.pos.z));
  }
}

// ---------------------------------------------------------------- bola e regras
function stepBall(dt) {
  const pz = B.p.z;
  B.v.y -= B.g * dt;
  B.p.addScaledVector(B.v, dt);
  if (!B.netHit && pz !== 0 && Math.sign(pz) !== Math.sign(B.p.z)) {
    if (Math.abs(B.p.x) < DW + 0.914 && B.p.y < NET_H + BR && B.p.y > NET_H - 0.045 && !B.netCord) {
      // toca na fita e passa: a bola perde velocidade e salta por cima
      B.netCord = true; B.p.y = NET_H + BR + 0.01; B.v.z *= 0.42; B.v.x *= 0.7; B.v.y = Math.abs(B.v.y) * 0.25 + 0.7;
      sfx.net(camera.position.distanceTo(B.p), 0.35); sfx.ooh(0.55);
      fx.netHit(B.p.x, 0.4, -Math.sign(pz));
    } else if (Math.abs(B.p.x) < DW + 0.914 && B.p.y < NET_H + BR) {
      B.netHit = true; B.p.z = Math.sign(pz) * 0.07; B.v.z *= -0.12; B.v.x *= 0.3; B.v.y = Math.min(B.v.y, 0) * 0.3;
      sfx.net(camera.position.distanceTo(B.p), clamp(B.v.length() / 25, 0.2, 1));
      fx.netHit(B.p.x, clamp(Math.abs(B.v.z) / 25, 0.2, 1), -Math.sign(pz));
      if (M.phase === 'rally' && authority()) { if (B.isServe) callFault('Rede'); else endPoint(other(B.hitter), 'Rede!'); }
    }
  }
  if (B.p.y < BR && B.v.y < 0) {
    const S = SURFACES[M.surface];
    B.p.y = BR; B.spin = bounceVel(B.v, B.spin, S); B.g = GRAV;
    if (Math.abs(B.v.y) < 0.5) B.v.y = 0;
    B.bounces++;
    if (B.bounces <= 2) {
      const hs = Math.hypot(B.v.x, B.v.z), dn = hs > 0.01 ? 1 / hs : 0;
      sfx.bounce(M.surface, camera.position.distanceTo(B.p), Math.hypot(hs, B.v.y));
      fx.dust(B.p, M.surface, clamp(hs / 20, 0.15, 1), B.v.x * dn, B.v.z * dn);
      fx.mark(B.p, M.surface, B.v.x * dn, B.v.z * dn);
      squash.t = 0; squash.k = 0.6; squash.axis.set(0, 1, 0);
      landRing.material.opacity = 0;
    }
    if (!B.netHit && M.phase === 'rally' && authority()) judgeBounce();
  }
  if (B.v.y === 0 && B.p.y <= BR + 1e-3) B.v.multiplyScalar(0.98);
}
function judgeBounce() {
  const hit = B.hitter, rc = other(hit), rs = sideOf(rc), x = B.p.x, z = B.p.z;
  if (B.bounces === 1) {
    const call = judgeFirstBounce({ x, z, isServe:B.isServe, receiverSide:rs, boxSign:M.boxSign });
    if (B.isServe) {
      if (call === 'in' && B.netCord) callLet();
      else if (call !== 'in') callFault(call === 'fault-long' ? 'Falta · longa' : 'Falta');
    } else if (call === 'out') {
      if (Math.sign(z) === rs && outBy(x, z) < 0.3) sfx.ooh(0.7);
      endPoint(rc, 'Fora!');
    }
  } else if (B.bounces === 2) {
    endPoint(hit, B.isServe ? 'Ás!' : 'Ponto!');
  }
}
const computeServer = () => serverFor(M.score, M.first);
const servePositions = () => rulePositions(M.score, M.first);
function preparePoint() { M.server = computeServer(); M.serveNum = 1; resetForServe(); }
function resetForServe() {
  timers.length = 0;
  const sp = servePositions();
  M.boxSign = sp.boxSign;
  placePlayer(sp.sv, sp.svPos.x, sp.svPos.z);
  placePlayer(sp.rc, sp.rcPos.x, sp.rcPos.z);
  B.live = false; B.held = true; B.hitter = -1; B.bounces = 0; B.isServe = false; B.netHit = false;
  M.toss = null; M.lastWinner = -1;
  landRing.material.opacity = 0; M.pointHits = 0; sfx.hush(false);
  P.forEach(p => { p.act = null; p.incoming = null; });
  M.phase = 'preserve';
  if (P[M.server].isCPU) after(1.3 + Math.random() * 0.7, cpuServe);
  updateHUD(); updateHint();
}
function placePlayer(i, x, z) { const p = P[i]; p.pos.x = p.pp.x = x; p.pos.z = p.pp.z = z; p.target = null; p.walk = false; p.mv.x = p.mv.z = 0; p.netPos = null; p.swipe = null; }

function endPoint(w, reason) {
  if (M.phase !== 'rally') return;
  if (M.mode === 'online') netSend({ t:'point', w, r:reason });
  applyPoint(w, reason);
}
function applyPoint(w, reason) {
  timers.length = 0;
  const myShotErr = B.hitter === M.me && w !== M.me;
  if (myShotErr && reason === 'Fora!') countTip('out', 2, 'Bolas fortes e perto das linhas saem mais. Arrasta menos para cima ou aponta mais para dentro do campo.');
  if (myShotErr && reason === 'Rede!') countTip('net', 1, 'Bateste na rede. Larga no verde e evita bolas curtas e fortes: arrasta mais para cima para dar altura.');
  if (reason === 'Ponto!' && w !== M.me && B.hitter !== M.me && !P[M.me].swipe) countTip('move', 2, 'Toca no sítio para onde queres correr. A mancha amarela mostra onde a bola vai bater.');
  M.phase = 'pointover'; M.score[w]++; M.pointsPlayed++;
  M.lastWinner = w; M.pointEndT = simTime; M.toss = null;
  landRing.material.opacity = 0;
  const mine = w === M.me;
  if (mine && reason === 'Ponto!' && B.hitter === M.me) reason = 'Vencedor!';
  let sub = mine ? explainWin(reason) : explainLoss(reason);
  const over = isMatchOver(M.score);
  if (!over && matchPointFor(M.score) !== -1) sub += ' · Match point';
  toast(reason, mine ? 'good' : 'bad', sub, 1300);
  sfx.hush(false);
  const big = reason === 'Ás!' || reason === 'Vencedor!';
  if (reason === 'Ás!') fx.shake(0.1, 0.4);
  if (big) sfx.cheer(clamp(0.45 + (M.pointHits || 0) * 0.05, 0.5, 1));
  else sfx.applause(clamp(0.2 + (M.pointHits || 0) * 0.06, 0.2, 0.9));
  updateHUD();
  if (!over) after(1.0, walkToPositions);
  after(2.3, () => { if (over) finishMatch(); else preparePoint(); });
}
// explicar porque o ponto acabou (do ponto de vista do jogador local)
function explainWin(reason) {
  const foe = M.names[other(M.me)];
  if (reason === 'Vencedor!') return foe + ' não chegou à bola';
  if (reason === 'Fora!' || reason === 'Rede!') return 'Erro de ' + foe;
  if (reason === 'Ás!') return 'Serviço sem resposta';
  if (reason === 'Dupla falta') return foe + ' fez dupla falta';
  return 'Ponto para ti';
}
function explainLoss(reason) {
  const L = M.lastMine || {}, mineShot = B.hitter === M.me;
  const timing = L.q !== undefined && L.q < 0.65 ? (L.err < 0 ? 'largaste cedo' : 'largaste tarde') : null;
  if (reason === 'Fora!' && mineShot) {
    const where = Math.abs(B.p.z) > HL ? 'Bola longa' : 'Bola larga';
    return where + ' · ' + (timing || (L.power > 0.8 ? 'potência a mais' : 'arriscaste perto da linha'));
  }
  if (reason === 'Rede!' && mineShot) return 'Na rede · ' + (timing || 'bola baixa e forte: arrasta mais para cima');
  if (reason === 'Ás!') return 'Não devolveste o serviço';
  if (reason === 'Dupla falta') return 'Dupla falta · no 2.º serviço larga no verde';
  if (reason === 'Ponto!') return L.whiff ? L.whiff : 'Não chegaste à bola · toca para correr';
  return 'Ponto para ' + M.names[other(M.me)];
}
function walkToPositions() {
  const sp = servePositions();
  for (const [i, pos] of [[sp.sv, sp.svPos], [sp.rc, sp.rcPos]]) {
    const pl = P[i]; if (pl.remote) continue;
    pl.target = { x:pos.x, z:pos.z }; pl.walk = true;
  }
}
function callFault(reason) {
  if (M.mode === 'online') netSend({ t:'fault', r:reason });
  applyFault(reason);
}
function callLet() {
  if (M.mode === 'online') netSend({ t:'let' });
  applyLet();
}
function applyLet() {
  timers.length = 0;
  M.phase = 'pointover'; M.lastWinner = -1; landRing.material.opacity = 0;
  toast('Let', 'info', 'Tocou na rede · repete o ' + (M.serveNum === 2 ? '2.º serviço' : 'serviço'), 1000);
  after(1.2, resetForServe);
}
function applyFault(reason) {
  if (M.serveNum === 1) {
    timers.length = 0;
    M.serveNum = 2; M.phase = 'pointover'; M.lastWinner = -1; landRing.material.opacity = 0;
    toast(reason, 'info', '2.º serviço', 900);
    if (M.server === M.me) countTip('serve', 2, 'No serviço, larga o dedo quando a bola está lá em cima (zona verde). No 2.º serviço a bola entra mais vezes.');
    after(1.2, resetForServe);
  } else {
    M.phase = 'rally';
    applyPoint(other(M.server), 'Dupla falta');
  }
}

// ---------------------------------------------------------------- contacto com a bola
function legalFor(pl) { return B.bounces === 1 || (B.bounces === 0 && !B.isServe && Math.sign(B.p.z) === pl.side); }
function reachable(pl) { return legalFor(pl) && Math.abs(B.p.x - pl.pos.x) <= reachOf(pl) && B.p.y <= 2.7 && B.p.y >= 0.06; }
function whiff(pl, msg) {
  pl.act = { type:fhSide(pl) ? 'fh' : 'bh', t:0, phase:'swing' }; pl.whiff = true;
  if (pl.idx === M.me && msg) {
    M.lastMine = { whiff:msg + (msg === 'Fora de alcance' ? ' · toca para correr até à bola' : ' · larga no verde') };
    popText(msg, 'bad', new V3(pl.pos.x, 1.9, pl.pos.z)); shotInfo('Falhaste', 0, 0, msg);
  }
}
function contactCheck(pl) {
  if (B.hitter === pl.idx || B.hitter < 0 || B.netHit || pl.remote) return;
  const s = pl.side;
  const d = (pl.pos.z - s * PLANE - B.p.z) * s;   // > 0: a bola ainda vem a caminho do plano de batimento
  const prev = pl.prevD; pl.prevD = d;
  if (!pl.isCPU && pl.swipe && pl.crossT === null && simTime - pl.swipe.t > 0.5) {
    pl.swipe = null;
    if (B.v.z * s > 0) { whiff(pl, 'Cedo demais'); pl.whiff = false; countTip('timing', 2, 'Larga o dedo quando o marcador da barra "Tempo" passar na zona verde.'); }
  }
  if (prev === null || pl.whiff) return;
  if (prev > 0 && d <= 0) {
    pl.crossT = simTime;
    if (pl.isCPU) { cpuTryHit(pl); return; }
    if (pl.swipe) { const sw = pl.swipe; pl.swipe = null; tryHit(pl, sw, -(simTime - sw.t)); return; }
    if (pl.idx === M.me && touch.mode === 'aim' && H().auto && touch.aim) { commitShot(); const sw = pl.swipe; pl.swipe = null; tryHit(pl, sw, 0.09); return; }
  }
  if (!pl.isCPU && pl.swipe && pl.crossT !== null && d <= 0) {
    const late = simTime - pl.crossT, sw = pl.swipe; pl.swipe = null;
    if (late <= 0.3) tryHit(pl, sw, late); else { whiff(pl, 'Tarde demais'); countTip('timing', 2, 'Larga o dedo quando o marcador da barra "Tempo" passar na zona verde.'); }
  }
}
function tryHit(pl, sw, err) {
  if (!reachable(pl)) { whiff(pl, 'Fora de alcance'); countTip('reach', 1, 'Toca no campo para correres até à bola, ou liga a Ajuda Total no menu.'); return; }
  const volley = B.bounces === 0;
  const q = timingQ(err, greenWin() * (B.isServe ? 1.5 : 1));
  const v = executeShot(pl.idx, { type:sw.type, tx:sw.tx, tz:sw.tz, power:sw.power, q, err });
  const name = sw.type === 'lob' ? 'Balão' : volley ? 'Vólei' : 'Topspin';
  M.lastMine = { q, err, power:sw.power, type:sw.type };
  shotInfo(name + ' · ' + Math.round(v.length() * 3.6) + ' km/h', q, err);
  popText(timingLabel(q, err), qCls(q), new V3(pl.pos.x, 1.9, pl.pos.z));
  if (q < 0.65) countTip('timing', 3, 'Larga o dedo quando o marcador da barra "Tempo" passar na zona verde.');
}

// ---------------------------------------------------------------- previsão / intercetar
function updateIncoming(pl) {
  if (!(M.phase === 'rally' && B.live && !B.netHit && B.hitter >= 0 && B.hitter !== pl.idx)) { pl.incoming = null; return; }
  if (pl.incoming && pl.incoming.id === B.hitId && simTime - pl.incAt < 0.08) return;
  pl.incAt = simTime;
  const s = pl.side, zc = pl.pos.z - s * PLANE;
  const hit = predictBall(3).find(q => (zc - q.z) * s <= 0 && (q.b === 1 || (q.b === 0 && !B.isServe && Math.sign(q.z) === s)));
  pl.incoming = hit ? { id:B.hitId, absT:simTime + hit.t, x:hit.x, y:hit.y, z:hit.z, b:hit.b } : { id:B.hitId, absT:Infinity };
}
// melhor sítio para bater: entre os pontos alcançáveis com a bola a uma altura confortável, o mais perto do jogador
function planIntercept(pl, speed, delay) {
  const s = pl.side, samples = predictBall(3.5);
  let best = null, bestD = Infinity, loose = null;
  for (const sm of samples) {
    if (sm.b !== 1 || sm.vz * s <= 0 || sm.y > 2.2) continue;
    const fx = sm.x - s * 0.72, bx = sm.x + s * 0.72;
    const standX = Math.abs(fx - pl.pos.x) <= Math.abs(bx - pl.pos.x) + 0.4 ? fx : bx;
    const standZ = sm.z + s * PLANE;
    if (Math.abs(standZ) < 1.5 || Math.abs(standZ) > HL + 5) continue;
    const d = Math.hypot(standX - pl.pos.x, standZ - pl.pos.z);
    if (d / speed > sm.t - delay - 0.05) continue;
    if (sm.y >= 0.5 && sm.y <= 1.5) { if (d < bestD) { bestD = d; best = { x:standX, z:standZ }; } }
    else if (!loose) loose = { x:standX, z:standZ };
  }
  if (best || loose) return best || loose;
  const fb = samples.find(q => q.b === 1);
  return fb ? { x:fb.x - s * 0.72, z:fb.z + s * 3 } : null;
}
function humanAuto(pl) {
  const h = H();
  if (M.phase === 'rally' && B.live && !B.netHit && B.hitter >= 0 && B.hitter !== pl.idx) {
    if (!pl.autoPlan || pl.autoPlan.id !== B.hitId || simTime - pl.autoPlan.at > 0.25) pl.autoPlan = { id:B.hitId, at:simTime, p:planIntercept(pl, RUN_SPEED, 0.05) };
    const p = pl.autoPlan.p; if (!p) return;
    const d = Math.hypot(p.x - pl.pos.x, p.z - pl.pos.z);
    const manual = pl.manualId === B.hitId;
    if ((h.auto && !manual) || (!manual && d < h.assist) || (manual && !pl.target && d < Math.min(1.2, h.assist))) { pl.target = { x:p.x, z:p.z }; pl.walk = false; }
  }
}

// ---------------------------------------------------------------- CPU
function cpuServe() {
  const pl = P[M.server]; if (!pl.isCPU || M.phase !== 'preserve') return;
  startToss(pl.idx, serveTarget(pl.idx, rand(-1, 1), rand(0.45, 1)));
}
// IA com comportamento humano: reação variável, erro de leitura que corrige a meio, recuperação para o centro
function cpuUpdate(pl) {
  const L = LEVELS[M.level], ai = pl.ai;
  if (M.phase === 'rally' && B.live && !B.netHit && B.hitter >= 0 && B.hitter !== pl.idx) {
    if (ai.planId !== B.hitId) {
      const k = 1 - L.q, misread = Math.random() < 0.25 * k;
      ai.planId = B.hitId; ai.planAt = simTime + L.react + Math.abs(gauss()) * 0.06; ai.plan = null; ai.fixed = false;
      ai.err = { x:gauss() * 0.35 * k + (misread ? Math.sign(gauss()) * rand(0.5, 0.9) : 0), z:gauss() * 0.5 * k };
    }
    if (simTime >= ai.planAt && (!ai.plan || (!ai.fixed && simTime >= ai.planAt + 0.35))) {
      if (ai.plan) { ai.fixed = true; ai.err.x *= 0.35; ai.err.z *= 0.35; }   // corrige a leitura a meio do caminho
      const p = planIntercept(pl, L.speed, 0);
      ai.plan = p ? { x:p.x + ai.err.x, z:p.z + ai.err.z } : null;
    }
    if (ai.plan) { pl.target = ai.plan; pl.walk = false; }
  } else if (M.phase === 'rally' && B.hitter === pl.idx) {
    if (!ai.rec || ai.rec.id !== B.hitId) {
      const fb = predictBall(3).find(q => q.b === 1);
      ai.rec = { id:B.hitId, at:simTime + 0.18 + Math.random() * 0.12, x:clamp((fb ? fb.x : 0) * 0.35 + gauss() * 0.3, -1.8, 1.8), z:pl.side * (HL + rand(0.5, 1.1)) };
    }
    if (simTime >= ai.rec.at) { pl.target = { x:ai.rec.x, z:ai.rec.z }; pl.walk = false; }
  }
}
function cpuTryHit(pl) {
  if (!reachable(pl)) { whiff(pl); return; }
  const L = LEVELS[M.level], foe = P[other(pl.idx)], r = -pl.side;
  const fx = foe.pos.x || rand(-1, 1);
  const stretched = Math.hypot(pl.vel.x, pl.vel.z) > 3.2 || Math.abs(B.p.x - pl.pos.x) > 1.25;   // a correr ou esticado: joga mais seguro
  let tx = stretched ? rand(-1.2, 1.2) : Math.random() < 0.7 ? -Math.sign(fx) * rand(L.width * 0.5, L.width) : rand(-L.width, L.width) * 0.6;
  const lob = Math.abs(foe.pos.z) < 6.5 ? Math.random() < 0.45 : Math.random() < (stretched ? 0.25 : 0.04);
  let depth = lob ? rand(9, 10.8) : rand(L.depth[0], L.depth[1]);
  // erros não forçados: mais prováveis quando a bola vem forte
  const press = clamp((B.v.length() - 15) / 10, 0, 1);
  if (Math.random() < L.miss + press * 0.15) {
    const kind = Math.random();
    if (kind < 0.4) depth = rand(12.2, 13.2);
    else if (kind < 0.75) tx = Math.sign(tx || 1) * rand(4.4, 5.2);
    else { executeShot(pl.idx, { type:'topspin', tx, tz:r * depth, power:0.9, q:0.2, err:0.2, margin:-0.35 }); return; }
  }
  executeShot(pl.idx, { type:lob ? 'lob' : 'topspin', tx, tz:r * depth, power:rand(L.pow[0], L.pow[1]) * (stretched ? 0.75 : 1),
    q:clamp(L.q + rand(-0.18, 0.15) - (stretched ? 0.2 : 0), 0.1, 1), err:rand(-0.1, 0.1) });
}

// ---------------------------------------------------------------- movimento e animação
function updatePlayer(pl, dt) {
  const ox = pl.pos.x, oz = pl.pos.z;
  if (pl.remote) {
    if (pl.netPos) { const k = Math.min(1, dt * 12); pl.pos.x += (pl.netPos.x - pl.pos.x) * k; pl.pos.z += (pl.netPos.z - pl.pos.z) * k; }
  } else {
    if (pl.isCPU) cpuUpdate(pl); else humanAuto(pl);
    const locked = (M.phase === 'preserve' && M.server === pl.idx) || (M.toss && M.toss.idx === pl.idx);
    let wx = 0, wz = 0;
    if (pl.target && !locked) {
      const dx = pl.target.x - pl.pos.x, dz = pl.target.z - pl.pos.z, d = Math.hypot(dx, dz);
      const top = pl.walk ? WALK_SPEED : pl.isCPU ? LEVELS[M.level].speed : RUN_SPEED;
      const want = Math.min(top, d * 7);
      if (d > 0.02) { wx = dx / d * want; wz = dz / d * want; }
      else if (!pl.isCPU) { pl.target = null; pl.walk = false; }
    }
    const k = Math.min(1, dt * 14);
    pl.mv.x += (wx - pl.mv.x) * k; pl.mv.z += (wz - pl.mv.z) * k;
    pl.pos.x += pl.mv.x * dt; pl.pos.z += pl.mv.z * dt;
    const s = pl.side;
    pl.pos.x = clamp(pl.pos.x, -DW - 3, DW + 3);
    pl.pos.z = s > 0 ? clamp(pl.pos.z, 0.7, HL + 5) : clamp(pl.pos.z, -HL - 5, -0.7);
  }
  pl.vel.x = (pl.pos.x - ox) / dt; pl.vel.z = (pl.pos.z - oz) / dt;
}
function updateAct(pl, dt) {
  if (pl.act && pl.act.phase === 'swing') { pl.act.t += dt; if (pl.act.t > TRACK_END[pl.act.type]) pl.act = null; return; }
  if (M.toss && M.toss.idx === pl.idx) { pl.act = { type:'sv', t:Math.min(-0.03, simTime - M.toss.t0 - T_IDEAL), phase:'prep' }; return; }
  const inc = pl.incoming;
  if (M.phase === 'rally' && inc && inc.absT !== Infinity && !pl.whiff) {
    const rem = inc.absT - simTime;
    if (rem < 0.6 && rem > -0.25) {
      const fh = (inc.x - pl.pos.x) * pl.side >= 0;
      pl.act = { type:inc.b === 0 ? (fh ? 'vf' : 'vb') : (fh ? 'fh' : 'bh'), t:Math.min(-0.03, -rem), phase:'prep', h:inc.y, lat:Math.abs(inc.x - pl.pos.x) };
      return;
    }
  }
  if (pl.act && pl.act.phase === 'prep') pl.act = null;
}
function figMode(pl) {
  if (M.phase === 'pointover' && M.lastWinner >= 0 && simTime - M.pointEndT < 1.0) return pl.idx === M.lastWinner ? 'happy' : 'sad';
  if (pl.walk && Math.hypot(pl.vel.x, pl.vel.z) > 0.3) return 'walk';
  if (M.phase === 'preserve' && M.server === pl.idx && !M.toss) return 'serve';
  return 'ready';
}

// ---------------------------------------------------------------- câmara
const CAM = { h:10.5, back:8.5, look:2.5, x:0 };
function resize() {
  const w = innerWidth, h = innerHeight, a = w / h;
  renderer.setSize(w, h, false);
  camera.aspect = a;
  camera.fov = clamp(2 * Math.atan(Math.tan(21 * Math.PI / 180) / a) * 180 / Math.PI, 46, 74);
  // vertical: de 21:9 (a≈0,43) a 16:9 (a≈0,56) o ponto de mira aproxima-se para o jogador não ficar atrás das barras
  if (a < 0.8) Object.assign(CAM, { h:10.8 + clamp(a - 0.46, 0, 0.3) * 6, back:9.8, look:0.6 - clamp(a - 0.46, -0.05, 0.3) * 13 });
  else Object.assign(CAM, { h:7.5, back:9.5, look:3.5 });
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
const debugCam = { on:false, pos:[0, 2, 5], look:[0, 1, 0] };
function updateCamera(dt, t) {
  if (debugCam.on) { camera.position.fromArray(debugCam.pos); camera.lookAt(...debugCam.look); return; }
  if (!inMatch()) {
    const a = t * 0.06;
    camera.position.set(Math.sin(a) * 24, 11, Math.cos(a) * 24); camera.lookAt(0, 0, 0); return;
  }
  const s = sideOf(M.me), px = P[M.me].pos.x;
  CAM.x += (px * 0.45 - CAM.x) * Math.min(1, dt * 3);
  camera.position.set(CAM.x, CAM.h, s * (HL + CAM.back));
  camera.lookAt(CAM.x * 0.4, 0, -s * CAM.look);
  camera.position.add(fx.offset);
}

// ---------------------------------------------------------------- input: tocar = correr · arrastar = apontar · largar = bater
const raycaster = new THREE.Raycaster(), ground = new THREE.Plane(new V3(0, 1, 0), 0), ndc = new THREE.Vector2();
const touch = { id:null, x0:0, y0:0, mode:null, aim:null };
const canServeNow = () => M.phase === 'preserve' && M.server === M.me && !M.toss && !P[M.me].remote;
canvas.addEventListener('pointerdown', e => {
  if (!inMatch() || M.phase === 'over' || touch.id !== null) return;
  audio();
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  Object.assign(touch, { id:e.pointerId, x0:e.clientX, y0:e.clientY, mode:'pending', aim:null });
  if (canServeNow()) { touch.mode = 'serve'; touch.aim = serveTarget(M.me, 0, 0.62); startToss(M.me); }
});
canvas.addEventListener('pointermove', e => {
  if (e.pointerId !== touch.id) return;
  const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0;
  if (touch.mode === 'pending' && Math.hypot(dx, dy) > 16 && M.phase === 'rally') touch.mode = 'aim';
  if (touch.mode === 'aim') touch.aim = aimFromDrag(dx, dy);
  if (touch.mode === 'serve') touch.aim = serveTarget(M.me, clamp(dx / (innerWidth * 0.28), -1, 1), clamp(0.62 - dy / (innerHeight * 0.3), 0.1, 1));
});
const endTouch = e => {
  if (e.pointerId !== touch.id) return;
  const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0, mode = touch.mode;
  touch.id = null; touch.mode = null;
  if (e.type === 'pointercancel') { hideAim(); return; }
  if (mode === 'pending' && Math.hypot(dx, dy) < 16) onTap(touch.x0, touch.y0);
  else if (mode === 'aim' && touch.aim) { touch.mode = 'aim'; commitShot(); touch.mode = null; }
  else if (mode === 'serve' && touch.aim) releaseServe(M.me, touch.aim);
  hideAim();
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

function aimFromDrag(dx, dy) {
  const s = sideOf(M.me), r = -s;
  const ax = clamp(dx / (innerWidth * 0.3), -1, 1);
  let type, depth, power;
  if (dy > 14) { const d = clamp((dy - 14) / (innerHeight * 0.18), 0, 1); type = 'lob'; depth = 8.8 + d * 2.3; power = 0.2 + d * 0.5; }
  else { const d = clamp(-dy / (innerHeight * 0.24), 0, 1); type = 'topspin'; depth = 5.6 + d * 5.6; power = 0.12 + d * 0.88; }
  return { type, power, tx:s * ax * (HW - 0.3), tz:r * depth };
}
function commitShot() {
  if (M.phase !== 'rally' || !touch.aim) return;
  P[M.me].swipe = { ...touch.aim, t:simTime };
  timingTick(true);
}
function onTap(cx, cy) {
  if (!inMatch() || M.phase === 'over') return;
  const me = P[M.me];
  if (M.phase === 'preserve' && M.server === M.me) return;
  ndc.set(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = new V3(); if (!raycaster.ray.intersectPlane(ground, hit)) return;
  const s = me.side;
  hit.x = clamp(hit.x, -DW - 2.5, DW + 2.5);
  hit.z = s > 0 ? clamp(hit.z, 0.8, HL + 4) : clamp(hit.z, -HL - 4, -0.8);
  me.target = { x:hit.x, z:hit.z }; me.walk = false;
  if (M.phase === 'rally' && B.hitter >= 0 && B.hitter !== M.me) me.manualId = B.hitId;
  tapRing.position.set(hit.x, 0.006, hit.z); tapRing.material.opacity = 0.85;
}

// mira + trajetória prevista + barras
function showAimVisuals() {
  const a = touch.aim, me = P[M.me];
  const serving = touch.mode === 'serve' || (canServeNow() && !touch.mode);
  const aim = serving ? (touch.mode === 'serve' ? a : serveTarget(M.me, 0, 0.62)) : (touch.mode === 'aim' ? a : null);
  if (!aim) { aimRing.material.opacity = aimDot.material.opacity = 0; prevLine.visible = false; return; }
  const lob = aim.type === 'lob';
  const col = serving ? 0xd7f34a : lob ? 0xffa94d : 0xffffff;
  const sig = serving ? 0.5 : lob ? 0.75 : 0.45 + aim.power * 0.45;
  aimRing.material.color.setHex(col); aimDot.material.color.setHex(col);
  aimRing.scale.setScalar(sig); aimRing.position.set(aim.tx, 0.007, aim.tz); aimDot.position.set(aim.tx, 0.008, aim.tz);
  aimRing.material.opacity = 0.9; aimDot.material.opacity = 0.95;
  if (!H().preview || M.mode === 'menu') { prevLine.visible = false; return; }
  const s = me.side;
  let from;
  if (serving) from = new V3(me.pos.x - s * 0.1, 2.7, me.pos.z - s * 0.35);
  else if (me.incoming && me.incoming.absT !== Infinity) from = new V3(me.incoming.x, Math.max(0.6, me.incoming.y), me.incoming.z);
  else from = new V3(me.pos.x + s * 0.7, 1.0, me.pos.z - s * PLANE);
  let v, g;
  if (serving) { g = GRAV + (M.serveNum === 2 ? 7 : 2); v = makeShot(from, aim.tx, aim.tz, M.serveNum === 2 ? 23 : 38, g, M.serveNum === 2 ? 0.45 : 0.12); }
  else { const sp = shotSpec(aim.type, aim.power, 1, false); g = sp.g; v = makeShot(from, aim.tx, aim.tz, sp.speedH, g, sp.margin); }
  const T = (aim.tz - from.z) / v.z, arr = prevGeo.attributes.position.array;
  for (let i = 0; i < PREV_N; i++) { const t = T * i / (PREV_N - 1); arr[i * 3] = from.x + v.x * t; arr[i * 3 + 1] = Math.max(0.02, from.y + v.y * t - 0.5 * g * t * t); arr[i * 3 + 2] = from.z + v.z * t; }
  prevGeo.attributes.position.needsUpdate = true; prevLine.computeLineDistances(); prevLine.visible = true;
}
function hideAim() { prevLine.visible = false; }

// ---------------------------------------------------------------- HUD
let toastTimer = null;
// faixa de resultado estilo TV (entra pela esquerda)
function toast(text, cls = 'info', sub = '', ms = 900) {
  const el = $('toast');
  el.className = cls + (sub ? '' : ' nosub');
  el.querySelector('.b-title').textContent = text; el.querySelector('.b-sub').textContent = sub;
  void el.offsetWidth; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
let coachTimer = null;
function coach(text) {
  const el = $('coach'); el.querySelector('span').textContent = text; el.classList.add('show');
  clearTimeout(coachTimer); coachTimer = setTimeout(() => el.classList.remove('show'), 4800);
}
function countTip(key, n, text) {
  if (M.tips[key]) return;
  M.counts[key] = (M.counts[key] || 0) + 1;
  if (M.counts[key] >= n) { M.tips[key] = true; coach(text); }
}
function updateHUD() {
  for (const i of [0, 1]) {
    const row = $(i === M.me ? 'row0' : 'row1'), pt = row.querySelector('.pt');
    row.querySelector('.nm').textContent = M.names[i];
    if (pt.textContent !== String(M.score[i])) {
      const changed = pt.textContent !== '' && M.score[i] > 0;
      pt.textContent = M.score[i];
      if (changed) { pt.classList.remove('bump'); void pt.offsetWidth; pt.classList.add('bump'); }
    }
    row.querySelector('.dot').classList.toggle('on', M.phase !== 'over' && M.server === i);
  }
}
function updateHint() {
  const h = $('hint');
  let txt = '';
  if (M.phase === 'preserve' && M.server === M.me) txt = (M.serveNum === 2 ? '2.º serviço · ' : '') + 'Segura · aponta · larga no verde';
  else if (M.pointsPlayed < 3) txt = 'Toca para correr · arrasta e larga para bater';
  h.classList.toggle('hidden', !txt); h.firstElementChild.textContent = txt;
}
// barra de tempo: de -0.8 s a +0.4 s em relação ao momento ideal
const TM_MIN = -0.8, TM_MAX = 0.4, tmPct = x => clamp((x - TM_MIN) / (TM_MAX - TM_MIN), 0, 1) * 100;
let tmFrozen = null, tmFrozenAt = -9;
function timingTick(commit) {
  const me = P[M.me];
  let rel = null;
  if (M.toss && M.toss.idx === M.me) rel = simTime - M.toss.t0 - T_IDEAL;
  else if (M.phase === 'rally' && me.incoming && me.incoming.absT !== Infinity) rel = simTime - me.incoming.absT;
  if (commit && rel !== null) { tmFrozen = rel; tmFrozenAt = simTime; }
  return rel;
}
const qCls = q => (q >= 1 ? 'gold' : q >= 0.65 ? 'good' : q >= 0.3 ? 'warn' : 'bad');
// texto curto que sobe junto ao jogador (qualidade do timing, velocidade)
const pops = [];
function popText(text, cls, pos) {
  const el = document.createElement('div'); el.className = 'pop ' + cls; el.textContent = text;
  $('pops').append(el); pops.push({ el, pos, t:0 });
  if (pops.length > 4) { pops[0].el.remove(); pops.shift(); }
}
const _pv = new V3();
function updatePops(dt) {
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i]; p.t += dt;
    _pv.copy(p.pos); _pv.y += p.t * 0.8; _pv.project(camera);
    const k = Math.min(1, p.t / 0.12);
    p.el.style.transform = `translate(${(_pv.x * 0.5 + 0.5) * innerWidth}px,${(-_pv.y * 0.5 + 0.5) * innerHeight}px) translate(-50%,-50%) scale(${0.7 + 0.3 * k})`;
    p.el.style.opacity = clamp(1.6 - p.t * 1.7, 0, 1);
    if (p.t > 0.95) { p.el.remove(); pops.splice(i, 1); }
  }
}
function shotInfo(text, q, err, chip) {
  const lbl = chip || timingLabel(q, err), cls = qCls(q);
  $('shotInfo').innerHTML = `<b>${text}</b> <span class="chip ${cls}">${lbl}</span>`;
  $('shotInfo').classList.add('show');
  $('qFill').style.width = Math.round(q * 100) + '%'; $('qFill').className = cls;
  clearTimeout(shotInfo.t); shotInfo.t = setTimeout(() => $('shotInfo').classList.remove('show'), 2600);
}
function updateShotUI() {
  const ui = $('shotUI');
  if (!inMatch() || M.phase === 'over') { ui.classList.add('hidden'); return; }
  ui.classList.remove('hidden');
  const rel = timingTick(false), g = greenWin() * (B.isServe && M.phase === 'rally' ? 1.5 : 1);
  const active = rel !== null && rel > TM_MIN - 0.2;
  $('tmBar').classList.toggle('dim', !active);
  $('tmG').style.left = tmPct(-g) + '%'; $('tmG').style.width = (tmPct(g) - tmPct(-g)) + '%';
  $('tmY').style.left = tmPct(-g - 0.16) + '%'; $('tmY').style.width = (tmPct(g + 0.16) - tmPct(-g - 0.16)) + '%';
  $('tmMark').style.left = (active ? tmPct(rel) : 0) + '%';
  $('tmMark').style.opacity = active ? 1 : 0;
  const frozen = simTime - tmFrozenAt < 1.2;
  $('tmTick').style.opacity = frozen ? 1 : 0; if (frozen) $('tmTick').style.left = tmPct(tmFrozen) + '%';
  const a = touch.aim, aiming = (touch.mode === 'aim' || touch.mode === 'serve') && a;
  if (aiming) {
    const serve = touch.mode === 'serve';
    const pw = serve ? 0.4 + a.ad * 0.6 : a.power;
    $('pwFill').style.width = Math.round(pw * 100) + '%';
    $('pwLbl').textContent = serve ? 'Serviço · aponta na caixa' : (a.type === 'lob' ? 'Balão' : 'Topspin') + ' · potência ' + Math.round(pw * 100) + '%';
  } else { $('pwFill').style.width = '0%'; $('pwLbl').textContent = 'Potência'; }
}
const screens = ['menu', 'hostScr', 'joinScr', 'tourScr', 'endScr', 'msgScr'];
function show(id) {
  for (const s of screens) $(s).classList.toggle('off', s !== id);
  const game = id === null;
  $('hud').classList.toggle('fade-out', !game); $('quit').classList.toggle('hidden', !game);
  if (!game) { $('hint').classList.add('hidden'); $('shotUI').classList.add('hidden'); $('coach').classList.remove('show'); $('toast').classList.remove('show'); }
}
const icon = (id, cls = 'i') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;
document.addEventListener('contextmenu', e => { if (!e.target.closest('input')) e.preventDefault(); });
function myName() { const n = ($('nameIn').value || $('joinName').value || '').trim(); return n || 'Jogador'; }
function saveName(n) { store.set('name', n); $('nameIn').value = n; $('joinName').value = n; }

function startMatch(cfg) {
  Object.assign(M, { mode:cfg.mode, me:cfg.me, names:cfg.names, surface:cfg.surface, level:cfg.level ?? M.level,
    first:cfg.first, score:[0, 0], pointsPlayed:0, wantRematch:false, remoteRematch:false, tips:{}, counts:{}, toss:null, lastMine:{} });
  buildCourt(M.surface);
  P.forEach((p, i) => { p.isCPU = false; p.remote = false; p.target = null; p.swipe = null; p.act = null; p.ai.planId = -1; p.fig.setLook(LOOK_PRESETS[cfg.looks ? cfg.looks[i] : i]); });
  if (M.mode === 'cpu' || M.mode === 'tour') P[1].isCPU = true;
  if (M.mode === 'online') P[other(M.me)].remote = true;
  timers.length = 0;
  show(null); updateHUD();
  $('tag').textContent = (M.mode === 'tour' ? TOUR[M.tourRound].round.toUpperCase() + ' · ' : '') + SURFACES[M.surface].label.toUpperCase() + ' · TIE BREAK A 10';
  preparePoint();
  sfx.crowdBed(true); sfx.ui('start');
  coach(M.server === M.me ? 'Serviço: segura o dedo para lançar a bola, arrasta para apontar e larga quando o marcador estiver no verde.' : 'Quando a bola vier, arrasta o dedo para apontar e larga quando o marcador da barra "Tempo" estiver no verde.');
  try { if (matchMedia('(pointer:coarse)').matches && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {}
}
function finishMatch() {
  M.phase = 'over'; updateHUD();
  const w = M.score[0] > M.score[1] ? 0 : 1, won = w === M.me;
  $('endScore').innerHTML = M.score[M.me] + '<em>–</em>' + M.score[other(M.me)];
  $('endIcon').innerHTML = icon(won ? 'trophy' : 'ball');
  $('endTitle').textContent = won ? 'Ganhaste' : 'Perdeste';
  let sub = 'contra ' + M.names[other(M.me)], main = 'Revanche';
  if (M.mode === 'tour') {
    if (won && M.tourRound === TOUR.length - 1) { sub = 'Campeão do Torneio Atlântico!'; store.set('trophies', store.get('trophies', 0) + 1); main = 'Novo torneio'; M.tourRound = 0; }
    else if (won) { sub = 'Passaste às ' + TOUR[M.tourRound + 1].round; M.tourRound++; main = 'Continuar torneio'; }
    else { sub = 'Eliminado nos ' + TOUR[M.tourRound].round; main = 'Tentar outra vez'; }
  }
  sfx.ui(won ? 'win' : 'lose'); if (won) sfx.cheer(1);
  $('endSub').textContent = sub; $('bEndMain').textContent = main; $('bEndMain').disabled = false;
  show('endScr');
}
function goMenu() {
  M.mode = 'menu'; sfx.crowdBed(false);
  netClose();
  M.phase = 'idle'; B.live = false; B.held = false; M.toss = null; timers.length = 0;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  $('trophies').innerHTML = icon('trophy') + 'Troféus: ' + store.get('trophies', 0);
  show('menu');
}
function seg(id, key, val) {
  const el = $(id);
  const paint = v => el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
  el.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const v = key === 'level' ? +b.dataset.v : b.dataset.v; M[key] = v; store.set(key, v); paint(v); });
  M[key] = val; paint(val);
}
seg('segLevel', 'level', store.get('level', 1));
seg('segSurf', 'surface', store.get('surface', 'hard'));
seg('segHelp', 'help', store.get('help', 'normal'));
buildCourt(M.surface);
saveName(store.get('name', ''));
$('nameIn').addEventListener('change', e => saveName(e.target.value.trim()));
$('joinName').addEventListener('change', e => saveName(e.target.value.trim()));
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', goMenu));
document.addEventListener('click', e => {
  const b = e.target.closest('button, .btn'); if (!b) return;
  unlock(); sfx.ui(b.closest('.seg') ? 'toggle' : b.matches('[data-back], #quit, #bEndMenu') ? 'back' : 'tap');
});
$('quit').addEventListener('click', () => { if (M.mode !== 'online' || confirm('Sair do duelo?')) goMenu(); });

$('bQuick').addEventListener('click', () => {
  audio(); saveName(myName());
  const lv = store.get('level', 1);
  startMatch({ mode:'cpu', me:0, names:[myName(), 'CPU · ' + LEVELS[lv].label], surface:store.get('surface', 'hard'), level:lv,
    first:Math.random() < 0.5 ? 0 : 1, looks:[0, 1 + ((Math.random() * 4) | 0)] });
});
function renderBracket() {
  $('bracket').innerHTML = '';
  TOUR.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = i < M.tourRound ? 'done' : i === M.tourRound ? 'cur' : '';
    li.innerHTML = `<span><b>${r.round}</b><br><small>${r.opp} · ${SURFACES[r.surface].label}</small></span>${i < M.tourRound ? '<span class="pill ok">Ganho</span>' : i === M.tourRound ? '<span class="pill next">Próximo</span>' : ''}`;
    $('bracket').append(li);
  });
  $('bTourPlay').textContent = 'Jogar ' + TOUR[M.tourRound].round;
}
$('bTour').addEventListener('click', () => { audio(); saveName(myName()); renderBracket(); show('tourScr'); });
$('bTourPlay').addEventListener('click', () => {
  const r = TOUR[M.tourRound];
  startMatch({ mode:'tour', me:0, names:[myName(), r.opp], surface:r.surface, level:r.level, first:Math.random() < 0.5 ? 0 : 1, looks:[0, r.look] });
});
$('bEndMain').addEventListener('click', () => {
  if (M.mode === 'tour') { renderBracket(); show('tourScr'); return; }
  if (M.mode === 'online') {
    M.wantRematch = true; netSend({ t:'rematch' }); $('bEndMain').textContent = 'À espera do amigo…'; $('bEndMain').disabled = true; maybeRematch(); return;
  }
  startMatch({ mode:'cpu', me:0, names:M.names, surface:M.surface, level:M.level, first:Math.random() < 0.5 ? 0 : 1, looks:[0, 1 + ((Math.random() * 4) | 0)] });
});
$('bEndMenu').addEventListener('click', goMenu);

// ---------------------------------------------------------------- online (PeerJS, ligação direta entre telemóveis)
const NET = { peer:null, conn:null, host:false, rtt:0.1, code:'', pingT:null, lastPos:0, url:'' };
const PREFIX = 'duelotenis-v1-';
function netSend(m) { try { if (NET.conn && NET.conn.open) NET.conn.send(m); } catch (e) {} }
function netClose() {
  clearInterval(NET.pingT);
  netSend({ t:'bye' });
  const c = NET.conn, p = NET.peer;
  NET.peer = NET.conn = null; NET.url = '';
  try { c && c.close(); } catch (e) {}
  try { p && p.destroy(); } catch (e) {}
}
function netError(title, text) { M.mode = 'menu'; netClose(); $('msgTitle').textContent = title; $('msgText').textContent = text; show('msgScr'); }
function wire(conn) {
  NET.conn = conn;
  conn.on('data', onNet);
  conn.on('close', () => { if (NET.conn === conn && (inMatch() || !$('endScr').classList.contains('hidden'))) netError('Ligação terminada', 'O teu amigo saiu do jogo.'); });
  conn.on('open', () => {
    clearInterval(NET.pingT);
    NET.pingT = setInterval(() => netSend({ t:'ping', c:performance.now() }), 2000);
    if (!NET.host) netSend({ t:'hello', name:myName() });
  });
}
function hostGame() {
  if (typeof Peer === 'undefined') return netError('Sem ligação', 'Não foi possível carregar o modo online. Verifica a internet.');
  netClose(); NET.host = true;
  NET.code = Math.random().toString(36).slice(2, 8);
  $('linkBox').textContent = 'A criar sala…'; $('hostStatus').textContent = 'À espera do teu amigo…';
  show('hostScr');
  const peer = NET.peer = new Peer(PREFIX + NET.code);
  peer.on('open', () => {
    const url = location.origin + location.pathname + '#d=' + NET.code;
    NET.url = url; $('linkBox').textContent = url;
    $('bWa').href = 'https://wa.me/?text=' + encodeURIComponent('Desafio-te para um duelo de ténis: ' + url);
  });
  peer.on('connection', c => { if (NET.conn) { c.close(); return; } $('hostStatus').textContent = 'Amigo a entrar…'; wire(c); });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') return hostGame();
    netError('Erro de ligação', 'Não foi possível criar a sala (' + e.type + '). Tenta outra vez.');
  });
}
function joinGame(code) {
  if (typeof Peer === 'undefined') return netError('Sem ligação', 'Não foi possível carregar o modo online. Verifica a internet.');
  netClose(); NET.host = false;
  $('joinStatus').textContent = 'A ligar ao teu amigo…'; $('bJoin').disabled = true;
  const peer = NET.peer = new Peer();
  peer.on('open', () => wire(peer.connect(PREFIX + code, { reliable:true })));
  peer.on('error', e => {
    $('bJoin').disabled = false;
    if (e.type === 'peer-unavailable') netError('Convite expirado', 'O teu amigo já não está na sala. Pede-lhe um link novo.');
    else netError('Erro de ligação', 'Não foi possível ligar (' + e.type + ').');
  });
  setTimeout(() => { if (M.mode === 'menu' && !$('joinScr').classList.contains('hidden') && NET.peer === peer) $('joinStatus').textContent = 'Está a demorar… confirma que o teu amigo tem o jogo aberto.'; }, 9000);
}
function sendStart() {
  const cfg = { names:[myName(), NET.guestName || 'Amigo'], surface:store.get('surface', 'hard'), first:Math.random() < 0.5 ? 0 : 1, looks:[0, 1] };
  netSend({ t:'start', ...cfg });
  startMatch({ mode:'online', me:0, ...cfg });
}
function maybeRematch() { if (NET.host && M.wantRematch && M.remoteRematch) sendStart(); }
function onNet(m) {
  switch (m.t) {
    case 'hello': if (NET.host) { NET.guestName = String(m.name || 'Amigo').slice(0, 12); sendStart(); } break;
    case 'start': if (!NET.host) startMatch({ mode:'online', me:1, names:m.names, surface:m.surface, first:m.first, looks:m.looks }); break;
    case 'pos': { const p = P[other(M.me)]; p.netPos = { x:m.x, z:m.z }; break; }
    case 'toss': if (M.phase === 'pointover') runTimers(true); if (M.phase === 'preserve') M.toss = { idx:other(M.me), t0:simTime, aim:null, releaseAt:null }; break;
    case 'hit': {
      if (M.phase === 'pointover') runTimers(true);
      const idx = other(M.me);
      if (P[idx].netPos) P[idx].pos.x = P[idx].netPos.x;
      launch(idx, new V3(...m.p), new V3(...m.v), m.g, !!m.s, true, 0.7, m.sp ?? 0.3);
      const lag = clamp(NET.rtt / 2, 0, 0.15);
      for (let t = 0; t < lag; t += STEP) stepBall(STEP);
      break;
    }
    case 'point': applyPoint(m.w, m.r); break;
    case 'fault': applyFault(m.r); break;
    case 'let': applyLet(); break;
    case 'ping': netSend({ t:'pong', c:m.c }); break;
    case 'pong': NET.rtt = (performance.now() - m.c) / 1000; break;
    case 'rematch': M.remoteRematch = true; maybeRematch(); break;
    case 'bye': netError('Ligação terminada', 'O teu amigo saiu do jogo.'); break;
  }
}
$('bFriend').addEventListener('click', () => { audio(); saveName(myName()); hostGame(); });
$('bCopy').addEventListener('click', async () => {
  const label = t => { $('bCopy').innerHTML = icon('copy') + t; };
  try { await navigator.clipboard.writeText(NET.url || ''); label('Copiado'); } catch (e) { label('Seleciona e copia'); }
  setTimeout(() => label('Copiar link'), 1800);
});
$('bShare').addEventListener('click', async () => {
  if (!NET.url) return;
  if (navigator.share) { try { await navigator.share({ title:'Duelo Ténis', text:'Desafio-te para um duelo de ténis.', url:NET.url }); } catch (e) {} }
  else $('bCopy').click();
});
$('bJoin').addEventListener('click', () => {
  audio(); saveName(($('joinName').value || '').trim() || 'Amigo');
  const code = (location.hash.match(/d=([a-z0-9]+)/) || [])[1];
  if (code) joinGame(code);
});

// ---------------------------------------------------------------- ciclo principal
function step(dt) {
  simTime += dt;
  runTimers(false);
  B.pp.copy(B.p);
  for (const pl of P) { pl.pp.x = pl.pos.x; pl.pp.z = pl.pos.z; }
  for (const pl of P) { updatePlayer(pl, dt); updateIncoming(pl); }
  if (M.toss) {
    const tt = simTime - M.toss.t0, sv = P[M.toss.idx], s = sv.side;
    B.p.set(sv.pos.x - s * 0.1, tossY(tt), sv.pos.z - s * 0.35);
    if (M.toss.releaseAt !== null && tt >= M.toss.releaseAt) releaseServe(M.toss.idx, M.toss.aim);
    else if (tt > T_FAIL && !sv.remote) failToss();
  }
  if (B.live) stepBall(dt);
  if (B.live && M.phase === 'rally') for (const pl of P) contactCheck(pl);
}
let last = performance.now(), acc = 0, fakeNow = 0, alpha = 1;
const perf = { level:0, sum:0, n:0, slow:0 };
const DPR_LEVELS = [Math.min(devicePixelRatio || 1, 2), Math.min(devicePixelRatio || 1, 1.6), Math.min(devicePixelRatio || 1, 1.3), 1];
function perfTick(dt) {
  if (!inMatch() || dt <= 0) return;
  perf.sum += dt; perf.n++;
  if (perf.n < 90) return;
  const avg = perf.sum / perf.n; perf.sum = perf.n = 0;
  perf.slow = avg > 1 / 50 ? perf.slow + 1 : 0;           // 2 janelas seguidas abaixo de 50 fps → baixa um nível
  if (perf.slow >= 2 && perf.level < DPR_LEVELS.length - 1) {
    perf.level++; perf.slow = 0;
    renderer.setPixelRatio(DPR_LEVELS[perf.level]); resize();
    if (perf.level >= 2 && sun.shadow.mapSize.x > 1024) { sun.shadow.mapSize.set(1024, 1024); sun.shadow.map?.dispose(); sun.shadow.map = null; }
  }
}
const _bp = new V3();
function frame(now, manual) {
  const rawDt = (now - last) / 1000;
  const dt = clamp(rawDt, 0, 0.05); last = Math.max(last, now);
  if (!manual) perfTick(rawDt);
  if (inMatch() && M.phase !== 'over' && now >= hitStopUntil) {
    acc += dt;
    while (acc >= STEP) { step(STEP); acc -= STEP; }
    alpha = acc / STEP;
    if (M.mode === 'online' && now - NET.lastPos > 66) { NET.lastPos = now; const me = P[M.me]; netSend({ t:'pos', x:+me.pos.x.toFixed(3), z:+me.pos.z.toFixed(3) }); }
  }
  if (B.held && M.phase === 'preserve') {
    const sv = P[M.server], s = sv.side;
    B.p.set(sv.pos.x - s * 0.1, 0.06 + Math.abs(Math.sin(simTime * 4.2)) * 0.85, sv.pos.z - s * 0.4);
  }
  for (const pl of P) {
    if (!inMatch()) { pl.vel.x = pl.vel.z = 0; }
    updateAct(pl, dt);
    const ix = pl.pp.x + (pl.pos.x - pl.pp.x) * alpha, iz = pl.pp.z + (pl.pos.z - pl.pp.z) * alpha;
    pl.fig.update(dt, { x:ix, z:iz, vx:pl.vel.x, vz:pl.vel.z, side:pl.side,
      ball:inMatch() && (B.live || B.held || M.toss) ? B.p : null, act:pl.act, mode:figMode(pl), split:simTime - (pl.splitAt ?? -9) });
  }
  const showBall = inMatch() && (B.live || B.held || !!M.toss);
  ballMesh.visible = blob.visible = showBall;
  const bsp = B.live ? B.v.length() : 0;
  const bp = B.held ? B.p : _bp.lerpVectors(B.pp, B.p, alpha);
  ballMesh.position.copy(bp);
  // squash & stretch: estica com a velocidade, achata no impacto e no ressalto
  const base = clamp(camera.position.distanceTo(bp) / 13, 1, 2.6);
  squash.t += dt;
  let sy = 1 + clamp((bsp - 12) * 0.016, 0, 0.4), axis = bsp > 0.5 ? _dir.copy(B.v).normalize() : UP;
  if (squash.t < 0.09) { sy = 1 - (1 - squash.k) * Math.sin(squash.t / 0.09 * Math.PI); axis = squash.axis; }
  const sxz = 1 / Math.sqrt(sy);
  ballMesh.quaternion.setFromUnitVectors(UP, axis);
  ballMesh.scale.set(base * sxz, base * sy, base * sxz);
  // sombra sempre visível: mais pequena e mais clara quando a bola sobe
  blob.position.set(bp.x, 0.005, bp.z);
  blob.scale.setScalar(base * clamp(1.15 - bp.y * 0.09, 0.55, 1.15));
  blob.material.opacity = clamp(0.5 - bp.y * 0.06, 0.2, 0.5);
  fx.updateTrail(bp, bsp, B.live && showBall, camera);
  fx.update(dt);
  tapRing.material.opacity = Math.max(0, tapRing.material.opacity - dt * 1.2);
  if (inMatch() && M.phase !== 'over') showAimVisuals(); else { aimRing.material.opacity = aimDot.material.opacity = 0; prevLine.visible = false; }
  updateShotUI();
  updatePops(dt);
  updateCamera(dt, now / 1000);
  renderer.render(scene, camera);
  if (!manual) requestAnimationFrame(frame);
}
renderer.compile(scene, camera);
requestAnimationFrame(frame);
// avança o jogo à mão (só para testes automáticos)
function advance(sec) { const n = Math.round(sec / 0.02); for (let i = 0; i < n; i++) { fakeNow = Math.max(fakeNow, last) + 20; frame(fakeNow, true); } }

const inviteCode = (location.hash.match(/d=([a-z0-9]+)/) || [])[1];
if (inviteCode) show('joinScr'); else goMenu();

// ganchos para testes
window.__dt = { M, B, P, startMatch, NET, advance, predictBall, touch, aimFromDrag, commitShot, startToss, releaseServe, serveTarget, onTap, camera, debugCam,
  freeze(on) { hitStopUntil = on ? Infinity : 0; }, renderer, perf,
  get simTime() { return simTime; } };
