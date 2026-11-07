// Jogador 3D articulado (anca, joelhos, ombros, cotovelos, pulsos, cabeça) com animações de ténis.
// O modelo olha para +z; o lado esquerdo do jogador é +x e o direito (mão da raquete) é -x.
// As poses são escritas no referencial do jogador (pés no chão, +z = para a rede) e resolvidas com IK de 2 ossos.
import * as THREE from './vendor/three.module.min.js';

const UPPER = 0.30, FORE = 0.27, THIGH = 0.46, SHIN = 0.45, ANKLE = 0.075, HIP_H = 0.955;
const DOWN = new THREE.Vector3(0, -1, 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const smooth = u => u * u * (3 - 2 * u);

// ---------------------------------------------------------------- poses
// c: agachamento 0..1 · lean: inclinação do tronco · twist: rotação dos ombros · pyaw: rotação da anca
// hr: mão direita · ra: eixo da raquete · rf: normal da face · hl: mão esquerda · hg: 1 = mão esquerda no punho
const P = (o) => Object.assign({ c:0.4, lean:0.25, twist:0, pyaw:0, hr:[-0.1, 0.98, 0.42], ra:[0.12, 0.45, 0.88], rf:[1, 0, 0],
  hl:[0.2, 1.0, 0.3], hg:0, pr:[-1, -0.6, -0.5], pl:[1, -0.6, -0.5] }, o);
const READY = P({ c:0.42, lean:0.28, hg:1 });
const WALK = P({ c:0.05, lean:0.05, hr:[-0.28, 0.92, 0.12], ra:[0, -0.55, 0.83], rf:[1, 0, 0], hl:[0.24, 0.9, 0.05] });
const HAPPY = P({ c:0.3, lean:0.05, hr:[-0.27, 0.95, 0.12], ra:[0, -0.9, 0.4], hl:[0.24, 1.42, 0.28], pl:[1, -0.2, -1] });
const SAD = P({ c:0.0, lean:0.38, hr:[-0.26, 0.82, 0.08], ra:[0, -0.95, 0.3], hl:[0.22, 0.92, -0.02], pl:[1, 0.2, -1] });
const SV_IDLE = P({ c:0.12, lean:0.12, twist:0.15, pyaw:-0.85, hr:[-0.22, 0.95, 0.25], ra:[0.05, -0.3, 0.95], rf:[1, 0, 0], hl:[0.06, 0.95, 0.38] });

const FH_PREP = P({ c:0.5, lean:0.18, twist:-1.0, pyaw:-0.35, hr:[-0.5, 1.25, -0.35], ra:[-0.1, 0.55, -0.83], rf:[-0.8, 0, 0.3], hl:[0.18, 1.2, 0.48], pr:[-0.6, -1, -0.3] });
const FH_DROP = P({ c:0.48, lean:0.2, twist:-0.85, pyaw:-0.3, hr:[-0.58, 0.88, -0.28], ra:[-0.2, -0.55, -0.8], rf:[-0.3, 0, 0.95], hl:[0.25, 1.15, 0.42], pr:[-0.6, -1, -0.3] });
const FH_HIT = P({ c:0.42, lean:0.22, twist:0.05, pyaw:0, hr:[-0.46, 0.98, 0.32], ra:[-0.75, 0.08, 0.65], rf:[0.1, 0.05, 1], hl:[0.34, 1.12, 0.25], pr:[-0.5, -1, -0.6] });
const FH_FOLLOW = P({ c:0.36, lean:0.2, twist:0.7, pyaw:0.25, hr:[0.2, 1.48, 0.25], ra:[0.45, 0.35, -0.82], rf:[0.6, -0.2, 0.4], hl:[0.26, 1.28, 0.3], pr:[-0.2, -1, 0.2] });

const BH_PREP = P({ c:0.5, lean:0.18, twist:0.85, pyaw:0.35, hr:[0.3, 1.15, -0.1], ra:[0.1, 0.55, -0.83], rf:[0.8, 0, 0.3], hg:1, pr:[-0.3, -1, 0.3] });
const BH_DROP = P({ c:0.48, lean:0.2, twist:0.75, pyaw:0.3, hr:[0.32, 0.86, -0.1], ra:[0.2, -0.55, -0.8], rf:[0.3, 0, 0.95], hg:1, pr:[-0.3, -1, 0.3] });
const BH_HIT = P({ c:0.42, lean:0.22, twist:0.2, pyaw:0.1, hr:[0.26, 0.98, 0.36], ra:[0.86, 0.08, 0.5], rf:[-0.1, 0.05, 1], hg:1, pr:[-0.5, -1, -0.2] });
const BH_FOLLOW = P({ c:0.36, lean:0.2, twist:-0.7, pyaw:-0.25, hr:[-0.12, 1.45, 0.22], ra:[-0.45, 0.35, -0.82], rf:[-0.6, -0.2, 0.4], hg:1, pr:[-0.6, -1, -0.2] });

const VF_PREP = P({ c:0.48, lean:0.28, twist:-0.5, pyaw:-0.2, hr:[-0.42, 1.2, 0.18], ra:[-0.3, 0.75, 0.4], rf:[0, 0, 1], hl:[0.12, 1.2, 0.45] });
const VF_HIT = P({ c:0.5, lean:0.3, twist:-0.15, hr:[-0.42, 1.1, 0.48], ra:[-0.55, 0.45, 0.65], rf:[0.1, 0.1, 1], hl:[0.22, 1.15, 0.4] });
const VB_PREP = P({ c:0.48, lean:0.28, twist:0.5, pyaw:0.2, hr:[0.12, 1.2, 0.2], ra:[0.3, 0.75, 0.4], rf:[0, 0, 1], hg:1 });
const VB_HIT = P({ c:0.5, lean:0.3, twist:0.15, hr:[0.2, 1.1, 0.45], ra:[0.55, 0.45, 0.65], rf:[-0.1, 0.1, 1], hl:[0.3, 1.1, 0.3] });

const SV_TOSS = P({ c:0.2, lean:0.0, twist:0.1, pyaw:-0.85, hr:[-0.32, 1.2, -0.1], ra:[0, 0.3, -0.95], rf:[1, 0, 0], hl:[0.1, 1.65, 0.3], pl:[1, -0.3, -0.3] });
const SV_TROPHY = P({ c:0.5, lean:-0.2, twist:-0.3, pyaw:-0.85, hr:[-0.36, 1.55, -0.25], ra:[0.05, 0.6, -0.8], rf:[1, 0, 0], hl:[0.12, 1.95, 0.15], pr:[-1, 0.2, -0.4], pl:[1, -0.2, -0.3] });
const SV_HIT = P({ c:0.0, lean:0.12, twist:0.2, pyaw:-0.4, hr:[-0.12, 1.98, 0.25], ra:[0.05, 0.93, 0.36], rf:[0, 0.3, 1], hl:[0.24, 1.35, 0.28], pr:[-1, 0, 0] });
const SV_FOLLOW = P({ c:0.32, lean:0.45, twist:0.6, pyaw:0, hr:[0.28, 0.85, 0.3], ra:[0.2, -0.85, 0.4], rf:[0, 0, 1], hl:[0.2, 1.0, 0.22], pr:[-0.3, -1, 0.2] });

const TRACKS = {
  fh: [[-0.6, READY], [-0.36, FH_PREP], [-0.12, FH_DROP], [0, FH_HIT], [0.18, FH_FOLLOW], [0.45, FH_FOLLOW], [0.8, READY]],
  bh: [[-0.6, READY], [-0.36, BH_PREP], [-0.12, BH_DROP], [0, BH_HIT], [0.18, BH_FOLLOW], [0.45, BH_FOLLOW], [0.8, READY]],
  vf: [[-0.4, READY], [-0.2, VF_PREP], [0, VF_HIT], [0.15, VF_HIT], [0.45, READY]],
  vb: [[-0.4, READY], [-0.2, VB_PREP], [0, VB_HIT], [0.15, VB_HIT], [0.45, READY]],
  sv: [[-0.75, SV_IDLE], [-0.5, SV_TOSS], [-0.16, SV_TROPHY], [0, SV_HIT], [0.25, SV_FOLLOW], [0.6, SV_FOLLOW], [0.95, READY]],
};
export const TRACK_END = { fh:0.8, bh:0.8, vf:0.45, vb:0.45, sv:0.95 };

const KEYS = ['c', 'lean', 'twist', 'pyaw', 'hg'], VKEYS = ['hr', 'ra', 'rf', 'hl', 'pr', 'pl'];
function lerpPose(a, b, u, out) {
  for (const k of KEYS) out[k] = a[k] + (b[k] - a[k]) * u;
  for (const k of VKEYS) { out[k] = out[k] || [0, 0, 0]; for (let i = 0; i < 3; i++) out[k][i] = a[k][i] + (b[k][i] - a[k][i]) * u; }
  return out;
}
function sampleTrack(track, t, out) {
  if (t <= track[0][0]) return lerpPose(track[0][1], track[0][1], 0, out);
  for (let i = 0; i < track.length - 1; i++) {
    const [t0, p0] = track[i], [t1, p1] = track[i + 1];
    if (t <= t1) return lerpPose(p0, p1, smooth((t - t0) / (t1 - t0)), out);
  }
  const last = track[track.length - 1][1]; return lerpPose(last, last, 0, out);
}

// IK de 2 ossos: devolve direções do osso de cima e de baixo (no referencial do jogador)
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Vector3();
function ik2(root, target, l1, l2, pole, out1, out2) {
  _d.subVectors(target, root);
  const dist = clamp(_d.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  _d.normalize();
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-6) _p.set(0, 0, 1).addScaledVector(_d, -_d.z);
  _p.normalize();
  out1.copy(_d).multiplyScalar(cosA).addScaledVector(_p, sinA);
  _e.copy(root).addScaledVector(out1, l1);
  out2.copy(_d).multiplyScalar(dist).add(root).sub(_e).normalize();
}

const std = (color, rough = 0.75) => new THREE.MeshStandardMaterial({ color, roughness:rough, metalness:0 });
let stringTex = null;
function strings() {
  if (stringTex) return stringTex;
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1;
  for (let i = 2; i < 64; i += 5) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 64); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(64, i); g.stroke(); }
  stringTex = new THREE.CanvasTexture(c); return stringTex;
}

// ---------------------------------------------------------------- atleta
const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), rootQinv = new THREE.Quaternion();
const tmpM = new THREE.Matrix4(), rootInv = new THREE.Matrix4();
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vT = new THREE.Vector3(), vP = new THREE.Vector3();
const bX = new THREE.Vector3(), bY = new THREE.Vector3(), bZ = new THREE.Vector3();
// temporários reutilizados (sem alocar memória a cada fotograma)
const qPelvis = new THREE.Quaternion(), qChest = new THREE.Quaternion(), qChestInv = new THREE.Quaternion(), qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
const qFoot = new THREE.Quaternion(), eFoot = new THREE.Euler();
const vRa = new THREE.Vector3(), vHr = new THREE.Vector3(), vHl = new THREE.Vector3(), vPr = new THREE.Vector3(), vPl = new THREE.Vector3(), vRf = new THREE.Vector3();
const d1 = new THREE.Vector3(), d2 = new THREE.Vector3(), vGrip = new THREE.Vector3();

export class Athlete {
  constructor(scene, look) {
    const M = {
      skin:std(look.skin, 0.6), shirt:std(look.shirt, 0.85), shorts:std(look.shorts, 0.85), shoe:std(0xf4f4f4, 0.5),
      sole:std(look.sole ?? 0x2b2b2b, 0.9), sock:std(0xffffff, 0.95), hair:std(look.hair, 0.95), cap:std(look.cap, 0.7),
      band:std(look.band ?? look.cap, 0.8), frame:std(look.racket, 0.35), grip:std(0x1b1b1b, 0.9),
    };
    this.M = M;
    const add = (p, geo, m, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; p.add(o); return o; };
    const root = this.root = new THREE.Group();
    const pelvis = this.pelvis = new THREE.Group(); root.add(pelvis);
    add(pelvis, new THREE.CylinderGeometry(0.16, 0.175, 0.24, 16), M.shorts, 0, -0.02, 0).scale.z = 0.72;
    this.legs = [1, -1].map(sx => {
      const hip = new THREE.Group(); hip.position.set(sx * 0.095, -0.06, 0); pelvis.add(hip);
      add(hip, new THREE.CapsuleGeometry(0.07, THIGH - 0.12, 4, 10), M.skin, 0, -THIGH / 2, 0);
      add(hip, new THREE.CylinderGeometry(0.088, 0.082, 0.25, 12), M.shorts, 0, -0.1, 0);
      const knee = new THREE.Group(); knee.position.y = -THIGH; hip.add(knee);
      add(knee, new THREE.CapsuleGeometry(0.056, SHIN - 0.1, 4, 10), M.skin, 0, -SHIN / 2, 0);
      add(knee, new THREE.CylinderGeometry(0.061, 0.057, 0.13, 10), M.sock, 0, -SHIN + 0.08, 0);
      const ankle = new THREE.Group(); ankle.position.y = -SHIN; knee.add(ankle);
      add(ankle, new THREE.BoxGeometry(0.105, 0.07, 0.25), M.shoe, 0, -0.035, 0.045);
      add(ankle, new THREE.BoxGeometry(0.11, 0.02, 0.26), M.sole, 0, -0.072, 0.045);
      return { hip, knee, ankle, sx, foot:new THREE.Vector3() };
    });
    const spine = this.spine = new THREE.Group(); spine.position.y = 0.08; pelvis.add(spine);
    const chest = this.chest = new THREE.Group(); spine.add(chest);
    const prof = [[0.14, -0.02], [0.15, 0.08], [0.155, 0.17], [0.18, 0.27], [0.2, 0.35], [0.185, 0.41], [0.11, 0.455], [0.05, 0.47]];
    add(chest, new THREE.LatheGeometry(prof.map(p => new THREE.Vector2(p[0], p[1])), 20), M.shirt).scale.z = 0.66;
    add(chest, new THREE.CylinderGeometry(0.046, 0.05, 0.1, 10), M.skin, 0, 0.5, 0);
    const head = this.head = new THREE.Group(); head.position.set(0, 0.54, 0); chest.add(head);
    add(head, new THREE.SphereGeometry(0.105, 18, 14), M.skin, 0, 0.1, 0.005).scale.set(0.9, 1.1, 1);
    add(head, new THREE.SphereGeometry(0.108, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), M.hair, 0, 0.115, -0.01).scale.set(0.93, 1.05, 1.02);
    add(head, new THREE.ConeGeometry(0.016, 0.04, 6), M.skin, 0, 0.085, 0.105).rotation.x = Math.PI / 2;
    for (const ex of [-1, 1]) add(head, new THREE.SphereGeometry(0.022, 8, 6), M.skin, ex * 0.095, 0.095, 0);
    if (look.capStyle === 'cap') {
      add(head, new THREE.SphereGeometry(0.113, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), M.cap, 0, 0.125, 0).scale.set(0.95, 1, 1.02);
      add(head, new THREE.BoxGeometry(0.15, 0.012, 0.11), M.cap, 0, 0.145, 0.12).rotation.x = 0.15;
    } else {
      add(head, new THREE.CylinderGeometry(0.103, 0.103, 0.032, 18, 1, true), M.band, 0, 0.16, -0.005).scale.set(0.92, 1, 1.02);
    }
    this.arms = [1, -1].map(sx => {
      const sh = new THREE.Group(); sh.position.set(sx * 0.205, 0.4, 0); chest.add(sh);
      add(sh, new THREE.SphereGeometry(0.068, 12, 10), M.shirt, 0, -0.01, 0);
      add(sh, new THREE.CylinderGeometry(0.066, 0.06, 0.15, 12), M.shirt, 0, -0.06, 0);
      add(sh, new THREE.CapsuleGeometry(0.048, UPPER - 0.08, 4, 10), M.skin, 0, -UPPER / 2, 0);
      const el = new THREE.Group(); el.position.y = -UPPER; sh.add(el);
      add(el, new THREE.CapsuleGeometry(0.04, FORE - 0.07, 4, 10), M.skin, 0, -FORE / 2, 0);
      add(el, new THREE.CylinderGeometry(0.046, 0.046, 0.055, 10), M.band, 0, -FORE + 0.045, 0);
      const hand = new THREE.Group(); hand.position.y = -FORE; el.add(hand);
      add(hand, new THREE.SphereGeometry(0.044, 10, 8), M.skin, 0, -0.03, 0).scale.set(0.9, 1.2, 0.75);
      return { sh, el, hand, sx };
    });
    const racket = this.racket = new THREE.Group(); racket.position.y = -0.03; this.arms[1].hand.add(racket);
    add(racket, new THREE.CylinderGeometry(0.017, 0.02, 0.21, 8), M.grip, 0, -0.02, 0);
    add(racket, new THREE.CylinderGeometry(0.01, 0.013, 0.17, 6), M.frame, 0, -0.2, 0);
    const rim = add(racket, new THREE.TorusGeometry(0.118, 0.011, 8, 30), M.frame, 0, -0.42, 0); rim.scale.set(1, 1.28, 1);
    const str = new THREE.Mesh(new THREE.CircleGeometry(0.114, 24), new THREE.MeshBasicMaterial({ map:strings(), transparent:true, opacity:0.55, side:THREE.DoubleSide, depthWrite:false }));
    str.position.y = -0.42; str.scale.set(1, 1.28, 1); racket.add(str);
    // só as peças grandes projetam sombra (menos trabalho por fotograma)
    root.traverse(o => { if (o.isMesh) { o.receiveShadow = false; const r = o.geometry.boundingSphere || (o.geometry.computeBoundingSphere(), o.geometry.boundingSphere); if (r.radius < 0.06) o.castShadow = false; } });
    scene.add(root);
    this.cur = lerpPose(READY, READY, 0, {});
    this.tgt = lerpPose(READY, READY, 0, {});
    this.yaw = 0; this.gait = 0; this.t = 0; this.headYaw = 0; this.headPitch = 0;
  }

  // s: { x, z, vx, vz, side, ball:{x,y,z}|null, act:{type,t}|null, mode:'ready'|'serve'|'happy'|'sad'|'walk' }
  update(dt, s) {
    this.t += dt;
    const sp = Math.hypot(s.vx, s.vz);
    const netYaw = s.side > 0 ? Math.PI : 0;
    let wantYaw = netYaw;
    if (!s.act && sp > 2.6 && s.mode !== 'serve') {
      const d = angDiff(Math.atan2(s.vx, s.vz), netYaw);
      if (Math.abs(d) < 2.0) wantYaw = netYaw + d * 0.8;   // corre virado para onde vai; a recuar mantém-se de frente
    }
    this.yaw += angDiff(wantYaw, this.yaw) * (1 - Math.exp(-9 * dt));
    const root = this.root;
    root.position.set(s.x, 0, s.z); root.rotation.y = this.yaw;

    // pose alvo
    const tg = this.tgt;
    if (s.act && TRACKS[s.act.type]) {
      sampleTrack(TRACKS[s.act.type], s.act.t, tg);
      if (s.act.h !== undefined) tg.c = Math.min(0.8, tg.c + clamp(0.95 - s.act.h, 0, 0.4) * 0.9 * Math.exp(-((s.act.t / 0.25) ** 2)));
    }
    else {
      const base = s.mode === 'serve' ? SV_IDLE : s.mode === 'happy' ? HAPPY : s.mode === 'sad' ? SAD : s.mode === 'walk' ? WALK : READY;
      lerpPose(base, base, 0, tg);
      if (s.mode === 'serve') tg.hl[1] = 0.88 + Math.abs(Math.sin(this.t * 4.2)) * 0.12;        // bate a bola no chão
      if (s.mode === 'happy') tg.hl[1] += Math.sin(this.t * 9) * 0.06;                            // punho a vibrar
      if (sp > 3.2 && s.mode === 'ready') { tg.hg = 0; tg.hr = [-0.3, 1.0, 0.25]; tg.ra = [0.05, 0.3, 0.95]; tg.hl = [0.24, 1.0, 0.1]; }
    }
    const k = 1 - Math.exp(-(s.act ? 26 : 9) * dt), cu = this.cur;
    lerpPose(cu, tg, k, cu);

    // marcha (no referencial do jogador)
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const lx = s.vx * cy - s.vz * sy, lz = s.vx * sy + s.vz * cy;
    const moving = sp > 0.15;
    if (moving) this.gait += dt * (4.5 + sp * 1.7);
    const stride = Math.min(0.5, sp * 0.12), lift = Math.min(0.16, sp * 0.035);
    const dx = moving ? lx / sp : 0, dz = moving ? lz / sp : 0;
    const bounce = (!s.act && s.mode === 'ready' && !moving) ? Math.sin(this.t * 11) * 0.012 : 0;
    const runBob = moving ? Math.abs(Math.sin(this.gait)) * 0.03 : 0;
    // split-step: pequeno salto no momento em que o adversário bate
    const sk = s.split !== undefined && s.split >= 0 && s.split < 0.32 && sp < 3 ? Math.sin(s.split / 0.32 * Math.PI) : 0;
    const pyaw = cu.pyaw;
    this.pelvis.position.set(0, HIP_H - cu.c * 0.2 - runBob + bounce + sk * 0.05, 0);
    this.pelvis.rotation.set(0, pyaw, 0);
    this.spine.rotation.set(cu.lean + Math.min(0.22, sp * 0.035), 0, 0);
    this.chest.rotation.set(0, cu.twist, 0);
    root.updateMatrixWorld(true);
    rootInv.copy(root.matrixWorld).invert();
    root.getWorldQuaternion(rootQinv).invert();

    // pernas
    const stanceW = 0.12 + cu.c * 0.12, fy = pyaw * 0.55, cf = Math.cos(fy), sf = Math.sin(fy);
    const pelvisQ = this.pelvis.getWorldQuaternion(qPelvis).premultiply(rootQinv);
    const pelvisQinv = tmpQ2.copy(pelvisQ).invert();
    for (const L of this.legs) {
      const ph = this.gait + (L.sx > 0 ? 0 : Math.PI);
      let fx = L.sx * stanceW, fz = L.sx * 0.03;
      [fx, fz] = [fx * cf + fz * sf, -fx * sf + fz * cf];
      if (moving) { fx += dx * Math.sin(ph) * stride; fz += dz * Math.sin(ph) * stride; }
      const fyH = (moving ? Math.max(0, Math.cos(ph)) * lift : 0) + sk * 0.05;
      vT.set(fx, ANKLE + fyH, fz);
      L.hip.getWorldPosition(vA).applyMatrix4(rootInv);
      vP.set(Math.sin(fy) + L.sx * 0.15, 0, Math.cos(fy));
      ik2(vA, vT, THIGH, SHIN, vP, vB, vC);
      vB.applyQuaternion(pelvisQinv); L.hip.quaternion.setFromUnitVectors(DOWN, vB);
      const hq = tmpQ.copy(pelvisQ).multiply(L.hip.quaternion).invert();
      vC.applyQuaternion(hq); L.knee.quaternion.setFromUnitVectors(DOWN, vC);
      qFoot.setFromEuler(eFoot.set(moving ? -Math.max(0, Math.cos(ph)) * 0.3 : 0, fy, 0));
      L.ankle.quaternion.copy(pelvisQ).multiply(L.hip.quaternion).multiply(L.knee.quaternion).invert().multiply(qFoot);
    }

    // braços
    root.updateMatrixWorld(true);
    const chestQ = this.chest.getWorldQuaternion(qChest).premultiply(rootQinv);
    const chestQinv = qChestInv.copy(chestQ).invert();
    const R = this.arms[1], Lf = this.arms[0];
    const ra = vRa.fromArray(cu.ra).normalize();
    const hr = vHr.fromArray(cu.hr);
    if (s.act && s.act.h !== undefined) {           // ajusta a mão à altura e distância reais da bola no contacto
      const w = Math.exp(-(s.act.t / 0.2) * (s.act.t / 0.2)), fh = s.act.type === 'fh' || s.act.type === 'vf';
      hr.y += clamp(s.act.h - 0.98, -0.45, 0.6) * 1.0 * w;
      hr.x += (fh ? -1 : 1) * clamp((s.act.lat ?? 0.72) - 0.72, -0.4, 0.5) * 1.0 * w;
    }
    const hl = vHl.fromArray(cu.hl);
    if (cu.hg > 0.01) hl.lerp(vGrip.copy(hr).addScaledVector(ra, 0.13), cu.hg);
    if (!s.act && moving && cu.hg < 0.5) hl.z += Math.sin(this.gait) * 0.22 * Math.min(1, sp / 4);
    this.solveArm(R, hr, vPr.fromArray(cu.pr), chestQ, chestQinv, ra, vRf.fromArray(cu.rf));
    this.solveArm(Lf, hl, vPl.fromArray(cu.pl), chestQ, chestQinv, null, null);

    // cabeça segue a bola
    let wantY = 0, wantP = 0.15;
    if (s.ball) {
      vT.set(s.ball.x, s.ball.y, s.ball.z).applyMatrix4(rootInv);
      this.head.getWorldPosition(vB).applyMatrix4(rootInv);
      vT.sub(vB).applyQuaternion(chestQinv);
      wantY = clamp(Math.atan2(vT.x, vT.z), -1.2, 1.2);
      wantP = clamp(Math.atan2(-vT.y, Math.hypot(vT.x, vT.z)), -0.55, 0.7);
    }
    if (s.mode === 'sad') { wantP = 0.6; wantY = 0; }
    if (s.mode === 'happy') wantP = -0.25;
    const hk = 1 - Math.exp(-10 * dt);
    this.headYaw += (wantY - this.headYaw) * hk; this.headPitch += (wantP - this.headPitch) * hk;
    this.head.rotation.set(this.headPitch, this.headYaw, 0, 'YXZ');
  }

  solveArm(A, target, pole, chestQ, chestQinv, axis, face) {
    A.sh.getWorldPosition(vB).applyMatrix4(rootInv);
    ik2(vB, target, UPPER, FORE, pole.normalize(), d1, d2);
    d1.applyQuaternion(chestQinv); A.sh.quaternion.setFromUnitVectors(DOWN, d1);
    const q1 = qA.copy(chestQ).multiply(A.sh.quaternion);
    d2.applyQuaternion(qB.copy(q1).invert()); A.el.quaternion.setFromUnitVectors(DOWN, d2);
    const q2 = q1.multiply(A.el.quaternion);
    if (axis) {
      bY.copy(axis).negate();
      bZ.copy(face).addScaledVector(bY, -face.dot(bY));
      if (bZ.lengthSq() < 1e-5) bZ.set(1, 0, 0).addScaledVector(bY, -bY.x);
      bZ.normalize(); bX.crossVectors(bY, bZ);
      tmpM.makeBasis(bX, bY, bZ);
      A.hand.quaternion.setFromRotationMatrix(tmpM).premultiply(q2.invert());
    } else A.hand.quaternion.identity();
  }

  setLook(look) {
    const M = this.M;
    for (const [k, c] of [['skin', look.skin], ['shirt', look.shirt], ['shorts', look.shorts], ['hair', look.hair], ['cap', look.cap],
      ['band', look.band ?? look.cap], ['frame', look.racket]]) M[k].color.setHex(c);
  }

  setVisible(v) { this.root.visible = v; }
}

// sex/tone/hairStyle/beard: usados pelos modelos humanos (athlete-gltf.js); o resto também pelo boneco simples
export const LOOK_PRESETS = [
  { skin:0xe2b48f, shirt:0xf4f4f4, shorts:0x1e3a8a, hair:0x3b2a1e, cap:0xd7f34a, band:0xd7f34a, racket:0x1d4ed8, capStyle:'cap', sex:'m', tone:'light', hairStyle:'Hair_SimpleParted' },
  { skin:0xc68a5e, shirt:0xe23d3d, shorts:0x1f1f1f, hair:0x1a1a1a, cap:0xffffff, band:0xffffff, racket:0xe11d48, capStyle:'band', sex:'f', tone:'dark', hairStyle:'Hair_Buns' },
  { skin:0xf1c9a5, shirt:0x0f766e, shorts:0xffffff, hair:0xc9a66b, cap:0x0f766e, band:0x0f766e, racket:0xf59e0b, capStyle:'band', sex:'m', tone:'light', hairStyle:'Hair_Buzzed' },
  { skin:0x8d5a3b, shirt:0xf97316, shorts:0x0f172a, hair:0x111111, cap:0x0f172a, band:0xf97316, racket:0x22c55e, capStyle:'cap', sex:'m', tone:'dark', hairStyle:'Hair_SimpleParted' },
  { skin:0xe8c09a, shirt:0x7c3aed, shorts:0x111827, hair:0x5b3a1e, cap:0xffffff, band:0xffffff, racket:0x7c3aed, capStyle:'band', sex:'m', tone:'light', hairStyle:'Hair_SimpleParted', beard:true },
];

// partilhado com athlete-gltf.js
export { TRACKS, sampleTrack, lerpPose, ik2, READY, WALK, HAPPY, SAD, SV_IDLE, strings, angDiff, clamp };
