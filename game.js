import * as THREE from './vendor/three.module.min.js';
import { Athlete, LOOK_PRESETS, TRACK_END } from './player3d.js?v=14';
import { FX } from './fx.js?v=14';
import { RealAthlete, loadAthleteAssets, warmKits } from './athlete-gltf.js?v=14';
import { sfx, unlock } from './audio.js?v=14';
import { createOnline } from './online.js?v=14';
import { createAchievements, ACH } from './achievements.js?v=14';
import { createCareer } from './careerui.js?v=14';
import { CHARACTERS, charById, mods as statMods, total as statTotal, STATS, STAT_LABELS } from './chars.js?v=14';
import { HL, HW, SVC, BR, serverFor, servePositions as rulePositions, judgeFirstBounce, isMatchOver, matchPointFor, outBy } from './rules.js?v=14';

// ---------------------------------------------------------------- constantes
const DW = 5.485, NET_H = 0.914, GRAV = 9.81;
const STEP = 1 / 120, PLANE = 0.15, RUN_SPEED = 6.2, WALK_SPEED = 2.4;
const TOSS_Y0 = 1.3, TOSS_V = 5.1, T_IDEAL = 0.56, T_FAIL = 1.05;   // contacto ideal a ≈2,6 m, onde a raquete chega
const SURFACES = {
  hard:  { label:'Piso rápido', court:0x2b64ad, outer:0x37805a, e:0.68, f:0.80 },
  clay:  { label:'Terra batida', court:0xc0623a, outer:0xb3592f, e:0.72, f:0.72 },
  grass: { label:'Relva', court:0x5a9a3a, outer:0x4b8731, e:0.6, f:0.86 },
};
const LEVELS = [
  { label:'Fácil',   q:0.45, speed:5.6, react:0.3, pow:[0.2, 0.45], width:1.8, depth:[6.8, 9.2],  svSig:0.13, svPow:0.45, miss:0.1, svRead:0.05, ace:0.45 },
  { label:'Médio',   q:0.66, speed:6.6, react:0.17, pow:[0.35, 0.7], width:2.6, depth:[7.5, 10.1], svSig:0.08, svPow:0.7,  miss:0.07, svRead:0.035, ace:0.3 },
  { label:'Difícil', q:0.84, speed:7.4, react:0.1, pow:[0.55, 0.9], width:3.1, depth:[8.2, 10.5], svSig:0.05, svPow:0.9,  miss:0.035, svRead:0.02, ace:0.16 },
];
// força do CPU a partir do total de atributos do adversário (15 ≈ Fácil, 27 ≈ Médio, 40 ≈ Difícil; extrapola um pouco)
function levelFor(total) {
  const t = clamp((total - 15) / 12.5, -0.4, 2.4);
  const i = t < 1 ? 0 : 1, f = t - i, A = LEVELS[i], Z = LEVELS[i + 1], mix = (a, b) => a + (b - a) * f, o = { label:'CPU' };
  for (const k of Object.keys(A)) if (k !== 'label') o[k] = Array.isArray(A[k]) ? A[k].map((v, j) => mix(v, Z[k][j])) : mix(A[k], Z[k]);
  o.q = clamp(o.q, 0.3, 0.95); o.speed = clamp(o.speed, 5, 7.9); o.react = clamp(o.react, 0.06, 0.36); o.miss = clamp(o.miss, 0.02, 0.14);
  o.width = clamp(o.width, 1.5, 3.3); o.svSig = clamp(o.svSig, 0.035, 0.16); o.svPow = clamp(o.svPow, 0.35, 1); o.ace = clamp(o.ace, 0.1, 0.55);
  o.svRead = clamp(o.svRead, 0.015, 0.06); o.pow = o.pow.map(v => clamp(v, 0.15, 0.95)); o.depth = [clamp(o.depth[0], 6.5, 8.6), clamp(o.depth[1], 8.8, 10.7)];
  return o;
}
const HELPS = {
  total:  { label:'Total',  green:0.09, auto:true,  recover:true,  drift:1, magnet:3, fine:1.6, preview:true,  marker:true,  err:0.65, reach:1.9 },
  normal: { label:'Normal', green:0.065, auto:false, recover:false, drift:1, magnet:3.0, fine:1.6, preview:true,  marker:true,  err:1.0,  reach:1.8 },
  pro:    { label:'Pro',    green:0.05, auto:false, recover:false, drift:0.7, magnet:1.5, fine:1.1, preview:false, marker:false, err:1.12, reach:1.6 },
};
const TOUR = [
  { round:'Quartos-de-final', opp:'Alex',   level:0, surface:'clay',  char:'muralha' },
  { round:'Meias-finais',     opp:'Sophie', level:1, surface:'grass', char:'rede' },
  { round:'Final',            opp:'Claire', level:2, surface:'hard',  char:'canhao' },
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
const hemi = new THREE.HemisphereLight(0xe4f0ff, 0x3a4636, 1.05);
scene.add(hemi);
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
const dayBg = scene.background;
scene.fog = new THREE.Fog(0xbcd5ea, 60, 120);
// jogos à noite: céu escuro, luz dos projetores por cima do campo e torres de iluminação nos cantos
const nightBg = canvasTex(4, 256, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#02060f'); gr.addColorStop(0.6, '#0a1830'); gr.addColorStop(1, '#1d2f4d');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
const towers = new THREE.Group(); towers.visible = false; scene.add(towers);
{
  const poleM = new THREE.MeshStandardMaterial({ color:0x6b7686, roughness:0.6, metalness:0.4 });
  const lampM = new THREE.MeshBasicMaterial({ color:0xfffbe8 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 22, 8), poleM); pole.position.set(sx * 15, 11, sz * 21); towers.add(pole);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.6, 0.4), lampM); lamp.position.set(sx * 14.6, 22.4, sz * 20.6); lamp.lookAt(0, 0, 0); towers.add(lamp);
  }
}
const DAY_LIGHT = { hemi:[0xe4f0ff, 0x3a4636, 1.05], sun:[0xfff0d8, 2.7], sunPos:[-9, 22, 7], fog:0xbcd5ea, exp:1.08 };
const NIGHT_LIGHT = { hemi:[0x8ea2c8, 0x1c1a1a, 0.38], sun:[0xfff3e0, 3.2], sunPos:[2, 30, 4], fog:0x07101f, exp:1.06 };   // projetores: luz branca quente por cima
function setNight(on) {
  const L = on ? NIGHT_LIGHT : DAY_LIGHT;
  scene.background = on ? nightBg : dayBg; towers.visible = on;
  hemi.color.setHex(L.hemi[0]); hemi.groundColor.setHex(L.hemi[1]); hemi.intensity = L.hemi[2];
  sun.color.setHex(L.sun[0]); sun.intensity = L.sun[1]; sun.position.set(...L.sunPos);
  scene.fog.color.setHex(L.fog); renderer.toneMappingExposure = L.exp;
  // bancadas na penumbra à noite (os painéis LED continuam acesos)
  if (courtGroup) courtGroup.traverse(o => { if (o.material && o.material.userData && o.material.userData.crowd) o.material.color.setHex(on ? 0x5c6578 : 0xffffff); });
}

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
  const crowdMat = w => { const t = crowdCanvasTex.clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(w / 9, 2.2); t.needsUpdate = true; const m = new THREE.MeshLambertMaterial({ map:t }); m.userData.crowd = true; return m; };
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
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.042, 16, 12), new THREE.MeshStandardMaterial({ color:0xd9f53c, emissive:0x3a4a00, roughness:0.6 }));
scene.add(ballMesh);
const blob = new THREE.Mesh(new THREE.CircleGeometry(0.075, 20), new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:0.35, depthWrite:false }));
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
// anel de queda (estilo Tennis Arena): onde a bola do adversário vai bater; o arco vermelho enche até ao ressalto
const landRing = ringMesh(0xffffff, 0.36, 0.46);
const landFill = (() => {
  const g = new THREE.RingGeometry(0.36, 0.46, 48, 1, Math.PI / 2, -Math.PI * 2);   // começa em cima, roda no sentido dos ponteiros
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color:0xff4a2e, transparent:true, opacity:0, depthWrite:false, side:THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.007; m.renderOrder = 3; scene.add(m); return m;
})();
// disco suave no campo do adversário: onde a tua bola vai cair
const discTex = canvasTex(64, 64, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(0.65, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
const shotDisc = new THREE.Mesh(new THREE.CircleGeometry(0.85, 32), new THREE.MeshBasicMaterial({ map:discTex, transparent:true, opacity:0, depthWrite:false }));
shotDisc.rotation.x = -Math.PI / 2; shotDisc.position.y = 0.006; shotDisc.renderOrder = 2; scene.add(shotDisc);
const LAND = { t0:0, t1:0 };
function updateLandMarks(dt) {
  const a = landRing.material.opacity;
  landFill.material.opacity = a > 0.01 ? 0.95 : 0;
  if (a > 0.01) {
    const u = clamp((simTime - LAND.t0) / Math.max(0.05, LAND.t1 - LAND.t0), 0, 1);
    const n = landFill.geometry.index.count; landFill.geometry.setDrawRange(0, Math.floor(n * u / 6) * 6);
    const k = 0.75 + 0.45 * u; landRing.scale.setScalar(k); landFill.scale.setScalar(k);
    landFill.position.x = landRing.position.x; landFill.position.z = landRing.position.z;
  }
  if (shotDisc.material.opacity > 0 && (!B.live || B.bounces > 0)) shotDisc.material.opacity = Math.max(0, shotDisc.material.opacity - dt * 3);
}
const aimRing = ringMesh(0xffffff, 0.86, 1.0);
const aimDot = ringMesh(0xffffff, 0, 0.09);
// brilho suave na bola no instante ideal do swipe (só nas ajudas Total e Normal)
const haloTex = canvasTex(64, 64, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,235,1)'); gr.addColorStop(0.35, 'rgba(235,255,150,.55)'); gr.addColorStop(1, 'rgba(235,255,150,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map:haloTex, transparent:true, opacity:0, depthWrite:false, blending:THREE.AdditiveBlending }));
halo.renderOrder = 4; scene.add(halo);
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
    incoming:null, incAt:-1, autoPlan:null, manualId:-1, ai:{ planId:-1, planAt:0, plan:null }, fig:null,
    char:null, stats:null, perks:[], mods:statMods({}) };
}
const P = [newPlayer(0), newPlayer(1)];
P[0].fig = new Athlete(scene, LOOK_PRESETS[0]); P[0].lookIdx = 0;
P[1].fig = new Athlete(scene, LOOK_PRESETS[1]); P[1].lookIdx = 1;
// jogadores realistas (Rocketbox, MIT): substituem os bonecos simples quando os ficheiros estiverem carregados
let athleteAssets = null;
loadAthleteAssets().then(A => {
  athleteAssets = A;
  for (const p of P) { scene.remove(p.fig.root); p.fig = new RealAthlete(scene, A, LOOK_PRESETS[p.lookIdx]); }
  warmKits(A, LOOK_PRESETS);
}).catch(e => console.warn('Modelos 3D indisponíveis, a usar os jogadores simples', e));

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
const curL = () => M.L || LEVELS[M.level];
const errMul = idx => (M.mode === 'online' || idx !== M.me) ? 1 : H().err;
const greenWin = () => (M.mode === 'online' ? HELPS.normal.green : H().green);
const reachOf = pl => (pl.isCPU ? 1.8 : (pl.remote || M.mode === 'online') ? 1.75 : H().reach) + pl.mods.reach
  + (B.bounces === 0 && !B.isServe ? pl.mods.volleyReach : 0) + (B.isServe ? 0.25 - (B.svPress || 0) * 0.12 : 0);   // resposta: estica-se mais, menos contra um serviço forte e bem colocado
// dentro da janela ideal = perfeito (pancada vencedora possível); logo a seguir "Bom"; depois cai depressa
function timingQ(err, g) { const a = Math.abs(err); return a <= g ? 1 : clamp(0.88 - (a - g) / 0.22, 0, 0.88); }
function timingLabel(q, err) { if (q >= 1) return 'Perfeito'; if (q >= 0.6) return 'Bom'; if (q >= 0.3) return err < 0 ? 'Cedo' : 'Tarde'; return err < 0 ? 'Muito cedo' : 'Muito tarde'; }
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
    if (p.y < BR && v.y < 0) {
      const tb = Math.min(dt, (BR - p.y) / -v.y); p.x -= v.x * tb; p.z -= v.z * tb; p.y = BR;
      sp = bounceVel(v, sp, S); g = GRAV; b++; if (b > 2) break;
      p.x += v.x * tb; p.z += v.z * tb; p.y += v.y * tb;
    }
    out.push({ x:p.x, y:p.y, z:p.z, vz:v.z, t, b });
  }
  return out;
}
// ressalto com efeito: o topspin salta mais e conserva velocidade; o efeito gasta-se no ressalto
function bounceVel(v, spin, S) {
  v.y = -v.y * (S.e + spin * 0.06);
  const f = Math.min(0.95, S.f + spin * 0.07);
  v.x *= f; v.z *= f;
  if (spin < 0) { const k = 1 + spin * 0.36; v.y *= k; v.x *= k; v.z *= k; }   // efeito de recuo: a bola quase não sai do chão
  return spin * 0.4;
}
const fhSide = (pl, x) => ((x ?? B.p.x) - pl.pos.x) * pl.side >= 0;

function launch(idx, from, v, g, isServe, fromNet, q = 0.7, spin = 0.3) {
  const volley = !isServe && B.bounces === 0 && B.hitter >= 0;
  const fh = fhSide(P[idx], from.x);
  if (M.objective && objHook('shot', { idx, isServe })) return;                 // desafio: a resposta ao serviço acaba a tentativa
  B.shotType = isServe ? 'serve' : (B.nextType || 'topspin'); B.nextType = null;
  if (idx === M.me) M.myLast = B.shotType;
  B.p.copy(from); B.pp.copy(from); B.v.copy(v); B.g = g; B.spin = spin; B.bounces = 0; B.hitter = idx; B.isServe = isServe;
  B.live = true; B.held = false; B.netHit = false; B.netCord = false; B.hitId++;
  M.phase = 'rally'; M.toss = null;
  for (const pl of P) { pl.prevD = null; pl.crossT = null; pl.whiff = false; pl.swipe = null; pl.incoming = null; pl.autoPlan = null; }
  P[idx].act = { type:isServe ? 'sv' : (volley || spin < -0.5) ? (fh ? 'vf' : 'vb') : (fh ? 'fh' : 'bh'), t:0, phase:'swing',
    h:isServe ? undefined : from.y, lat:Math.abs(from.x - P[idx].pos.x), fw:PLANE };
  const speed = v.length(), strong = isServe ? speed > 41 : speed > 21.5;
  sfx.hit(clamp((speed - 8) / 30, 0, 1), camera.position.distanceTo(from), q >= 1);
  squash.t = 0; squash.k = 0.7; squash.axis.copy(v).normalize();
  if (strong && q >= 0.9 && (M.mode !== 'online' || idx === M.me)) hitStopUntil = last + (isServe ? 55 : 40);
  if (from.y > 1.9 && !isServe && speed > 20) fx.shake(0.06, 0.25);      // smash
  if (isServe) { sfx.hush(true); M.pointStartT = simTime; }
  M.pointHits = (M.pointHits || 0) + 1;
  if (isServe) B.svKmh = Math.round(v.length() * 3.6);
  if (isServe && M.stats) M.stats[idx].fastestServe = Math.max(M.stats[idx].fastestServe, B.svKmh);
  updateRally();
  P[other(idx)].splitAt = simTime;
  if (idx === M.me) {
    buzz(q >= 1 ? 30 : 14);
    if (H().recover && !isServe) { const me = P[idx]; me.target = { x:0, z:me.side * (HL + 0.5) }; me.walk = false; }
  } else M.lastMine = {};
  if (M.mode === 'online' && idx === M.me && !fromNet) netSend({ t:'hit', p:[from.x, from.y, from.z], v:[v.x, v.y, v.z], g, s:isServe ? 1 : 0, sp:spin });
  landRing.material.opacity = 0; shotDisc.material.opacity = 0;
  const fb = predictBall(3).find(s => s.b === 1);
  // pressão do 1.º serviço (0–1): rápido, perto dos cantos e fundo → mais difícil de ler e de alcançar para quem responde.
  // Calculada só a partir da bola, para dar o mesmo valor nos dois telemóveis no modo online.
  const place = isServe && fb ? clamp(Math.abs(fb.x - M.boxSign * HW / 2) / (HW / 2) * 0.75 + clamp(Math.abs(fb.z) / SVC, 0, 1) * 0.35, 0, 1) : 0;
  B.svPress = isServe && M.serveNum === 1 ? clamp((Math.hypot(v.x, v.z) - 29) / 12, 0, 1) * (0.2 + 0.8 * place) : 0;
  if (idx !== M.me && H().marker) {
    if (fb && Math.sign(fb.z) === sideOf(M.me)) { landRing.position.set(fb.x, 0.006, fb.z); landRing.material.opacity = 0.55; LAND.t0 = simTime; LAND.t1 = simTime + fb.t; }
  }
  if (idx === M.me && fb && Math.sign(fb.z) !== sideOf(M.me) && H().preview) { shotDisc.position.set(fb.x, 0.006, fb.z); shotDisc.material.opacity = 1; }
  P[idx].act.q = q;                                          // a figura pinta o rasto de verde nas pancadas perfeitas
}

const DEF_MODS = statMods({});
// pancada: alvo escolhido (tx,tz), potência e qualidade do tempo → trajetória com erro
function shotSpec(type, power, q, volley, m = DEF_MODS) {
  if (type === 'lob') return { speedH:14.5 + power * 3, g:GRAV + 3.2, margin:1.3, spin:0.2 };   // balão tenso: ápice ≈3,8–4,5 m, ainda alto demais para quem está na rede
  if (type === 'drop') return { g:GRAV - 1.2, apex:1.75 + power * 0.35, spin:-0.9 };
  // ritmo do Tennis Arena: bolas rápidas e tensas (≈0,65–0,9 s até ao ressalto), o topspin faz a bola cair dentro do campo
  const boost = q >= 1 ? 1 + m.perfectBoost * power : 1;
  return { speedH:(19 + power * 13 + q * 2 - (volley ? 3 : 0)) * boost * m.power, g:GRAV + 4 + power * 7,
    margin:(0.55 - power * 0.3) * (q >= 1 ? 0.8 : 1), spin:0.4 + power * 0.6 };
}
// amorti: arco curto que passa a rede e cai logo a seguir
function makeDrop(from, tx, tz, g, apex) {
  const vy = Math.sqrt(2 * g * Math.max(0.35, apex - from.y));
  const T = (vy + Math.sqrt(vy * vy + 2 * g * (from.y - BR))) / g;
  return new V3((tx - from.x) / T, vy, (tz - from.z) / T);
}
// altura do arco que passa a rede com folga (o erro de tempo aplica-se depois)
function dropApex(from, tx, tz, g, apex) {
  for (let i = 0; i < 25 && netClearance(from, makeDrop(from, tx, tz, g, apex), g) < 0.3; i++) apex += 0.08;
  return apex;
}
function executeShot(idx, sh) {
  const pl = P[idx], s = pl.side, r = -s;
  const from = B.p.clone(); if (from.y < 0.3) from.y = 0.3;
  const press = clamp((B.v.length() - 22) / 18, 0, 1);
  const spec = shotSpec(sh.type, sh.power, sh.q, B.bounces === 0, pl.mods);
  B.nextType = sh.type;
  const em = errMul(idx), q = sh.q, perfect = q >= 1;
  if (sh.type === 'drop') {
    // amorti: arriscado — com mau tempo fica curto na rede ou sai alto e longo
    const sd = (0.18 + (1 - q) * 1.1 + press * 0.4) * em * pl.mods.scatter * pl.mods.drop;
    const tx = sh.tx + gauss() * (0.15 + (1 - q) * 0.7) * em;
    const tz = sh.tz + r * (gauss() * sd + (1 - q) * 0.6 * Math.random() * em);
    const apex = dropApex(from, tx, tz, spec.g, spec.apex) + gauss() * (0.04 + (1 - q) * 0.3) * em - (1 - q) * 0.3 * Math.random() * em;
    const v = makeDrop(from, tx, tz, spec.g, apex);
    launch(idx, from, v, spec.g, false, false, q, spec.spin);
    return v;
  }
  // dispersão da bola: cresce com o erro de tempo e a potência, mas um swipe normal fica dentro do campo (como no Tennis Arena: falha quem arrisca)
  const sig = (sh.type === 'lob' ? 0.25 + (1 - q) * 0.8 + press * 0.25 : 0.08 + (1 - q) * 1.0 + sh.power * 0.5 + press * 0.3) * em * (perfect ? 0.45 : 1) * pl.mods.scatter * (B.bounces === 0 ? pl.mods.volley : 1);
  const pull = Math.sign(sh.err || 0) * (fhSide(pl) ? 1 : -1) * s * (1 - q) * 0.55 * em;
  const tx = sh.tx + gauss() * sig + pull;
  const tz = sh.tz + r * (gauss() * sig * 0.85 + (1 - q) * 0.35 * Math.random() * em);
  const margin = sh.margin ?? (spec.margin - Math.random() * (1 - q) * 0.9 * em - press * Math.random() * 0.2);
  const v = makeShot(from, tx, tz, spec.speedH, spec.g, margin);
  launch(idx, from, v, spec.g, false, false, q, spec.spin);
  return v;
}

// ---------------------------------------------------------------- serviço: tocar para lançar, swipe para servir
function serveTarget(idx, ax, ad) {
  const s = sideOf(idx), r = -s;
  return { tx:M.boxSign * HW / 2 + s * ax * HW * 0.42, tz:r * SVC * (0.45 + 0.5 * ad), ax, ad };
}
function startToss(idx, cpuAim) {
  if (M.phase !== 'preserve' || M.server !== idx || M.toss) return;
  M.toss = { idx, t0:simTime, aim:cpuAim || null, releaseAt:null };
  B.held = false;
  if (cpuAim) M.toss.releaseAt = clamp(T_IDEAL + gauss() * curL().svSig, 0.32, T_FAIL - 0.1);
  if (M.mode === 'online' && idx === M.me) netSend({ t:'toss' });
}
function failToss() {
  const idx = M.toss.idx; M.toss = null; B.held = true;
  if (M.mode === 'online' && idx === M.me) netSend({ t:'tossx' });
  if (idx === M.me) { toast('Lança outra vez', 'info', 'Desliza para cima quando a bola estiver lá em cima', 1200); touch.mode = null; touch.aim = null; }
  else if (P[idx].isCPU) after(0.8, cpuServe);
}
function releaseServe(idx, aim) {
  if (!M.toss || M.toss.idx !== idx || M.phase !== 'preserve') return;
  const tt = simTime - M.toss.t0;
  if (tt < 0.28) {
    M.toss = null; B.held = true;
    if (M.mode === 'online' && idx === M.me) netSend({ t:'tossx' });
    if (idx === M.me) toast('Cedo demais', 'info', 'Toca para lançar e desliza quando a bola estiver no ponto mais alto', 1300);
    else if (P[idx].isCPU) after(0.8, cpuServe);              // o CPU volta a lançar (antes ficava parado para sempre)
    return;
  }
  const err = tt - T_IDEAL, q = timingQ(err, greenWin() * P[idx].mods.window * P[idx].mods.serveWindow);
  const pl = P[idx], s = pl.side, r = -s, second = M.serveNum === 2;
  const from = new V3(pl.pos.x - s * 0.1, tossY(tt), pl.pos.z - s * 0.35);
  const sig = (0.09 + (1 - q) * 0.75 + (second ? 0 : aim.ad * 0.08)) * (second ? 0.55 : 1) * errMul(idx) * pl.mods.serveAcc;
  const tx = aim.tx + gauss() * sig;
  const tz = aim.tz + r * (gauss() * sig + (1 - q) * 0.3 * (Math.random() - 0.3));
  const lvl = pl.isCPU ? 0.72 + 0.3 * curL().svPow : 1;
  const speed = (second ? 20 + q * 6 : 23 + q * 12 + aim.ad * 4 + (q >= 1 ? 4 : 0)) * lvl * (second ? (1 + pl.mods.serve) / 2 : pl.mods.serve);
  const g = second ? GRAV + 7 : GRAV + 2;
  const margin = second ? 0.45 : 0.1 + (1 - q) * 0.15 - Math.random() * (1 - q) * 0.35;
  const v = makeShot(from, tx, tz, speed, g, margin);
  launch(idx, from, v, g, true, false, q, second ? 0.9 : 0.2);
  const kmh = Math.round(v.length() * 3.6);
  if (idx === M.me) {
    M.lastMine = { q, err, power:q, type:'serve' };
    popText(timingLabel(q, err), qCls(q), new V3(pl.pos.x, 1.9, pl.pos.z), kmh + ' km/h');
  } else popText(kmh + ' km/h', 'info', new V3(pl.pos.x, 2.4, pl.pos.z));
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
    // o ressalto aconteceu a meio do passo: recua até ao ponto exato onde a bola tocou no chão (senão a 140 km/h
    // a marca e a decisão dentro/fora ficavam até 30 cm à frente do sítio real)
    const tb = clamp((BR - B.p.y) / -B.v.y, 0, dt);
    B.p.x -= B.v.x * tb; B.p.z -= B.v.z * tb;
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
    B.p.x += B.v.x * tb; B.p.z += B.v.z * tb; B.p.y += Math.max(0, B.v.y) * tb;   // completa o passo já depois do ressalto
  }
  if (B.v.y === 0 && B.p.y <= BR + 1e-3) B.v.multiplyScalar(0.98);
}
function judgeBounce() {
  const hit = B.hitter, rc = other(hit), rs = sideOf(rc), x = B.p.x, z = B.p.z;
  if (B.bounces === 1) {
    const call = judgeFirstBounce({ x, z, isServe:B.isServe, receiverSide:rs, boxSign:M.boxSign });
    if (B.isServe && M.objective && objHook('serveBounce', { call, x, z })) return;
    if (B.isServe) {
      if (call === 'in' && B.netCord) callLet();
      else if (call !== 'in') callFault(call === 'fault-long' ? 'Falta · longa' : 'Falta');
    } else if (call === 'out') {
      if (Math.sign(z) === rs && outBy(x, z) < 0.3) sfx.ooh(0.7);
      endPoint(rc, 'Fora!');
    }
  } else if (B.bounces === 2) {
    if (B.isServe && M.objective && objHook('ace', {})) return;
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
  landRing.material.opacity = 0; M.pointHits = 0; sfx.hush(false); updateRally();
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
  if (myShotErr && reason === 'Fora!') countTip('out', 2, 'Bolas fortes e perto das linhas saem mais. Faz um swipe mais curto ou mais a direito para o meio do campo.');
  if (myShotErr && reason === 'Rede!') countTip('net', 1, 'Bateste na rede. Faz o swipe com a bola à tua frente: cedo ou tarde demais a bola sai baixa.');
  if (reason === 'Ponto!' && w !== M.me && B.hitter !== M.me && !P[M.me].swipe) countTip('move', 2, 'Toca no sítio para onde queres correr. A mancha amarela mostra onde a bola vai bater.');
  countPointStats(w, reason);
  if (M.objective) objHook('point', { w, reason, hits:M.pointHits || 0, last:B.shotType, hitter:B.hitter });
  M.phase = 'pointover'; M.score[w]++; M.pointsPlayed++;
  M.maxDeficit = Math.max(M.maxDeficit || 0, M.score[other(M.me)] - M.score[M.me]);
  M.lastWinner = w; M.pointEndT = simTime; M.toss = null;
  landRing.material.opacity = 0;
  const mine = w === M.me;
  if (mine && reason === 'Ponto!' && B.hitter === M.me) reason = 'Vencedor!';
  let sub = mine ? explainWin(reason) : explainLoss(reason);
  const over = isMatchOver(M.score);
  const mp = over ? -1 : matchPointFor(M.score);
  if (mp !== -1) sub += M.bestOf === 3 && M.sets[mp] < 1 ? ' · Set point' : ' · Match point';
  if ((M.pointHits || 0) >= 20) sub = M.pointHits + ' pancadas · ' + sub;
  if (reason === 'Ás!' && B.svKmh) sub += ' · ' + B.svKmh + ' km/h';
  toast(reason, mine ? 'good' : 'bad', sub, 1300);
  sfx.hush(false);
  const big = reason === 'Ás!' || reason === 'Vencedor!';
  if (reason === 'Ás!') fx.shake(0.1, 0.4);
  if (big) sfx.cheer(clamp(0.45 + (M.pointHits || 0) * 0.05, 0.5, 1));
  else sfx.applause(clamp(0.2 + (M.pointHits || 0) * 0.06, 0.2, 0.9));
  updateHUD();
  const special = (M.pointHits || 0) >= 16 || (over && w === M.me) || (reason === 'Ás!' && (B.svKmh || 0) >= 165);
  if (special && M.mode !== 'online' && M.mode !== 'challenge' && store.get('replays', 'on') !== 'off') after(0.8, () => startReplay(Math.min(5, 1.4 + (M.pointHits || 0) * 0.45)));
  if (!over) after(1.0, walkToPositions);
  after(2.3, () => { if (M.objective) { if (M.objective.done) objFinish(); else { if (M.objective.kind === 'rally') { M.score = [0, 0]; M.pointsPlayed = 0; } preparePoint(); } } else if (over) finishMatch(); else preparePoint(); });
}
// ---------------------------------------------------------------- desafios (treino da carreira e desafio do dia)
// kinds: serveTarget (N de 10 serviços numa zona), aces (N ases em 10 serviços), rally (troca de N pancadas),
// winners (N vencedores em 10 pontos), dropWinner (ganhar um ponto com um amorti em 8 pontos)
const OBJ_TEXT = {
  serveTarget:o => `Serviços ${o.zone === 'T' ? 'ao T' : 'abertos'}: ${o.score} · serviço ${Math.min(o.n + 1, o.max)}/${o.max} · objetivo ${o.goal}`,
  aces:o => `Ases: ${o.score} · serviços ${o.n}/${o.max} · objetivo ${o.goal}`,
  rally:o => `Melhor troca: ${o.score} · objetivo ${o.goal} · tentativa ${Math.min(o.n + 1, o.max)}/${o.max}`,
  winners:o => `Vencedores: ${o.score} · pontos ${o.n}/${o.max} · objetivo ${o.goal}`,
  dropWinner:o => `Amorti vencedor · ponto ${Math.min(o.n + 1, o.max)}/${o.max}`,
};
function objSetup(o) {
  o.n = 0; o.score = 0; o.done = false; o.passed = false;
  o.max = o.kind === 'rally' ? 4 : o.kind === 'dropWinner' ? 8 : 10;
  if (o.kind === 'serveTarget' || o.kind === 'aces') M.first = M.me;                 // servir sempre eu, do lado direito
  if (o.kind === 'rally') { M.L = { ...levelFor(30), q:0.93, miss:0, width:0.9, pow:[0.25, 0.4], depth:[7.6, 9.2], ace:0 }; M.first = M.me; }   // CPU colaborante; sirvo sempre eu
  updateObjHud();
}
function updateObjHud() {
  const o = M.objective, el = $('objHud');
  el.classList.toggle('hidden', !o || !inMatch()); $('hud').classList.toggle('obj', !!o);
  if (o) el.textContent = OBJ_TEXT[o.kind](o);
}
const inZone = (o, x) => (o.zone === 'T' ? Math.abs(x) < 0.75 : Math.abs(x) > HW - 0.75);   // ao T: até 75 cm da linha do meio; aberto: até 75 cm da lateral
// devolve true quando o desafio trata o acontecimento (o jogo normal não continua)
function objHook(ev, d) {
  const o = M.objective; if (!o || o.done && ev !== 'point') return false;
  const serveKind = o.kind === 'serveTarget' || o.kind === 'aces';
  const attemptOver = () => {
    o.n++; M.phase = 'pointover'; B.live = false; timers.length = 0; M.toss = null;
    if (o.score >= o.goal && o.kind !== 'serveTarget' && o.kind !== 'aces') o.done = true;
    if (o.n >= o.max) o.done = true;
    updateObjHud();
    after(0.9, () => { if (o.done) objFinish(); else { M.serveNum = 1; resetForServe(); } });
    return true;
  };
  if (ev === 'serveBounce' && serveKind && B.hitter === M.me) {
    if (d.call === 'in' && B.netCord) return false;                     // let: repete o serviço, não gasta tentativa
    if (o.kind === 'serveTarget') {
      const ok = d.call === 'in' && inZone(o, d.x);
      if (ok) { o.score++; popText('Na zona', 'gold', new V3(d.x, 0.6, d.z)); sfx.ui('toggle'); } else popText(d.call === 'in' ? 'Fora da zona' : 'Falta', 'bad', new V3(d.x, 0.6, d.z));
      return attemptOver();
    }
    if (d.call !== 'in') { popText('Falta', 'bad', new V3(d.x, 0.6, d.z)); return attemptOver(); }
    return false;                                                                       // ases: deixa o CPU tentar responder
  }
  if (ev === 'ace' && o.kind === 'aces') { o.score++; popText('Ás!', 'gold', new V3(B.p.x, 1, B.p.z)); sfx.cheer(0.5); return attemptOver(); }
  if (ev === 'shot' && o.kind === 'aces' && d.idx !== M.me && B.isServe) { popText('Devolvido', 'info', new V3(B.p.x, 1.4, B.p.z)); return attemptOver(); }
  if (ev === 'shot' && o.kind === 'rally' && (M.pointHits || 0) + 1 >= o.goal) {   // troca de bolas: acaba logo que chega ao objetivo
    o.score = (M.pointHits || 0) + 1; o.n++; o.done = true; updateObjHud();
    popText(o.score + ' pancadas!', 'gold', new V3(B.p.x, 1.6, B.p.z)); sfx.cheer(0.6);
    after(0.7, () => { M.phase = 'pointover'; B.live = false; objFinish(); });
    return false;
  }
  if (ev === 'fault' && serveKind) return attemptOver();
  if (ev === 'point' && !serveKind) {
    o.n++;
    if (o.kind === 'rally') o.score = Math.max(o.score, d.hits);
    if (o.kind === 'winners' && d.w === M.me && d.hitter === M.me && d.reason === 'Ponto!') o.score++;
    if (o.kind === 'dropWinner' && d.w === M.me && ((d.hitter === M.me && d.last === 'drop' && d.reason === 'Ponto!') || (d.hitter !== M.me && M.myLast === 'drop' && (d.reason === 'Fora!' || d.reason === 'Rede!')))) o.score = 1;
    if (o.score >= o.goal || o.n >= o.max) o.done = true;
    updateObjHud();
  }
  return false;
}
function objFinish() {
  const o = M.objective; if (!o || M.phase === 'over') return;
  o.passed = o.score >= o.goal; M.phase = 'over'; B.live = false; timers.length = 0;
  sfx.ui(o.passed ? 'win' : 'lose'); if (o.passed) { sfx.cheer(0.8); if (!o.daily) ach.unlock('challenge'); }
  $('endIcon').innerHTML = icon(o.passed ? 'trophy' : 'ball');
  $('endTitle').textContent = o.passed ? 'Objetivo cumprido' : 'Quase';
  $('endScore').innerHTML = o.score + (o.kind === 'rally' ? '<em> pancadas</em>' : o.kind === 'dropWinner' ? '' : '<em>/' + o.max + '</em>');
  $('endSub').textContent = (o.label || OBJ_TEXT[o.kind](o)) + ' · objetivo: ' + o.goal;
  $('endStats').innerHTML = '';
  $('bEndMain').textContent = o.retryLabel || 'Tentar outra vez'; $('bEndMain').disabled = false;
  $('bEndMenu').textContent = o.doneLabel || 'Continuar';
  updateObjHud();
  show('endScr');
  if (o.onDone) try { o.onDone({ id:o.id, kind:o.kind, score:o.score, goal:o.goal, passed:o.passed }); } catch (e) { console.warn(e); }
}
// arranca um desafio: obj = { id, kind, goal, zone?, label, level?, onDone(result), onRetry(), onExit() }
function startChallenge(obj, extra = {}) {
  obj = { label:objLabel(obj), ...obj };
  const lv = obj.cpuTotal ? null : (obj.level ?? 1), oc = charById(extra.opp || 'tudo');
  startMatch({ mode:'challenge', me:0, names:[myName(), oc.name], surface:extra.surface || 'hard', level:lv ?? 1, cpuTotal:obj.cpuTotal,
    first:0, chars:[extra.char || myChar(), oc.id], stats:extra.stats ? [extra.stats, null] : null, perks:extra.perks ? [extra.perks, []] : null, looks:extra.looks, objective:{ ...obj } });
  objSetup(M.objective);
  if (M.objective.kind === 'serveTarget' || M.objective.kind === 'aces') { M.score = [0, 0]; preparePoint(); }
}

// texto de cada desafio (treino e desafio do dia)
function objLabel(o) {
  if (o.kind === 'serveTarget') return `Põe ${o.goal} de 10 serviços ${o.zone === 'T' ? 'ao T, junto à linha do meio' : 'abertos, junto à linha lateral'}`;
  if (o.kind === 'aces') return `Faz ${o.goal} ${o.goal === 1 ? 'ás' : 'ases'} em 10 serviços`;
  if (o.kind === 'rally') return `Faz uma troca de ${o.goal} pancadas (o adversário colabora)`;
  if (o.kind === 'winners') return `${o.goal} vencedores em 10 pontos`;
  return 'Ganha um ponto com um amorti (tens 8 pontos)';
}

// ---------------------------------------------------------------- desafio do dia (igual para todos; conta o melhor resultado)
const todayUTC = () => new Date().toISOString().slice(0, 10);
function dailySpec(day) {
  let h = 2166136261; for (const c of day) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const r = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  const kinds = [{ kind:'serveTarget', goal:5, zone:'T' }, { kind:'serveTarget', goal:5, zone:'wide' }, { kind:'aces', goal:3 }, { kind:'rally', goal:25 }, { kind:'winners', goal:3 }];
  const k = kinds[(r() * kinds.length) | 0], ch = CHARACTERS[(r() * CHARACTERS.length) | 0], op = CHARACTERS[(r() * CHARACTERS.length) | 0];
  const surf = ['hard', 'clay', 'grass'][(r() * 3) | 0];
  return { ...k, id:'daily-' + day, day, char:ch.id, opp:op.id === ch.id ? 'tudo' : op.id, surface:surf, level:1, daily:true };
}
async function openDaily() {
  const day = todayUTC(), d = dailySpec(day), ch = charById(d.char), best = store.get('dailyBest', {})[day];
  $('dailyWhat').textContent = objLabel(d);
  $('dailyWho').textContent = 'Hoje jogas com ' + ch.name + ' (' + ch.style.toLowerCase() + ') · ' + SURFACES[d.surface].label;
  $('dailyBest').textContent = best !== undefined ? 'O teu melhor hoje: ' + best : 'Ainda não jogaste hoje';
  $('dailyBoard').innerHTML = online.hasAccount() ? '<li class="muted">A carregar…</li>' : '<li class="muted">Cria o perfil em "Jogar com amigos" para entrares na tabela com os teus amigos.</li>';
  show('dailyScr');
  if (!online.hasAccount()) return;
  try {
    if (best !== undefined) await online.dailyPost(day, best, objLabel(d)).catch(() => {});
    const r = await online.dailyGet(day);
    $('dailyBoard').innerHTML = (r.board || []).length ? r.board.map((b, i) => `<li class="${b.me ? 'me' : ''}"><span class="lr">${i + 1}</span><span class="ln">${escHtml(b.user.name)}</span><b>${Number(b.score) || 0}</b></li>`).join('')
      : '<li class="muted">Ainda ninguém jogou hoje. Sê o primeiro!</li>';
  } catch (e) { $('dailyBoard').innerHTML = '<li class="muted">Sem ligação à tabela.</li>'; }
}
function playDaily() {
  const d = dailySpec(todayUTC());
  startChallenge({ ...d, label:objLabel(d), retryLabel:'Tentar outra vez', doneLabel:'Tabela do dia',
    onDone:res => {
      const all = store.get('dailyBest', {}), prev = all[d.day];
      if (prev === undefined || res.score > prev) { all[d.day] = res.score; store.set('dailyBest', all); }
      // envia sempre o melhor do dia (o servidor guarda o máximo): um recorde feito sem rede ou antes de ter conta também entra na tabela
      if (online.hasAccount()) online.dailyPost(d.day, all[d.day], objLabel(d)).catch(() => {});
      ach.afterDaily(d.day);
    },
    onRetry:playDaily, onExit:openDaily }, { char:d.char, opp:d.opp, surface:d.surface });
}

// estatísticas de cada jogador no jogo (mostradas no fim e guardadas no perfil)
const newStats = () => ({ pointsWon:0, pointsPlayed:0, aces:0, doubleFaults:0, firstIn:0, firstTotal:0, firstWon:0, secondWon:0, secondTotal:0,
  winners:0, errors:0, fastestServe:0, longestRally:0, longestRallyWon:0 });
function countPointStats(w, reason) {
  const S = M.stats; if (!S) return;
  const sv = M.server, l = other(w), rally = M.pointHits || 0;
  S[w].pointsWon++; S[0].pointsPlayed++; S[1].pointsPlayed++;
  S[sv].firstTotal++;
  if (M.serveNum === 1) { S[sv].firstIn++; if (w === sv) S[sv].firstWon++; }
  else { S[sv].secondTotal++; if (w === sv) S[sv].secondWon++; }
  if (reason === 'Dupla falta') S[sv].doubleFaults++;
  if (reason === 'Ás!') S[w].aces++;
  if (reason === 'Ponto!' && B.hitter === w && !B.isServe) S[w].winners++;
  if ((reason === 'Fora!' || reason === 'Rede!') && B.hitter === l) S[l].errors++;
  for (const st of S) st.longestRally = Math.max(st.longestRally, rally);
  S[w].longestRallyWon = Math.max(S[w].longestRallyWon, rally);
}
// contador de pancadas: aparece a partir das 10, fica dourado nas 20 e celebra cada dezena
function updateRally() {
  const el = $('rally'), n = M.pointHits || 0, live = inMatch() && n >= 10;
  el.classList.toggle('show', live);
  if (!live) { el.classList.remove('hot'); return; }
  el.firstElementChild.textContent = n;
  el.classList.toggle('hot', n >= 20);
  if (n >= 20 && n % 10 === 0) { el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); sfx.ooh(0.4); }
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
  const timing = L.q !== undefined && L.q < 0.65 ? (L.err < 0 ? 'swipe cedo' : 'swipe tarde') : null;
  if (reason === 'Fora!' && mineShot) {
    const where = Math.abs(B.p.z) > HL ? 'Bola longa' : 'Bola larga';
    return where + ' · ' + (timing || (L.power > 0.8 ? 'potência a mais' : 'arriscaste perto da linha'));
  }
  if (reason === 'Rede!' && mineShot) return 'Na rede · ' + (timing || 'bola baixa e forte: swipe mais curto');
  if (reason === 'Ás!') return 'Não devolveste o serviço';
  if (reason === 'Dupla falta') return 'Dupla falta · no 2.º serviço joga mais seguro';
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
  if (M.objective && objHook('fault', { reason })) return;
  if (M.serveNum === 1) {
    timers.length = 0;
    M.serveNum = 2; M.phase = 'pointover'; M.lastWinner = -1; landRing.material.opacity = 0;
    toast(reason, 'info', '2.º serviço', 900);
    if (M.server === M.me) countTip('serve', 2, 'No serviço, faz o swipe quando a bola está no ponto mais alto. Um swipe mais curto e a direito entra mais vezes.');
    after(1.2, resetForServe);
  } else {
    M.phase = 'rally';
    applyPoint(other(M.server), 'Dupla falta');
  }
}

// ---------------------------------------------------------------- contacto com a bola
function legalFor(pl) { return B.bounces === 1 || (B.bounces === 0 && !B.isServe && Math.sign(B.p.z) === pl.side); }
function reachable(pl) { return legalFor(pl) && Math.abs(B.p.x - pl.pos.x) <= reachOf(pl) && B.p.y <= 2.7 && B.p.y >= 0.13; }   // bola a rasar o chão já não se apanha
function whiff(pl, msg) {
  pl.act = { type:fhSide(pl) ? 'fh' : 'bh', t:0, phase:'swing' }; pl.whiff = true;
  if (pl.idx === M.me && msg) {
    M.lastMine = { whiff:msg + (msg === 'Fora de alcance' ? ' · toca para correr até à bola' : ' · faz o swipe com a bola à tua frente') };
    popText(msg, 'bad', new V3(pl.pos.x, 1.9, pl.pos.z));
  }
}
function contactCheck(pl) {
  if (B.hitter === pl.idx || B.hitter < 0 || B.netHit || pl.remote) return;
  const s = pl.side;
  const d = (pl.pos.z - s * PLANE - B.p.z) * s;   // > 0: a bola ainda vem a caminho do plano de batimento
  const prev = pl.prevD; pl.prevD = d;
  if (!pl.isCPU && pl.swipe && pl.crossT === null && simTime - pl.swipe.t > 0.5) {
    pl.swipe = null;
    if (B.v.z * s > 0) { whiff(pl, 'Cedo demais'); pl.whiff = false; countTip('timing', 2, TIP_TIMING); }
  }
  if (prev === null || pl.whiff) return;
  if (prev > 0 && d <= 0) {
    pl.crossT = simTime;
    if (pl.isCPU) { cpuTryHit(pl); return; }
    if (pl.swipe) { const sw = pl.swipe; pl.swipe = null; tryHit(pl, sw, -(simTime - sw.t)); return; }
    if (pl.idx === M.me && touch.mode === 'swipe' && H().auto && touch.aim) { commitShot(touch.aim); const sw = pl.swipe; pl.swipe = null; tryHit(pl, sw, 0.09); return; }
  }
  if (!pl.isCPU && pl.swipe && pl.crossT !== null && d <= 0) {
    const late = simTime - pl.crossT, sw = pl.swipe; pl.swipe = null;
    if (late <= 0.3) tryHit(pl, sw, late); else { whiff(pl, 'Tarde demais'); countTip('timing', 2, TIP_TIMING); }
  }
}
const TIP_TIMING = 'Faz o swipe quando a bola chega à tua frente, à altura da cintura. Com o tempo certo a pancada sai perfeita e muito mais forte.';
function tryHit(pl, sw, err) {
  if (!reachable(pl)) { whiff(pl, 'Fora de alcance'); countTip('reach', 1, 'Toca no campo para correres até à bola, ou liga a Ajuda Total no menu.'); return; }
  const volley = B.bounces === 0;
  const mpp = matchPointFor(M.score);
  const clutch = mpp !== -1 && (M.bestOf !== 3 || M.sets[mpp] >= 1) ? pl.mods.clutch : 1;   // treinador mental: só no match point
  const q = timingQ(err, greenWin() * pl.mods.window * clutch * (B.isServe ? 1.5 : 1));
  const v = executeShot(pl.idx, { type:sw.type, tx:sw.tx, tz:sw.tz, power:sw.power, q, err });
  const name = sw.type === 'lob' ? 'Balão' : sw.type === 'drop' ? 'Amorti' : volley ? 'Vólei' : 'Topspin';
  M.lastMine = { q, err, power:sw.power, type:sw.type };
  popText(timingLabel(q, err), qCls(q), new V3(pl.pos.x, 1.9, pl.pos.z), name + ' · ' + Math.round(v.length() * 3.6) + ' km/h');
  if (q < 0.6) countTip('timing', 3, TIP_TIMING);
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
  const s = pl.side, samples = predictBall(3.5), nearNet = Math.abs(pl.pos.z) < 6.5 && !B.isServe;
  let best = null, bestD = Infinity, loose = null;
  for (const sm of samples) {
    const vol = nearNet && sm.b === 0 && Math.sign(sm.z) === s && Math.abs(sm.z) > 1.2;     // vólei: a bola ainda não bateu no meu campo
    if (!(sm.b === 1 || vol) || sm.vz * s <= 0 || sm.y > (vol ? 2.4 : 2.2)) continue;
    const fx = sm.x - s * 0.74, bx = sm.x + s * 0.6;          // onde os jogadores reais batem: direita mais afastada, esquerda a duas mãos mais junta
    const standX = Math.abs(fx - pl.pos.x) <= Math.abs(bx - pl.pos.x) + 0.4 ? fx : bx;
    const standZ = sm.z + s * PLANE;
    if (Math.abs(standZ) < 1.5 || Math.abs(standZ) > HL + 5) continue;
    const d = Math.hypot(standX - pl.pos.x, standZ - pl.pos.z);
    // como um jogador real: anda para o lado e fica fundo; avançar para a rede custa mais, a bola à altura da cintura é a preferida
    const fwd = Math.max(0, (pl.pos.z - standZ) * s), back = Math.max(0, (standZ - pl.pos.z) * s);
    const cost = Math.abs(standX - pl.pos.x) + fwd * 1.6 + back * 0.5 + Math.abs(sm.y - 1.0) * 0.8;
    if (d / speed > sm.t - delay - 0.05) continue;
    if (sm.y >= 0.5 && sm.y <= (vol ? 2.2 : 1.5)) { if (cost < bestD) { bestD = cost; best = { x:standX, z:standZ }; } }
    else if (!loose) loose = { x:standX, z:standZ };
  }
  if (best || loose) return best || loose;
  const fb = samples.find(q => q.b === 1);
  return fb ? { x:fb.x - s * 0.72, z:fb.z + s * 3 } : null;
}
// movimento assistido: assim que a bola vem, o jogador arranca sozinho e faz a maior parte do caminho (Normal 80%);
// na última meia-segundo antes do contacto, se estiver perto do sítio certo, acaba o caminho sozinho (com ou sem toque).
// Os toques servem para as bolas muito abertas e para escolher outra posição (subir à rede, recuar).
function humanAuto(pl) {
  const h = H();
  if (M.phase === 'rally' && B.live && !B.netHit && B.hitter >= 0 && B.hitter !== pl.idx) {
    if (!pl.autoPlan || pl.autoPlan.id !== B.hitId) pl.autoPlan = { id:B.hitId, at:-9, p:null, t0:simTime, start:{ x:pl.pos.x, z:pl.pos.z } };
    const ap = pl.autoPlan;
    if (simTime - ap.at > 0.25) { ap.at = simTime; ap.p = planIntercept(pl, RUN_SPEED * pl.mods.speed, 0.05); }
    const p = ap.p; if (!p) return;
    const manual = pl.manualId === B.hitId;
    const rem = pl.incoming && pl.incoming.id === B.hitId && pl.incoming.absT !== Infinity ? pl.incoming.absT - simTime : 9;
    const d = Math.hypot(p.x - pl.pos.x, p.z - pl.pos.z);
    if (rem < 0.55 && d < h.fine) { pl.target = { x:p.x, z:p.z }; pl.walk = false; return; }   // reta final: afina sozinho
    if (!manual) {
      if (simTime - ap.t0 < 0.1 + (B.isServe ? (B.svPress || 0) * 0.16 : 0)) return;   // tempo de reação (mais longo contra um serviço forte)
      const k = h.auto ? 1 : h.drift;
      pl.target = { x:ap.start.x + (p.x - ap.start.x) * k, z:ap.start.z + (p.z - ap.start.z) * k }; pl.walk = false;
    }
  }
}
// o toque não precisa de ser exato: perto do sítio ideal, o destino é puxado para lá
function magnetTap(pl, x, z) {
  const h = H(), p = pl.autoPlan && pl.autoPlan.id === B.hitId ? pl.autoPlan.p : null;
  if (!p || !h.magnet) return { x, z };
  const d = Math.hypot(p.x - x, p.z - z);
  if (d > h.magnet) return { x, z };
  const k = 0.55 * (1 - d / h.magnet) + 0.25;
  return { x:x + (p.x - x) * k, z:z + (p.z - z) * k };
}

// ---------------------------------------------------------------- CPU
const cpuSpeed = L => B.isServe && M.phase === 'rally' ? Math.max(L.speed, 6.3) : L.speed;
function cpuServe() {
  const pl = P[M.server]; if (!pl.isCPU || M.phase !== 'preserve') return;
  const big = pl.char && (pl.char.id === 'canhao' || pl.char.id === 'rede');            // grandes servidores apontam aos cantos
  startToss(pl.idx, big ? serveTarget(pl.idx, (Math.random() < 0.5 ? -1 : 1) * rand(0.6, 1), rand(0.75, 1)) : serveTarget(pl.idx, rand(-1, 1), rand(0.45, 1)));
}
// IA com comportamento humano: reação variável, erro de leitura que corrige a meio, recuperação para o centro
function cpuUpdate(pl) {
  const L = curL(), ai = pl.ai;
  if (M.phase === 'rally' && B.live && !B.netHit && B.hitter >= 0 && B.hitter !== pl.idx) {
    if (ai.planId !== B.hitId) {
      const k = 1 - L.q, misread = Math.random() < 0.25 * k;
      ai.planId = B.hitId; ai.planAt = simTime + (B.isServe ? L.react * 0.6 + (B.svPress || 0) * L.svRead : L.react) + Math.abs(gauss()) * 0.06; ai.plan = null; ai.fixed = false;
      ai.err = { x:gauss() * 0.35 * k + (misread ? Math.sign(gauss()) * rand(0.5, 0.9) : 0), z:gauss() * 0.5 * k };
    }
    if (simTime >= ai.planAt && (!ai.plan || (!ai.fixed && simTime >= ai.planAt + 0.35))) {
      if (ai.plan) { ai.fixed = true; ai.err.x *= 0.35; ai.err.z *= 0.35; }   // corrige a leitura a meio do caminho
      const p = planIntercept(pl, cpuSpeed(L) * pl.mods.speed, 0);
      ai.plan = p ? { x:p.x + ai.err.x, z:p.z + ai.err.z } : null;
    }
    if (ai.plan) { pl.target = ai.plan; pl.walk = false; }
  } else if (M.phase === 'rally' && B.hitter === pl.idx) {
    if (!ai.rec || ai.rec.id !== B.hitId) {
      const fb = predictBall(3).find(q => q.b === 1);
      ai.rec = { id:B.hitId, at:simTime + 0.18 + Math.random() * 0.12, x:clamp((fb ? fb.x : 0) * 0.35 + gauss() * 0.3, -1.8, 1.8), z:pl.side * (HL + rand(0.5, 1.1)) };
      // ataque à rede: depois de uma bola funda (ou do serviço), sobe para volear
      const rusher = pl.char && pl.char.id === 'rede', deep = fb && Math.abs(fb.z) > 8.5;
      if (rusher && deep && Math.random() < (B.isServe ? 0.5 : 0.6)) { ai.rec.z = pl.side * rand(2.6, 3.8); ai.rec.x = clamp((fb ? fb.x : 0) * 0.45, -2, 2); ai.rec.at = simTime + 0.05; }
    }
    if (simTime >= ai.rec.at) { pl.target = { x:ai.rec.x, z:ai.rec.z }; pl.walk = false; }
  }
}
function cpuTryHit(pl) {
  if (!reachable(pl)) { whiff(pl); return; }
  const L = curL();
  const coop = M.objective && M.objective.kind === 'rally';       // desafio de troca de bolas: o CPU só devolve
  // serviço forte e bem colocado: o CPU às vezes não consegue ler e falha a resposta (o ás tem de ser possível, mais nos níveis baixos)
  if (B.isServe && Math.random() < (B.svPress || 0) ** 2 * L.ace) { whiff(pl); return; }
  const foe = P[other(pl.idx)], r = -pl.side;
  const fx = foe.pos.x || rand(-1, 1);
  // estilo do tenista: muda a escolha da pancada (o Martelo arrisca as linhas, a Muralha joga funda e alta, o Artista usa amortis…)
  const ST = { martelo:{ w:1.12, lob:1, drop:1, depth:0.25, miss:1.2, pow:0.15 }, muralha:{ w:0.85, lob:1.8, drop:0.6, depth:0.45, miss:0.75, pow:-0.1 },
    artista:{ w:1.08, lob:1.4, drop:3, depth:0, miss:0.9, pow:-0.05 }, relampago:{ w:1.05, lob:1, drop:1, depth:0, miss:1, pow:0 },
    canhao:{ w:1, lob:0.8, drop:0.7, depth:0.1, miss:1.05, pow:0.05 }, rede:{ w:1.05, lob:0.7, drop:1.5, depth:0.2, miss:1, pow:0 } }[pl.char && pl.char.id] || { w:1, lob:1, drop:1, depth:0, miss:1, pow:0 };
  const stretched = Math.hypot(pl.vel.x, pl.vel.z) > 3.2 || Math.abs(B.p.x - pl.pos.x) > 1.25;   // a correr ou esticado: joga mais seguro
  const W = Math.min(3.4, L.width * ST.w);
  let tx = stretched ? rand(-1.2, 1.2) : Math.random() < 0.7 ? -Math.sign(fx) * rand(W * 0.5, W) : rand(-W, W) * 0.6;
  const lob = !coop && (Math.abs(foe.pos.z) < 6.5 ? Math.random() < 0.45 : Math.random() < (stretched ? 0.25 : 0.04) * ST.lob);
  if (!coop && !lob && !stretched && Math.abs(foe.pos.z) > HL - 0.6 && Math.random() < (0.05 + L.q * 0.08) * ST.drop) {
    executeShot(pl.idx, { type:'drop', tx:rand(-2.6, 2.6), tz:r * rand(1.8, 3.0), power:rand(0.2, 0.6), q:clamp(L.q + rand(-0.15, 0.12), 0.1, 1), err:0 });
    return;
  }
  let depth = lob ? rand(9, 10.8) : Math.min(10.9, rand(L.depth[0], L.depth[1]) + ST.depth);
  // erros não forçados: mais prováveis quando a bola vem forte
  const press = coop ? 0 : clamp((B.v.length() - 24) / 14, 0, 1);  // bola muito rápida (ritmo novo): mais erros
  if (!coop && Math.random() < (L.miss + press * 0.15) * ST.miss) {
    const kind = Math.random();
    if (kind < 0.4) depth = rand(12.2, 13.2);
    else if (kind < 0.75) tx = Math.sign(tx || 1) * rand(4.4, 5.2);
    else { executeShot(pl.idx, { type:'topspin', tx, tz:r * depth, power:0.9, q:0.2, err:0.2, margin:-0.35 }); return; }
  }
  executeShot(pl.idx, { type:lob ? 'lob' : 'topspin', tx, tz:r * depth, power:clamp(rand(L.pow[0], L.pow[1]) + ST.pow, 0.1, 1) * (stretched ? 0.75 : 1),
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
      const top = pl.walk ? WALK_SPEED : (pl.isCPU ? cpuSpeed(curL()) : RUN_SPEED) * pl.mods.speed;
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
    if (rem < (inc.b === 0 ? 0.6 : 0.85) && rem > -0.25) {          // direita/esquerda: preparação mais cedo, como os jogadores reais
      const fh = (inc.x - pl.pos.x) * pl.side >= 0;
      pl.act = { type:inc.b === 0 ? (fh ? 'vf' : 'vb') : (fh ? 'fh' : 'bh'), t:Math.min(-0.03, -rem), phase:'prep', h:inc.y, lat:Math.abs(inc.x - pl.pos.x), fw:PLANE };
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
// duas câmaras: "TV" (alta, campo todo) e "Perto" (atrás e acima do jogador, segue-o — mais perto da ação)
const CAM = { h:10.5, back:8.5, look:2.5, x:0 };
const CLOSE = { h:4.4, back:5.6, look:8.5, lookY:0.2, x:0, z:0 };
function resize() {
  const w = innerWidth, h = innerHeight, a = w / h;
  renderer.setSize(w, h, false);
  camera.aspect = a;
  camera.fov = clamp(2 * Math.atan(Math.tan(21 * Math.PI / 180) / a) * 180 / Math.PI, 46, 74);
  // vertical: de 21:9 (a≈0,43) a 16:9 (a≈0,56) o ponto de mira aproxima-se para o jogador ficar bem visível
  if (a < 0.8) {
    Object.assign(CAM, { h:10.8 + clamp(a - 0.46, 0, 0.3) * 6, back:9.8, look:0.6 - clamp(a - 0.46, -0.05, 0.3) * 13 });
    Object.assign(CLOSE, { h:5.4, back:6.0, look:8, lookY:-0.8 });
  } else {
    Object.assign(CAM, { h:10, back:11, look:-2.2 });     // horizontal (PC ou telemóvel rodado)
    Object.assign(CLOSE, { h:4.6, back:7, look:9, lookY:0 });
  }
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
const debugCam = { on:false, pos:[0, 2, 5], look:[0, 1, 0] };
const LAB = { on:false, idx:0, act:null, ball:null, mode:'ready' };
const camFrom = { pos:new V3(), look:new V3(), k:1 }, _cp = new V3(), _cl = new V3(), _lookNow = new V3();
function setCam(mode, animate = true) {
  if (animate && inMatch()) { camFrom.pos.copy(camera.position).sub(fx.offset); camFrom.look.copy(_lookNow); camFrom.k = 0; } else camFrom.k = 1;
  M.cam = mode; store.set('cam', mode);
  $('camBtn').classList.toggle('on', mode === 'close');
  $('camBtn').setAttribute('aria-label', mode === 'close' ? 'Câmara: perto (tocar para TV)' : 'Câmara: TV (tocar para perto)');
}
function updateCamera(dt, t) {
  if (debugCam.on) { camera.position.fromArray(debugCam.pos); camera.lookAt(...debugCam.look); return; }
  if (!inMatch()) {
    const a = t * 0.06;
    camera.position.set(Math.sin(a) * 24, 11, Math.cos(a) * 24); camera.lookAt(0, 0, 0); _lookNow.set(0, 0, 0); return;
  }
  const s = sideOf(M.me), me = P[M.me], px = me.pos.x;
  CAM.x += (px * 0.45 - CAM.x) * Math.min(1, dt * 3);
  CLOSE.x += (px * 0.8 - CLOSE.x) * Math.min(1, dt * 4);
  // atrás do jogador, sem passar a rede nem fugir demasiado para trás
  const zWant = s * clamp(Math.abs(me.pos.z) + CLOSE.back, HL - 1, HL + 9);
  CLOSE.z += (zWant - CLOSE.z) * Math.min(1, dt * 3);
  // como no Tennis Arena: a câmara roda para o lado da jogada (bola ou adversário), vendo o campo na diagonal
  const focusX = B.live && M.phase === 'rally' ? (Math.sign(B.p.z) === s ? B.p.x : (B.p.x + P[other(M.me)].pos.x) / 2) : P[other(M.me)].pos.x;
  CLOSE.bias = (CLOSE.bias || 0) + (clamp(focusX - px, -4.5, 4.5) - (CLOSE.bias || 0)) * Math.min(1, dt * 2.2);
  if (M.cam === 'close') { _cp.set(CLOSE.x - CLOSE.bias * 0.3, CLOSE.h, CLOSE.z); _cl.set(CLOSE.x * 0.55 + CLOSE.bias * 0.55, CLOSE.lookY, CLOSE.z - s * (CLOSE.back + CLOSE.look)); }
  else { _cp.set(CAM.x, CAM.h, s * (HL + CAM.back)); _cl.set(CAM.x * 0.4, 0, -s * CAM.look); }
  if (camFrom.k < 1) {                                            // transição suave entre câmaras
    camFrom.k = Math.min(1, camFrom.k + dt * 2.2);
    const e = camFrom.k * camFrom.k * (3 - 2 * camFrom.k);
    _cp.lerpVectors(camFrom.pos, _cp, e); _cl.lerpVectors(camFrom.look, _cl, e);
  }
  camera.position.copy(_cp); camera.lookAt(_cl); _lookNow.copy(_cl);
  camera.position.add(fx.offset);
}

// ---------------------------------------------------------------- input: tocar = correr · deslizar (swipe) = bater
// A pancada sai no momento em que o dedo termina o swipe: a direção do swipe dá a direção da bola,
// o comprimento dá a potência. Serviço: toca para lançar a bola ao ar e desliza para cima para servir.
const raycaster = new THREE.Raycaster(), ground = new THREE.Plane(new V3(0, 1, 0), 0), ndc = new THREE.Vector2();
const SWIPE_MIN = 26, TAP_MAX = 18;
const touch = { id:null, x0:0, y0:0, mode:null, aim:null };
const iServe = () => M.phase === 'preserve' && M.server === M.me && !P[M.me].remote;
canvas.addEventListener('pointerdown', e => {
  if (!inMatch() || M.phase === 'over' || touch.id !== null) return;
  audio();
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  Object.assign(touch, { id:e.pointerId, x0:e.clientX, y0:e.clientY, mode:'pending', aim:null });
  if (iServe()) { touch.mode = 'serve'; if (!M.toss) startToss(M.me); }   // o toque lança a bola; o swipe (no mesmo gesto ou noutro) serve
});
canvas.addEventListener('pointermove', e => {
  if (e.pointerId !== touch.id) return;
  const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0, L = Math.hypot(dx, dy);
  if (touch.mode === 'pending' && L > TAP_MAX && M.phase === 'rally') touch.mode = 'swipe';
  if (touch.mode === 'swipe') touch.aim = aimFromSwipe(dx, dy);
  if (touch.mode === 'serve') touch.aim = L > SWIPE_MIN && dy < -SWIPE_MIN * 0.6 ? serveAimFromSwipe(dx, dy) : null;
});
const endTouch = e => {
  if (e.pointerId !== touch.id) return;
  const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0, mode = touch.mode, L = Math.hypot(dx, dy);
  touch.id = null; touch.mode = null;
  if (e.type === 'pointercancel') { touch.aim = null; return; }
  if (mode === 'pending' && L < TAP_MAX) onTap(touch.x0, touch.y0);
  else if (mode === 'swipe' && L >= SWIPE_MIN) commitShot(aimFromSwipe(dx, dy));
  else if (mode === 'serve' && M.toss && M.toss.idx === M.me && L >= SWIPE_MIN && dy < -SWIPE_MIN * 0.6) releaseServe(M.me, serveAimFromSwipe(dx, dy));
  touch.aim = null;
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

// direção pelo ângulo do swipe (±30° = canto), potência pelo comprimento
const swipeX = (dx, dy) => clamp(dx / Math.max(42, Math.abs(dy)) * 1.75, -1, 1);
// ↑ topspin (swipe mais longo = mais forte e mais fundo) · ↓ curto = amorti · ↓ longo = balão
function aimFromSwipe(dx, dy) {
  const s = sideOf(M.me), r = -s, ax = swipeX(dx, dy);
  let type, depth, power;
  if (dy > 22 && dy > Math.abs(dx) * 0.55) {
    const d = clamp((dy - 22) / (innerHeight * 0.2), 0, 1);
    if (d < 0.4) { type = 'drop'; depth = 1.8 + d * 3; power = 0.2 + d; }
    else { const k = (d - 0.4) / 0.6; type = 'lob'; depth = 8.6 + k * 1.8; power = 0.2 + k * 0.5; }
  } else {
    const d = clamp((Math.hypot(dx, dy) - SWIPE_MIN) / (innerHeight * 0.24), 0, 1);
    type = 'topspin'; depth = 6.0 + d * 4.6; power = 0.15 + d * 0.85;
  }
  return { type, power, tx:s * ax * (HW - 0.95), tz:r * depth };   // o ângulo máximo aponta ~1 m dentro da linha lateral
}
// serviço: ângulo = lado da caixa (T ou aberto), comprimento = profundidade e velocidade
function serveAimFromSwipe(dx, dy) {
  const ad = clamp((-dy - SWIPE_MIN) / (innerHeight * 0.2), 0, 1);
  return serveTarget(M.me, swipeX(dx, dy), 0.35 + ad * 0.65);
}
function commitShot(aim) {
  if (M.phase !== 'rally' || !aim) return;
  P[M.me].swipe = { ...aim, t:simTime };
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
  const incoming = M.phase === 'rally' && B.hitter >= 0 && B.hitter !== M.me;
  me.target = incoming ? magnetTap(me, hit.x, hit.z) : { x:hit.x, z:hit.z }; me.walk = false;
  if (incoming) me.manualId = B.hitId;
  tapRing.position.set(hit.x, 0.006, hit.z); tapRing.material.opacity = 0.85;
}

// mira + trajetória prevista + barras
const AIM_NAMES = { topspin:'Topspin', drop:'Amorti', lob:'Balão' };
function showAimVisuals() {
  const me = P[M.me];
  const serving = iServe();
  const aim = (touch.mode === 'swipe' || (serving && touch.mode === 'serve')) ? touch.aim : null;
  const lbl = $('aimLbl');
  if (!aim) { aimRing.material.opacity = aimDot.material.opacity = 0; prevLine.visible = false; lbl.classList.remove('show'); return; }
  const lob = aim.type === 'lob', drop = aim.type === 'drop';
  const col = serving ? 0xd7f34a : lob ? 0xffa94d : drop ? 0x7cc8ff : 0xffffff;
  const sig = serving ? 0.5 : lob ? 0.75 : drop ? 0.5 : 0.45 + aim.power * 0.45;
  _pv.set(aim.tx, 0, aim.tz).project(camera);
  lbl.textContent = serving ? (M.serveNum === 2 ? '2.º serviço' : 'Serviço') : AIM_NAMES[aim.type] + (aim.type === 'topspin' ? ' · ' + Math.round(aim.power * 100) + '%' : '');
  lbl.className = 'show ' + (serving ? 'sv' : aim.type);
  lbl.style.transform = `translate(${(_pv.x * 0.5 + 0.5) * innerWidth}px,${(-_pv.y * 0.5 + 0.5) * innerHeight - 30}px) translate(-50%,-100%)`;
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
  else if (drop) { const sp = shotSpec('drop', aim.power, 1, false); g = sp.g; v = makeDrop(from, aim.tx, aim.tz, g, dropApex(from, aim.tx, aim.tz, g, sp.apex)); }
  else { const sp = shotSpec(aim.type, aim.power, 0.8, false); g = sp.g; v = makeShot(from, aim.tx, aim.tz, sp.speedH, g, sp.margin); }
  const T = (aim.tz - from.z) / v.z, arr = prevGeo.attributes.position.array;
  for (let i = 0; i < PREV_N; i++) { const t = T * i / (PREV_N - 1); arr[i * 3] = from.x + v.x * t; arr[i * 3 + 1] = Math.max(0.02, from.y + v.y * t - 0.5 * g * t * t); arr[i * 3 + 2] = from.z + v.z * t; }
  prevGeo.attributes.position.needsUpdate = true; prevLine.computeLineDistances(); prevLine.visible = true;
}


// ---------------------------------------------------------------- HUD
let toastTimer = null;
// etiqueta do resultado do ponto (topo, ao centro)
function toast(text, cls = 'info', sub = '', ms = 900) {
  const el = $('toast');
  el.className = cls + (sub ? '' : ' nosub');
  el.querySelector('.b-title').textContent = String(text).replace(/!$/, ''); el.querySelector('.b-sub').textContent = sub;
  void el.offsetWidth; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
let coachTimer = null;
const coachOn = () => M.coach !== 'off';
function coach(text) {
  if (!coachOn()) return;
  const el = $('coach'); el.querySelector('.ct').textContent = text; el.classList.add('show');
  clearTimeout(coachTimer); coachTimer = setTimeout(() => el.classList.remove('show'), 5200);
}
function hideCoach() { clearTimeout(coachTimer); $('coach').classList.remove('show'); }
$('coachX').addEventListener('click', hideCoach);
$('coachOff').addEventListener('click', () => {
  hideCoach(); setCoach('off'); updateHint();
  toast('Dicas desligadas', 'info', 'Podes voltar a ligá-las no menu', 1400);
});
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
  if (M.phase === 'preserve' && M.server === M.me) txt = (M.serveNum === 2 ? '2.º serviço' + (coachOn() ? ' · ' : '') : '') + (coachOn() ? 'Toca para lançar · desliza ↑ para servir' : '');
  else if (M.pointsPlayed < 3 && coachOn()) txt = 'Toca para correr · desliza (swipe) para bater';
  h.classList.toggle('hidden', !txt); h.firstElementChild.textContent = txt;
}
// sem anéis: a bola só brilha ligeiramente durante o instante ideal do swipe (aprende-se o ritmo, não se "encaixa" nada)
function updateHalo(dt, bp) {
  const me = P[M.me], g = greenWin() * me.mods.window;
  let want = 0;
  if (inMatch() && H().preview && !me.remote) {
    if (M.phase === 'rally' && me.incoming && me.incoming.absT !== Infinity && B.hitter >= 0 && B.hitter !== M.me && !me.whiff) {
      const rem = me.incoming.absT - simTime, gg = g * (B.isServe ? 1.5 : 1);
      if (Math.abs(rem) <= gg + 0.03) want = 0.85;
    } else if (M.toss && M.toss.idx === M.me && Math.abs(simTime - M.toss.t0 - T_IDEAL) <= g + 0.02) want = 0.85;
  }
  const m = halo.material;
  m.opacity = want > m.opacity ? want : Math.max(0, m.opacity - dt * 5);
  halo.visible = m.opacity > 0.01;
  halo.position.copy(bp); halo.scale.setScalar(ballMesh.scale.x * 0.42);
}
const qCls = q => (q >= 1 ? 'gold' : q >= 0.6 ? 'good' : q >= 0.3 ? 'warn' : 'bad');
// texto curto que sobe junto ao jogador (qualidade do timing, velocidade)
const pops = [];
function popText(text, cls, pos, sub) {
  const el = document.createElement('div'); el.className = 'pop ' + cls; el.textContent = text;
  if (sub) { const sm = document.createElement('small'); sm.textContent = sub; el.append(sm); }
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
const screens = ['menu', 'tourScr', 'endScr', 'msgScr', 'charScr', 'achScr', 'dailyScr', 'careerScr'];        // + os ecrãs do modo online (online.js)
function show(id) {
  for (const s of screens) $(s).classList.toggle('off', s !== id);
  const game = id === null;
  $('hud').classList.toggle('fade-out', !game); $('quit').classList.toggle('hidden', !game); $('camBtn').classList.toggle('hidden', !game);
  if (typeof updateObjHud === 'function') updateObjHud();
  if (!game) { $('hint').classList.add('hidden'); $('aimLbl').classList.remove('show'); hideCoach(); $('toast').classList.remove('show'); $('rally').classList.remove('show');
    for (const p of pops) p.el.remove(); pops.length = 0; }
}
const icon = (id, cls = 'i') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;
document.addEventListener('contextmenu', e => { if (!e.target.closest('input')) e.preventDefault(); });
function myName() { const n = ($('nameIn').value || '').trim(); return n || 'Jogador'; }
function saveName(n) { store.set('name', n); $('nameIn').value = n; }
// equipamento: o do perfil; o adversário nunca veste igual
const nLooks = () => LOOK_PRESETS.length;
const myChar = () => store.get('char', 'tudo');
const otherChar = id => { const o = CHARACTERS.filter(c => c.id !== id); return o[(Math.random() * o.length) | 0].id; };
const myLook = () => { const me = typeof online !== 'undefined' && online.me(); return me ? clamp(me.look | 0, 0, nLooks() - 1) : 0; };
const otherLook = (a, pref) => (pref === undefined || pref === a ? (a + 1 + ((Math.random() * (nLooks() - 1)) | 0)) % nLooks() : pref);

function startMatch(cfg) {
  Object.assign(M, { mode:cfg.mode, me:cfg.me, names:cfg.names, surface:cfg.surface, level:cfg.level ?? M.level,
    first:cfg.first, score:[0, 0], pointsPlayed:0, wantRematch:false, remoteRematch:false, tips:{}, counts:{}, toss:null, lastMine:{},
    stats:[newStats(), newStats()], matchId:cfg.matchId || null, game:cfg.game || 1, opp:cfg.opp || null,
    L:cfg.cpuTotal ? levelFor(cfg.cpuTotal) : null, chars:cfg.chars || [myChar(), 'tudo'], career:cfg.career || null,
    bestOf:cfg.bestOf || 1, sets:[0, 0], setScores:[], objective:cfg.objective || null, night:!!cfg.night, maxDeficit:0 });
  buildCourt(M.surface); setNight(M.night);
  P.forEach((p, i) => {
    p.isCPU = false; p.remote = false; p.target = null; p.swipe = null; p.act = null; p.ai.planId = -1;
    p.char = charById(M.chars[i]); p.stats = (cfg.stats && cfg.stats[i]) || p.char.stats;
    p.perks = ((cfg.perks && cfg.perks[i]) || []).concat(p.char.trait ? [p.char.trait] : []);
    p.mods = statMods(p.stats, p.perks);
    p.lookIdx = cfg.looks ? cfg.looks[i] : p.char.look;
  });
  if (!cfg.looks && P[0].lookIdx === P[1].lookIdx) P[1].lookIdx = otherLook(P[0].lookIdx);   // dois iguais: o adversário veste outra coisa
  P.forEach(p => p.fig.setLook(LOOK_PRESETS[p.lookIdx]));
  if (M.mode !== 'online') P[1].isCPU = true;                   // CPU em todos os modos sem amigo (rápido, torneio, carreira, desafios)
  if (M.mode === 'online') P[other(M.me)].remote = true;
  timers.length = 0;
  show(null); updateHUD();
  setTag();
  preparePoint();
  { const me = P[M.me], s = me.side; CLOSE.x = me.pos.x * 0.8; CLOSE.z = s * (Math.abs(me.pos.z) + CLOSE.back); CAM.x = me.pos.x * 0.45; camFrom.k = 1; }
  sfx.crowdBed(true); sfx.ui('start');
  coach(M.server === M.me ? 'Serviço: toca para lançar a bola e desliza para cima quando ela estiver lá em cima. O ângulo do swipe escolhe o lado, o comprimento a força.' : 'Quando a bola chegar à tua frente, desliza o dedo: ↑ topspin (mais longo = mais forte), ↓ curto amorti, ↓ longo balão. O jogador já corre um pouco para a bola; tu afinas a posição.');
  try { if (matchMedia('(pointer:coarse)').matches && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {}
}
function setTag() {
  const pre = M.mode === 'tour' ? TOUR[M.tourRound].round.toUpperCase() + ' · ' : M.mode === 'career' && M.career ? M.career.tag + ' · ' : '';
  $('tag').textContent = pre + SURFACES[M.surface].label.toUpperCase() + (M.night ? ' · NOITE' : '')
    + (M.bestOf === 3 ? ' · SET ' + (M.setScores.length + 1) + ' · ' + M.sets[M.me] + '–' + M.sets[other(M.me)] : ' · TIE BREAK A 10');
}
function finishMatch() {
  // melhor de 3 tie-breaks (meias-finais e finais dos Grand Slams na carreira)
  if (M.bestOf === 3) {
    const sw = M.score[0] > M.score[1] ? 0 : 1;
    M.sets[sw]++; M.setScores.push(M.score.slice());
    if (M.sets[sw] < 2) {
      toast('Set para ' + M.names[sw], sw === M.me ? 'good' : 'bad', M.score[M.me] + '–' + M.score[other(M.me)] + ' · sets ' + M.sets[M.me] + '–' + M.sets[other(M.me)], 1800);
      M.first = other(M.first); M.score = [0, 0]; M.pointsPlayed = 0; M.phase = 'pointover';
      setTag(); updateHUD(); after(1.8, preparePoint); return;
    }
  }
  M.phase = 'over'; updateHUD();
  const w = M.bestOf === 3 ? (M.sets[0] > M.sets[1] ? 0 : 1) : (M.score[0] > M.score[1] ? 0 : 1), won = w === M.me;
  $('endScore').innerHTML = M.bestOf === 3 ? M.sets[M.me] + '<em>–</em>' + M.sets[other(M.me)] : M.score[M.me] + '<em>–</em>' + M.score[other(M.me)];
  $('endIcon').innerHTML = icon(won ? 'trophy' : 'ball');
  $('endTitle').textContent = won ? 'Ganhaste' : 'Perdeste';
  let sub = 'contra ' + M.names[other(M.me)], main = 'Revanche';
  if (M.bestOf === 3) sub += ' · ' + M.setScores.map(x => x[M.me] + '–' + x[other(M.me)]).join(', ');
  if (M.mode === 'tour') {
    if (won && M.tourRound === TOUR.length - 1) { ach.unlock('tour_champ'); sub = 'Campeão do Torneio Atlântico!'; store.set('trophies', store.get('trophies', 0) + 1); main = 'Novo torneio'; M.tourRound = 0; }
    else if (won) { sub = 'Passaste às ' + TOUR[M.tourRound + 1].round; M.tourRound++; main = 'Continuar torneio'; }
    else { sub = 'Eliminado nos ' + TOUR[M.tourRound].round; main = 'Tentar outra vez'; }
  }
  sfx.ui(won ? 'win' : 'lose'); if (won) sfx.cheer(1);
  $('endSub').textContent = sub; $('bEndMain').textContent = main; $('bEndMain').disabled = false;
  renderStats(); $('bEndMenu').textContent = 'Menu';
  const tot = M.bestOf === 3 ? M.setScores.reduce((a, x) => [a[0] + x[M.me], a[1] + x[other(M.me)]], [0, 0]) : [M.score[M.me], M.score[other(M.me)]];
  ach.afterMatch({ mode:M.mode, won, level:M.L ? 1 : M.level, help:M.help, me:M.stats[M.me], score:tot,
    maxDeficit:M.maxDeficit, char:P[M.me].char && P[M.me].char.id, night:M.night });
  if (onMatchEnd) try { onMatchEnd({ won, w }); } catch (e) { console.warn('resultado não guardado', e); }
  if (M.mode === 'career') try {
    career.matchEnded({ won, score:M.bestOf === 3 ? [M.sets[M.me], M.sets[other(M.me)]] : [M.score[M.me], M.score[other(M.me)]],
      sets:M.bestOf === 3 ? M.setScores.map(x => [x[M.me], x[other(M.me)]]) : null, me:M.stats[M.me], maxDeficit:M.maxDeficit });
  } catch (e) { console.warn('carreira: resultado não registado', e); }
  show('endScr');
}
// quadro tipo transmissão: eu à esquerda, adversário à direita, o melhor valor de cada linha em destaque
function renderStats() {
  const a = M.stats[M.me], b = M.stats[other(M.me)];
  const pct = (n, d) => d ? Math.round(100 * n / d) : null;
  const rows = [
    ['Pontos ganhos', a.pointsWon, b.pointsWon],
    ['1.º serviço', pct(a.firstIn, a.firstTotal), pct(b.firstIn, b.firstTotal), '%'],
    ['Ganhos com o 1.º serviço', pct(a.firstWon, a.firstIn), pct(b.firstWon, b.firstIn), '%'],
    ['Ganhos com o 2.º serviço', pct(a.secondWon, a.secondTotal), pct(b.secondWon, b.secondTotal), '%'],
    ['Ases', a.aces, b.aces],
    ['Duplas faltas', a.doubleFaults, b.doubleFaults, '', true],
    ['Serviço mais rápido (km/h)', a.fastestServe || null, b.fastestServe || null],
    ['Vencedores', a.winners, b.winners],
    ['Erros', a.errors, b.errors, '', true],
  ];
  const fmt = (v, u) => v === null ? '–' : v + (u === '%' ? '%' : '');
  let html = `<div class="hd"><span>${escHtml(M.names[M.me])}</span><span></span><span>${escHtml(M.names[other(M.me)])}</span></div>`;
  for (const [lb, x, y, u = '', low = false] of rows) {
    const diff = x !== null && y !== null && x !== y, bx = diff && (low ? x < y : x > y), by = diff && !bx;
    html += `<div class="sr"><span class="v l${bx ? ' best' : ''}">${fmt(x, u)}</span><span class="lb">${lb}</span><span class="v r${by ? ' best' : ''}">${fmt(y, u)}</span></div>`;
  }
  html += `<div class="ft">Troca mais longa: <b>${a.longestRally} pancadas</b></div>`;
  $('endStats').innerHTML = html;
}
const escHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let onMatchEnd = null;                     // ligado pelo módulo online (guardar o resultado no perfil)
function goMenu() {
  endReplay(); REC.buf.length = 0; if (typeof refreshCareerBadge === 'function') refreshCareerBadge();
  M.mode = 'menu'; sfx.crowdBed(false); setNight(false);
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
  return v => { M[key] = v; store.set(key, v); paint(v); };
}
seg('segLevel', 'level', store.get('level', 1));
seg('segSurf', 'surface', store.get('surface', 'hard'));
seg('segTime', 'time', store.get('time', 'day'));
seg('segHelp', 'help', store.get('help', 'normal'));
const setCoach = seg('segCoach', 'coach', store.get('coach', 'on'));
buildCourt(M.surface);
saveName(store.get('name', ''));
$('nameIn').addEventListener('change', e => saveName(e.target.value.trim()));
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', goMenu));
document.addEventListener('click', e => {
  const b = e.target.closest('button, .btn'); if (!b) return;
  unlock(); sfx.ui(b.closest('.seg') ? 'toggle' : b.matches('[data-back], #quit, #bEndMenu') ? 'back' : 'tap');
});
$('quit').addEventListener('click', () => { if (M.mode !== 'online' || confirm('Sair do duelo?')) goMenu(); });
$('camBtn').addEventListener('click', () => { setCam(M.cam === 'close' ? 'tv' : 'close'); if (M.cam === 'close') toast('Câmara perto', 'info', 'Toca outra vez para a vista TV', 1000); });
setCam(store.get('cam', 'close'), false);                 // por omissão a câmara perto, atrás do jogador (como no Tennis Arena)

$('bQuick').addEventListener('click', () => {
  audio(); saveName(myName());
  const lv = store.get('level', 1);
  const oc = charById(otherChar(myChar()));
  startMatch({ mode:'cpu', me:0, names:[myName(), oc.name + ' · ' + LEVELS[lv].label], surface:store.get('surface', 'hard'), level:lv,
    first:Math.random() < 0.5 ? 0 : 1, chars:[myChar(), oc.id], night:store.get('time', 'day') === 'night' });
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
  startMatch({ mode:'tour', me:0, names:[myName(), r.opp], surface:r.surface, level:r.level, first:Math.random() < 0.5 ? 0 : 1, chars:[myChar(), r.char] });
});
$('bEndMain').addEventListener('click', () => {
  if (M.mode === 'challenge') { const o = M.objective; quietEnd(); if (o && o.onRetry) o.onRetry(); else if (o) startChallenge({ ...o, onDone:o.onDone, onRetry:o.onRetry, onExit:o.onExit }); return; }
  if (M.mode === 'career' && careerHooks.onMain) { quietEnd(); careerHooks.onMain(); return; }
  if (M.mode === 'tour') { renderBracket(); show('tourScr'); return; }
  if (M.mode === 'online') {
    M.wantRematch = true; netSend({ t:'rematch' }); $('bEndMain').textContent = 'À espera do amigo…'; $('bEndMain').disabled = true; maybeRematch(); return;
  }
  startMatch({ mode:'cpu', me:0, names:M.names, surface:M.surface, level:M.level, night:M.night, first:Math.random() < 0.5 ? 0 : 1, chars:[myChar(), M.chars[1]] });
});
$('bEndMenu').addEventListener('click', () => {
  if (M.mode === 'challenge' && M.objective && M.objective.onExit) { const f = M.objective.onExit; quietEnd(); $('bEndMenu').textContent = 'Menu'; f(); return; }
  if (M.mode === 'career' && careerHooks.onExit) { quietEnd(); careerHooks.onExit(); return; }
  $('bEndMenu').textContent = 'Menu'; goMenu();
});
const careerHooks = { onMain:null, onExit:null };          // ligados pelo modo carreira
function quietEnd() { M.mode = 'menu'; M.phase = 'idle'; timers.length = 0; B.live = false; M.toss = null; endReplay(); sfx.crowdBed(false); setNight(false); }

// ---------------------------------------------------------------- online (servidor próprio: perfis, lobby, convites; relé + ligação direta)
const NET = { rtt:0.1, pingT:null, lastPos:0, host:false, match:null, remoteChar:'tudo' };
const netSend = m => online.send(m);
function netClose() { clearInterval(NET.pingT); NET.pingT = null; online.close(); NET.match = null; NET.host = false; NET.remoteChar = 'tudo'; }
function netError(title, text) {
  // no fim do jogo não interrompe o quadro de estatísticas: só desliga a revanche
  if (M.mode === 'online' && M.phase === 'over' && !$('endScr').classList.contains('off')) {
    netClose(); $('bEndMain').textContent = 'O teu amigo saiu'; $('bEndMain').disabled = true; return;
  }
  M.mode = 'menu'; netClose(); sfx.crowdBed(false); timers.length = 0; B.live = false;
  $('msgTitle').textContent = title; $('msgText').textContent = text; show('msgScr');
}
function startPing() { clearInterval(NET.pingT); NET.pingT = setInterval(() => netSend({ t:'ping', c:performance.now() }), 2000); }
const online = createOnline({
  store, sfx, buzz, esc:escHtml, looks:LOOK_PRESETS.map(l => (l.shirt === 0xf4f4f4 ? l.shorts : l.shirt)),
  show, toast, goMenu, netError, inMatch, myName, setName:saveName, surface:() => store.get('surface', 'hard'), myChar:() => myChar(),
  onNet:m => onNet(m),
  betweenPoints:() => M.mode !== 'online' || M.phase !== 'rally',
  leaveForMatch:() => {                                          // vai começar um duelo: limpa qualquer jogo anterior (mesmo outro online já acabado)
    if (inMatch()) { M.mode = 'menu'; M.phase = 'idle'; timers.length = 0; B.live = false; M.toss = null; endReplay(); sfx.crowdBed(false); }
    clearInterval(NET.pingT); NET.host = false; NET.remoteChar = 'tudo'; NET.match = null;
  },
  hostStart:m => { NET.host = true; NET.match = m; startPing(); sendStart(); },
});
screens.push(...online.screens);
const ach = createAchievements({ store, toast, sfx, online });
function renderAch() {
  const all = ach.all(), n = all.filter(a => a.at).length;
  $('achCount').textContent = n + ' de ' + all.length;
  $('achList').innerHTML = all.map(a => `<li class="${a.at ? 'got' : ''}"><span class="ai">${icon(a.at ? 'trophy' : 'ball')}</span><span class="mi"><b>${escHtml(a.title)}</b><small>${escHtml(a.text)}</small></span></li>`).join('');
}
$('bAch').addEventListener('click', () => { renderAch(); show('achScr'); ach.sync(); });
$('bDaily').addEventListener('click', () => { audio(); openDaily(); });
// ---------------------------------------------------------------- carreira
const career = createCareer({
  store, show, toast, esc:escHtml, icon, startMatch, startChallenge, goMenu, myName, charById, careerHooks, ach, online, objLabel,
  lookColors:LOOK_PRESETS.map((l, i) => lookHex(i)),
  avatar:(u, cls = '') => `<span class="av ${cls}" style="--c:${lookHex(Number(u && u.look) || 0)}">${escHtml(((u && u.name) || '?').trim().charAt(0).toUpperCase())}</span>`,
});
$('bCareer').addEventListener('click', () => { audio(); career.open(); });
function refreshCareerBadge() { const s = career.summary(); const b = $('careerBadge'); b.textContent = s ? '#' + s.rank : ''; b.classList.toggle('hidden', !s); }
refreshCareerBadge();
$('bDailyPlay').addEventListener('click', () => { audio(); playDaily(); });
ach.onChange(() => { if (!$('achScr').classList.contains('off')) renderAch(); });
if (online.hasAccount()) setTimeout(() => ach.sync(), 4000);

// ---------------------------------------------------------------- reações rápidas no online (entre pontos)
const EMOTES = { boa:'Boa!', uau:'Uau!', sorte:'Sorte…', bora:'Bora!' };
let emoteAt = 0;
function showEmote(idx, k) {
  const p = P[idx]; if (!EMOTES[k]) return;
  popText(EMOTES[k], 'emote', new V3(p.pos.x, 2.5, p.pos.z));
}
$('emotes').addEventListener('click', e => {
  const b = e.target.closest('[data-emo]'); if (!b || M.mode !== 'online') return;
  const now = performance.now(); if (now - emoteAt < 1500) return; emoteAt = now;
  netSend({ t:'emote', k:b.dataset.emo }); showEmote(M.me, b.dataset.emo); buzz(10);
});
function updateEmotes() { $('emotes').classList.toggle('show', M.mode === 'online' && (M.phase === 'pointover' || M.phase === 'preserve' || M.phase === 'over') && !M.toss); }
const lookOf = u => clamp((u && u.look) | 0, 0, nLooks() - 1);
function sendStart() {
  const m = NET.match, me = online.me(); if (!m) return;
  const game = M.mode === 'online' && M.matchId === m.matchId ? M.game + 1 : 1;
  const chars = [myChar(), charById(NET.remoteChar).id];                       // cada um joga com o tenista que escolheu
  const cfg = { names:[me ? me.name : myName(), m.opp.name], surface:(m.cfg && m.cfg.surface) || 'hard', first:Math.random() < 0.5 ? 0 : 1, chars, matchId:m.matchId, game, night:store.get('time', 'day') === 'night' };
  netSend({ t:'start', ...cfg });
  startMatch({ mode:'online', me:0, ...cfg, opp:m.opp });
}
function maybeRematch() { if (NET.host && M.wantRematch && M.remoteRematch) sendStart(); }
function onNet(m) {
  switch (m.t) {
    case 'start': {
      const LK = online.link();
      if (!LK || LK.m.role !== 'guest') break;                        // só o convidado começa ao receber 'start'
      if (M.mode === 'online' && M.matchId === m.matchId && M.game === m.game && M.phase !== 'over') break;   // repetido
      const L = online.link(); NET.host = false; NET.match = L ? L.m : null; online.guestStarted(); startPing();
      startMatch({ mode:'online', me:1, names:m.names, surface:m.surface, first:m.first, night:!!m.night, chars:Array.isArray(m.chars) ? m.chars.map(c => charById(c).id) : ['tudo', 'tudo'], matchId:m.matchId, game:m.game, opp:NET.match && NET.match.opp });
      break;
    }
    case 'char': NET.remoteChar = String(m.id || 'tudo'); break;
    case 'emote': if (M.mode === 'online') showEmote(other(M.me), String(m.k)); break;
    case 'pos': { if (M.mode !== 'online') break; const p = P[other(M.me)]; p.netPos = { x:m.x, z:m.z }; break; }
    case 'toss': if (M.mode !== 'online') break; if (M.phase === 'pointover') runTimers(true); if (M.phase === 'preserve') { M.toss = { idx:other(M.me), t0:simTime, aim:null, releaseAt:null }; B.held = false; } break;
    case 'tossx': if (M.mode === 'online' && M.toss && M.toss.idx === other(M.me) && M.phase === 'preserve') { M.toss = null; B.held = true; } break;
    case 'hit': {
      if (M.mode !== 'online') break;
      if (M.phase === 'pointover') runTimers(true);
      const idx = other(M.me);
      if (P[idx].netPos) P[idx].pos.x = P[idx].netPos.x;
      launch(idx, new V3(...m.p), new V3(...m.v), m.g, !!m.s, true, 0.7, m.sp ?? 0.3);
      const lag = clamp(NET.rtt / 2, 0, 0.15);
      for (let t = 0; t < lag; t += STEP) stepBall(STEP);
      break;
    }
    case 'point': if (M.mode === 'online') applyPoint(m.w, m.r); break;
    case 'fault': if (M.mode === 'online') applyFault(m.r); break;
    case 'let': if (M.mode === 'online') applyLet(); break;
    case 'ping': netSend({ t:'pong', c:m.c }); break;
    case 'pong': NET.rtt = (performance.now() - m.c) / 1000; break;
    case 'rematch': M.remoteRematch = true; maybeRematch(); break;
    case 'bye': {
      const mid = M.mode === 'online' && M.phase !== 'over' && M.matchId && M.opp && online.me();
      if (mid) {                                                  // saiu a meio: vitória por desistência para quem fica
        const me = online.me(), ids = M.me === 0 ? [me.id, M.opp.id] : [M.opp.id, me.id];
        online.reportMatch({ mode:'online', matchId:M.matchId, game:M.game, winner:me.id, score:[M.score[0], M.score[1]], stats:{ [ids[0]]:M.stats[0], [ids[1]]:M.stats[1] } });
      }
      netError('Ligação terminada', mid ? 'O teu amigo saiu a meio. Ganhaste por desistência.' : 'O teu amigo saiu do jogo.'); break;
    }
  }
}
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), x => x.toString(16).padStart(2, '0')).join('');
// fim do jogo → resultado e estatísticas para o perfil (fica em fila se não houver rede)
onMatchEnd = ({ won, w }) => {
  if (!online.hasAccount()) return;
  if (M.mode === 'online' && M.matchId && M.opp) {
    const me = online.me(); if (!me) return;
    const ids = M.me === 0 ? [me.id, M.opp.id] : [M.opp.id, me.id];            // índice 0 = quem convidou (anfitrião)
    online.reportMatch({ mode:'online', matchId:M.matchId, game:M.game, winner:ids[w], score:[M.score[0], M.score[1]], stats:{ [ids[0]]:M.stats[0], [ids[1]]:M.stats[1] } });
  } else if (M.mode === 'cpu' || M.mode === 'tour') {
    online.reportMatch({ mode:'cpu', clientId:randomId(), level:M.level, won, score:[M.score[M.me], M.score[other(M.me)]], stats:M.stats[M.me] });
  }
};
const OFFLINE_MSG = 'O jogo com amigos precisa de internet. Sem ligação podes jogar contra o CPU ou o torneio.';
// ---------------------------------------------------------------- escolher tenista
let charReturn = 'menu';
function lookHex(i) { const l = LOOK_PRESETS[i] || LOOK_PRESETS[0]; return '#' + (l.shirt === 0xf4f4f4 ? l.shorts : l.shirt).toString(16).padStart(6, '0'); }
const charLabel = c => c.name;
function renderCharChips() {
  const c = charById(myChar());
  const html = `<span class="av" style="--c:${lookHex(c.look)}">${escHtml(c.name[0])}</span><span class="mi"><small>O teu tenista · ${escHtml(c.style)}</small><b>${escHtml(charLabel(c))}</b></span><span class="chg">Trocar</span>`;
  $('bChar').innerHTML = html; $('bCharLobby').innerHTML = html;
}
function renderChars() {
  const cur = myChar();
  $('charList').innerHTML = CHARACTERS.map(c => `<button type="button" class="ch${c.id === cur ? ' on' : ''}" data-char="${c.id}">
    <span class="ch-h"><span class="av" style="--c:${lookHex(c.look)}">${escHtml(c.name[0])}</span><span class="mi"><b>${escHtml(charLabel(c))}</b><small>${escHtml(c.style)}</small></span><i class="ch-ok">✓</i></span>
    <span class="ch-bars">${STATS.map(k => `<span class="bar"><em>${STAT_LABELS[k]}</em><i style="--v:${c.stats[k] / 10}"></i><b>${c.stats[k]}</b></span>`).join('')}</span>
    <span class="ch-blurb">${escHtml(c.blurb)}</span></button>`).join('');
}
function openChars(from) { charReturn = from; renderChars(); show('charScr'); }
const charBack = () => (charReturn === 'lobby' ? online.openLobby() : goMenu());
$('charList').addEventListener('click', e => {
  const b = e.target.closest('[data-char]'); if (!b) return;
  store.set('char', b.dataset.char); renderChars(); renderCharChips(); setTimeout(charBack, 160);
});
$('bChar').addEventListener('click', () => openChars('menu'));
$('bCharLobby').addEventListener('click', () => openChars('lobby'));
$('bCharBack').addEventListener('click', charBack);
renderCharChips();

$('bFriend').addEventListener('click', () => { audio(); saveName(myName()); if (!navigator.onLine) return netError('Sem internet', OFFLINE_MSG); online.openLobby(); });

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
// ---------------------------------------------------------------- repetição dos grandes pontos (câmara lenta, vista de lado)
const REC = { buf:[], max:420 };
const _rv = new V3(), _rl = new V3();
function recordFrame(bp, showBall) {
  if (M.replay || !inMatch() || M.mode === 'online' || M.mode === 'challenge' || M.phase === 'over') return;
  REC.buf.push({ t:simTime, b:[bp.x, bp.y, bp.z], on:showBall, p:P.map(pl => ({ x:pl.pp.x + (pl.pos.x - pl.pp.x) * alpha, z:pl.pp.z + (pl.pos.z - pl.pp.z) * alpha,
    vx:pl.vel.x, vz:pl.vel.z, act:pl.act ? { ...pl.act } : null, mode:figMode(pl), split:simTime - (pl.splitAt ?? -9) })) });
  while (REC.buf.length && (simTime - REC.buf[0].t > 7 || REC.buf.length > 1200)) REC.buf.shift();
}
function startReplay(span = 3.6) {
  const end = simTime, frames = REC.buf.filter(f => f.t >= Math.max(end - span, M.pointStartT || 0) - 0.2 && f.t <= end);
  if (frames.length < 20) return;
  M.replay = { frames, t:0, t0:frames[0].t, dur:frames[frames.length - 1].t - frames[0].t, speed:0.55, side:Math.random() < 0.5 ? -1 : 1 };
  $('replayTag').classList.add('show'); $('toast').classList.remove('show'); $('quit').classList.add('hidden'); $('camBtn').classList.add('hidden');
}
function endReplay() {
  if (!M.replay) return; M.replay = null; $('replayTag').classList.remove('show');
  if (inMatch()) { $('quit').classList.remove('hidden'); $('camBtn').classList.remove('hidden'); }
}
let swallowClick = 0;
addEventListener('pointerdown', e => { if (M.replay) { e.stopPropagation(); e.preventDefault(); endReplay(); swallowClick = performance.now(); } }, true);
addEventListener('click', e => { if (performance.now() - swallowClick < 700) { e.stopPropagation(); e.preventDefault(); swallowClick = 0; } }, true);   // o toque que salta a repetição não carrega em nada
function replayFrame(dt) {
  const R = M.replay; R.t += dt * R.speed;
  if (R.t >= R.dur) { endReplay(); return; }
  const want = R.t0 + R.t; let i = R.frames.findIndex(f => f.t >= want); if (i < 0) i = R.frames.length - 1;
  const f = R.frames[i];
  P.forEach((pl, k) => { const s = f.p[k]; pl.fig.update(dt * R.speed, { x:s.x, z:s.z, vx:s.vx, vz:s.vz, side:pl.side, ball:f.on ? _rv.set(...f.b) : null, act:s.act, mode:s.mode, split:s.split }); });
  ballMesh.visible = blob.visible = f.on; ballMesh.position.set(...f.b); ballMesh.scale.setScalar(1.2); ballMesh.quaternion.identity();
  blob.position.set(f.b[0], 0.005, f.b[2]);
  // câmara de transmissão: ao lado do campo, baixa, a seguir a bola
  _rl.set(R.side * 15.5, 3.4, clamp(f.b[2] * 0.55, -9, 9));
  camera.position.lerp(_rl, R.t < 0.05 ? 1 : Math.min(1, dt * 3));
  camera.lookAt(f.b[0] * 0.4, 0.9, f.b[2] * 0.8);
  fx.update(dt * R.speed); updatePops(dt);
}

function frame(now, manual) {
  const rawDt = (now - last) / 1000;
  const dt = clamp(rawDt, 0, 0.05); last = Math.max(last, now);
  if (!manual) perfTick(rawDt);
  if (M.replay) { replayFrame(dt); renderer.render(scene, camera); if (!manual) requestAnimationFrame(frame); return; }
  if (inMatch() && M.phase !== 'over' && now >= hitStopUntil) {
    acc += dt;
    while (acc >= STEP) { step(STEP); acc -= STEP; }
    alpha = acc / STEP;
    if (M.mode === 'online' && now - NET.lastPos > (online.via() === 'direta' ? 66 : 100)) { NET.lastPos = now; const me = P[M.me]; netSend({ t:'pos', x:+me.pos.x.toFixed(3), z:+me.pos.z.toFixed(3) }); }
  }
  if (B.held && M.phase === 'preserve') {
    const sv = P[M.server], s = sv.side;
    B.p.set(sv.pos.x - s * 0.1, 0.06 + Math.abs(Math.sin(simTime * 4.2)) * 0.85, sv.pos.z - s * 0.4);
  }
  for (const pl of P) {
    if (!inMatch()) { pl.vel.x = pl.vel.z = 0; }
    const lab = LAB.on && LAB.idx === pl.idx;            // só para testes: pose fixa num instante da pancada
    if (!lab) updateAct(pl, dt);
    const ix = pl.pp.x + (pl.pos.x - pl.pp.x) * alpha, iz = pl.pp.z + (pl.pos.z - pl.pp.z) * alpha;
    pl.fig.update(dt, { x:ix, z:iz, vx:lab ? 0 : pl.vel.x, vz:lab ? 0 : pl.vel.z, side:pl.side,
      ball:lab ? LAB.ball : inMatch() && (B.live || B.held || M.toss) ? B.p : null, act:lab ? LAB.act : pl.act, mode:lab ? LAB.mode : figMode(pl),
      split:simTime - (pl.splitAt ?? -9), snap:lab });
  }
  const showBall = inMatch() && (B.live || B.held || !!M.toss);
  ballMesh.visible = blob.visible = showBall;
  const bsp = B.live ? B.v.length() : 0;
  const bp = B.held ? B.p : _bp.lerpVectors(B.pp, B.p, alpha);
  ballMesh.position.copy(bp);
  // squash & stretch: estica com a velocidade, achata no impacto e no ressalto
  const base = clamp(camera.position.distanceTo(bp) / 15, 1, 1.9);   // bola real (≈4 cm), só um pouco maior ao longe para se ver
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
  updateHalo(dt, bp); updateLandMarks(dt); updateEmotes(); recordFrame(bp, showBall);
  updatePops(dt);
  updateCamera(dt, now / 1000);
  renderer.render(scene, camera);
  if (!manual) requestAnimationFrame(frame);
}
renderer.compile(scene, camera);
requestAnimationFrame(frame);
// avança o jogo à mão (só para testes automáticos)
function advance(sec) { const n = Math.round(sec / 0.02); for (let i = 0; i < n; i++) { fakeNow = Math.max(fakeNow, last) + 20; frame(fakeNow, true); } }

// ---------------------------------------------------------------- app instalável (offline, instalar, atualizar)
const isStandalone = () => matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvt = null, updateAsked = false;
function refreshInstall() {
  const b = $('bInstall');
  b.classList.toggle('hidden', isStandalone() || !(installEvt || isIOS));
}
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; refreshInstall(); });
addEventListener('appinstalled', () => { installEvt = null; refreshInstall(); });
$('bInstall').addEventListener('click', async () => {
  if (installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch (e) {} installEvt = null; refreshInstall(); return; }
  $('msgTitle').textContent = 'Instalar no iPhone';
  $('msgText').textContent = 'No Safari, toca no botão Partilhar e depois em "Adicionar ao ecrã principal". O jogo fica com ícone e abre sem internet.';
  show('msgScr');
});
refreshInstall();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || /[?&]sw=1/.test(location.search))) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = () => {
      if (!reg.waiting || !navigator.serviceWorker.controller) return;
      const apply = () => { updateAsked = true; reg.waiting.postMessage('skipWaiting'); };
      // os amigos têm de ter a mesma versão para jogarem online: ao abrir o jogo (ainda sem jogo a decorrer) atualiza logo
      if (!inMatch() && performance.now() < 20000) return apply();
      $('bUpdate').classList.remove('hidden'); $('bUpdate').onclick = apply;
    };
    offer();
    reg.addEventListener('updatefound', () => { const w = reg.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(); }); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateAsked) location.reload(); });
}

const oldInvite = /[#&]d=[a-z0-9]+/.test(location.hash);
const friendLinkOpened = online.init();
if (oldInvite) {
  history.replaceState(null, '', location.pathname + location.search);
  netError('Convites novos', 'Agora os desafios são feitos dentro do jogo. Toca em "Jogar com amigos", cria o teu perfil e adiciona o teu amigo pelo código ou pelo link de amigo.');
} else if (friendLinkOpened && !online.hasAccount()) { goMenu(); online.openProfileSetup(); }
else goMenu();

// ganchos para testes
window.__dt = { M, B, P, startMatch, startChallenge, NET, online, advance, predictBall, touch, aimFromSwipe, serveAimFromSwipe, commitShot, startToss, releaseServe, serveTarget, onTap, camera, debugCam, CLOSE, CAM, setCam, LAB, render:() => renderer.render(scene, camera),
  freeze(on) { hitStopUntil = on ? Infinity : 0; }, renderer, perf,
  simulate(sec) { for (let t = 0; t < sec; t += STEP) step(STEP); },
  get simTime() { return simTime; } };
