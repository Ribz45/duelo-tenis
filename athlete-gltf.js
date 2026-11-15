// Jogadores realistas: avatares Microsoft Rocketbox (licença MIT) com as animações de corrida da Quaternius (CC0) e as
// pancadas de ténis captadas a jogadores reais (Tennis-MoCap, CC BY-SA 3.0): direita, esquerda a duas mãos, vóleis, serviço
// e posição de espera. Por cima: pega da raquete calibrada por pancada, correção para a raquete encontrar a bola,
// agachamento nas bolas baixas, a cabeça a seguir a bola e o piscar de olhos.
// Mesma interface do boneco simples (player3d.js): update(dt, s), setLook(look).
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from './vendor/jsm/utils/SkeletonUtils.js';
import { ik2, strings, angDiff, clamp } from './player3d.js?v=10';

const V3 = THREE.Vector3;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- carregar os ficheiros (uma vez)
const loadImage = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
export async function loadAthleteAssets(base = 'models/rb/') {
  const loader = new GLTFLoader();
  const one = async k => {
    const [gltf, body, head, bodyN, headN, mask, headMask, hair] = await Promise.all([
      loader.loadAsync(base + `rb_${k}.glb`),
      loadImage(base + `rb_${k}_body.jpg`), loadImage(base + `rb_${k}_head.jpg`),
      loadImage(base + `rb_${k}_body_n.jpg`), loadImage(base + `rb_${k}_head_n.jpg`),
      loadImage(base + `rb_${k}_mask.png`), loadImage(base + `rb_${k}_headmask.png`),
      k === 'f' ? loadImage(base + 'rb_f_hair.png') : null,
    ]);
    const tex = (img, srgb) => { const t = new THREE.Texture(img); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true; return t; };
    const tennis = await fetch(base + `tennis_${k}.json`).then(r => r.ok ? r.json() : null).then(j => j && decodeTennis(j)).catch(() => null);
    return { gltf, img:{ body, head, mask, headMask }, bodyN:tex(bodyN, false), headN:tex(headN, false), hair:hair && tex(hair, true), tennis };
  };
  const [m, f] = await Promise.all([one('m'), one('f')]);
  return { m, f, kits:new Map() };
}

// capturas de ténis: rotações (int16) de 20 ossos por fotograma a 30 fps + posição da anca; pega e ponto de contacto por pancada
function decodeTennis(j) {
  const bin = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
  const clips = {};
  for (const [k, c] of Object.entries(j.clips)) {
    const qi = new Int16Array(bin(c.q)), pi = new Int16Array(bin(c.p));
    const q = new Float32Array(qi.length); for (let i = 0; i < qi.length; i++) q[i] = qi[i] / 32767;
    const p = new Float32Array(pi.length); for (let i = 0; i < pi.length; i++) p[i] = pi[i] / 10;
    clips[k] = { frames:c.frames, dur:(c.frames - 1) / j.fps, contact:c.contact, loop:c.loop, q, p,
      grip:new THREE.Quaternion().fromArray(c.grip), cc:new V3().fromArray(c.cc) };
  }
  return { fps:j.fps, bones:j.bones, clips };
}
// mistura duas poses (quaterniões + posição da anca) para trocar de pancada sem saltos
const _bq1 = new THREE.Quaternion(), _bq2 = new THREE.Quaternion();
function blendPose(a, b, u, out) {
  const n = a.length - 3;
  for (let j = 0; j < n; j += 4) {
    _bq1.set(a[j], a[j + 1], a[j + 2], a[j + 3]); _bq2.set(b[j], b[j + 1], b[j + 2], b[j + 3]); _bq1.slerp(_bq2, u);
    out[j] = _bq1.x; out[j + 1] = _bq1.y; out[j + 2] = _bq1.z; out[j + 3] = _bq1.w;
  }
  for (let i = 0; i < 3; i++) out[n + i] = a[n + i] + (b[n + i] - a[n + i]) * u;
}

// ---------------------------------------------------------------- equipamento e tom de pele (máscaras: R camisola · G calções · B pele)
function recolor(base, mask, look, skinAvg) {
  const S = base.width, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently:true });
  g.drawImage(mask, 0, 0, S, S); const M = g.getImageData(0, 0, S, S).data;
  g.drawImage(base, 0, 0, S, S); const id = g.getImageData(0, 0, S, S), D = id.data;
  let tS = 0, tN = 0, bS = 0, bN = 0, s0 = 0, s1 = 0, s2 = 0, sN = 0;
  for (let i = 0; i < D.length; i += 4) {
    const L = 0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2];
    if (M[i] > 128) { tS += L; tN++; } if (M[i + 1] > 128) { bS += L; bN++; }
    if (M[i + 2] > 128) { s0 += D[i]; s1 += D[i + 1]; s2 += D[i + 2]; sN++; }
  }
  const tA = tS / Math.max(1, tN), bA = bS / Math.max(1, bN);
  const avg = skinAvg || (sN ? [s0 / sN, s1 / sN, s2 / sN] : [200, 160, 130]);
  const C = h => { const k = new THREE.Color(h); return [k.r * 255, k.g * 255, k.b * 255]; };
  const top = C(look.shirt), bot = C(look.shorts), skin = C(look.skin);
  const r0 = skin[0] / avg[0], r1 = skin[1] / avg[1], r2 = skin[2] / avg[2];
  for (let i = 0; i < D.length; i += 4) {
    const t = M[i] / 255, b = M[i + 1] / 255, s = M[i + 2] / 255;
    if (t + b + s < 0.01) continue;
    const L = 0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2];
    let r = D[i], gg = D[i + 1], bb = D[i + 2];
    if (s > 0) { r += (Math.min(255, D[i] * r0) - r) * s; gg += (Math.min(255, D[i + 1] * r1) - gg) * s; bb += (Math.min(255, D[i + 2] * r2) - bb) * s; }
    if (t > 0) { const sh = clamp(0.95 + 0.55 * (L - tA) / (tA + 12), 0.55, 1.2); r += (top[0] * sh - r) * t; gg += (top[1] * sh - gg) * t; bb += (top[2] * sh - bb) * t; }
    if (b > 0) { const sh = clamp(0.95 + 0.55 * (L - bA) / (bA + 12), 0.55, 1.2); r += (bot[0] * sh - r) * b; gg += (bot[1] * sh - gg) * b; bb += (bot[2] * sh - bb) * b; }
    D[i] = r; D[i + 1] = gg; D[i + 2] = bb;
  }
  g.putImageData(id, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return { tex, skinAvg:avg };
}
// prepara os equipamentos com tempo (um de cada vez, nos intervalos), para o início do jogo não engasgar no telemóvel
export function warmKits(A, looks) {
  const todo = looks.slice();
  const next = () => { const l = todo.shift(); if (!l) return; kitFor(A, l.sex === 'f' ? 'f' : 'm', l); setTimeout(next, 250); };
  setTimeout(next, 400);
}
function kitFor(A, sex, look) {
  const key = [sex, look.shirt, look.shorts, look.skin].join('|');
  if (!A.kits.has(key)) {
    const src = A[sex], body = recolor(src.img.body, src.img.mask, look);
    A.kits.set(key, { body:body.tex, head:recolor(src.img.head, src.img.headMask, look, body.skinAvg).tex });
  }
  return A.kits.get(key);
}

// raquete (mesma do boneco simples): punho em y=0, cabeça para -y, face com normal +z
function makeRacket(frameMat) {
  const r = new THREE.Group(), grip = new THREE.MeshStandardMaterial({ color:0x1b1b1b, roughness:0.9 });
  const add = (geo, mat, y) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = true; r.add(m); return m; };
  add(new THREE.CylinderGeometry(0.016, 0.019, 0.2, 8), grip, -0.02);
  add(new THREE.CylinderGeometry(0.01, 0.013, 0.17, 6), frameMat, -0.19);
  add(new THREE.TorusGeometry(0.118, 0.011, 8, 30), frameMat, -0.41).scale.set(1, 1.28, 1);
  const str = new THREE.Mesh(new THREE.CircleGeometry(0.114, 24), new THREE.MeshBasicMaterial({ map:strings(), transparent:true, opacity:0.55, side:THREE.DoubleSide, depthWrite:false }));
  str.position.y = -0.41; str.scale.set(1, 1.28, 1); r.add(str);
  return r;
}

// ---------------------------------------------------------------- utilitários de ossos
const _a = new V3(), _b = new V3(), _q = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qs = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _x = new V3(), _y = new V3(), _z = new V3();
// roda o osso para a direção (osso → filho) apontar para dir (mundo), com peso w sobre a pose atual
function aimBone(bone, child, dir, w) {
  if (w <= 0.001) return;
  bone.getWorldPosition(_a); child.getWorldPosition(_b);
  _q.setFromUnitVectors(_b.sub(_a).normalize(), dir);
  bone.getWorldQuaternion(_qw); _q.multiply(_qw);
  bone.parent.getWorldQuaternion(_qp).invert().multiply(_q);
  bone.quaternion.slerp(_qp, w);
  bone.updateMatrixWorld(true);
}
// roda o osso no mundo por q (a partir da pose atual), com peso w
function rotateWorld(bone, q, w) {
  if (w <= 0.001) return;
  bone.getWorldQuaternion(_qw); _qs.copy(q).multiply(_qw);
  bone.parent.getWorldQuaternion(_qp).invert().multiply(_qs);
  bone.quaternion.slerp(_qp, w);
  bone.updateMatrixWorld(true);
}
// para onde está virada uma linha esquerda→direita do corpo (ancas ou ombros), no mesmo ângulo do referencial do jogador
const _ya = new V3(), _yb = new V3();
function yawOf(left, rightBone) {
  left.getWorldPosition(_ya); rightBone.getWorldPosition(_yb);
  return Math.atan2(-(_ya.z - _yb.z), _ya.x - _yb.x);
}
// orientação no mundo de uma base (eixo da raquete = -y, normal da face = +z)
function basisQuat(axis, face, out) {
  _y.copy(axis).negate().normalize();
  _z.copy(face).addScaledVector(_y, -face.dot(_y)); if (_z.lengthSq() < 1e-6) _z.set(1, 0, 0).addScaledVector(_y, -_y.x); _z.normalize();
  _x.crossVectors(_y, _z);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

// ---------------------------------------------------------------- pancadas (poses-chave com biomecânica de ténis real)
// Referencial do jogador: +z para a rede, +x = lado ESQUERDO, -x = lado DIREITO (mão da raquete), y = altura ao chão (m).
// c agachamento · lean inclinação · twist rotação dos ombros · pyaw rotação da anca
// hr pulso direito · ra direção da cabeça da raquete · rf normal das cordas · pr/pl para onde apontam os cotovelos
// hl pulso esquerdo livre · hg 1 = mão esquerda na raquete, a gd metros acima da mão direita (0,085 = cabo, 0,27 = coração)
// lp: lado da palma esquerda (+1 empurra no sentido das cordas, −1 o contrário)
// jp: salto (m) — só no serviço, para chegar à bola lá em cima
const PK = ['c', 'lean', 'twist', 'pyaw', 'hg', 'gd', 'lp', 'jp'], PV = ['hr', 'ra', 'rf', 'hl', 'pr', 'pl'];
const Q = o => Object.assign({ c:0.4, lean:0.25, twist:0, pyaw:0, hr:[-0.12, 1.0, 0.33], ra:[0.12, 0.5, 0.86], rf:[-1, 0, 0],
  hl:[0.22, 1.0, 0.25], hg:0, gd:0.27, lp:-1, jp:0, pr:[-1, -0.6, -0.5], pl:[1, -0.6, -0.5] }, o);
function lerpP(a, b, u, out) {
  for (const k of PK) out[k] = a[k] + (b[k] - a[k]) * u;
  for (const k of PV) { const o = out[k] || (out[k] = [0, 0, 0]); for (let i = 0; i < 3; i++) o[i] = a[k][i] + (b[k][i] - a[k][i]) * u; }
  return out;
}
function sampleP(track, t, out) {
  if (t <= track[0][0]) return lerpP(track[0][1], track[0][1], 0, out);
  for (let i = 0; i < track.length - 1; i++) {
    const [t0, p0] = track[i], [t1, p1] = track[i + 1];
    if (t <= t1) { const u = (t - t0) / (t1 - t0); return lerpP(p0, p1, u * u * (3 - 2 * u), out); }
  }
  const last = track[track.length - 1][1]; return lerpP(last, last, 0, out);
}
// posição de espera: raquete à frente, mão esquerda a segurar o coração da raquete
const R_READY = Q({ c:0.42, lean:0.28, hg:1, gd:0.27, lp:-1 });
const R_WALK = Q({ c:0.05, lean:0.05, hr:[-0.27, 0.9, 0.1], ra:[0, -0.5, 0.86], rf:[-1, 0, 0], hl:[0.24, 0.9, 0.05] });
const R_HAPPY = Q({ c:0.3, lean:0.05, hr:[-0.27, 0.93, 0.12], ra:[0, -0.9, 0.4], hl:[0.24, 1.45, 0.28], pl:[1, -0.2, -1] });
const R_SAD = Q({ c:0.0, lean:0.38, hr:[-0.26, 0.82, 0.08], ra:[0, -0.95, 0.3], hl:[0.22, 0.9, -0.02], pl:[1, 0.2, -1] });
// direita: rotação de ombros com a mão esquerda no coração → laço atrás → cabeça cai (lag) → contacto à frente com o braço
// quase esticado e a raquete paralela à linha de fundo → "limpa-para-brisas" e acaba por cima do ombro esquerdo
const FH_TURN = Q({ c:0.5, lean:0.15, twist:-1.15, pyaw:-0.55, hr:[-0.38, 1.12, 0.02], ra:[0, 0.8, -0.6], rf:[-1, 0, 0], hg:1, gd:0.27, lp:-1, pr:[-0.4, -1, -0.6], pl:[0.3, -1, 0.6] });
const FH_BACK = Q({ c:0.55, lean:0.15, twist:-1.35, pyaw:-0.6, hr:[-0.55, 1.28, -0.32], ra:[-0.15, 0.7, -0.7], rf:[0.95, -0.1, -0.2], hl:[-0.2, 1.28, 0.45], pr:[-0.3, -1, -0.2], pl:[1, -0.3, -0.2] });
const FH_DROP = Q({ c:0.55, lean:0.18, twist:-1.05, pyaw:-0.35, hr:[-0.6, 0.98, -0.3], ra:[-0.2, -0.55, -0.8], rf:[0.15, 0.9, -0.35], hl:[0, 1.22, 0.45], pr:[-0.2, -1, 0], pl:[1, -0.4, 0] });
const FH_SWING = Q({ c:0.5, lean:0.2, twist:-0.55, pyaw:-0.1, hr:[-0.58, 0.9, 0], ra:[-0.65, -0.3, -0.7], rf:[0.3, 0.3, -0.9], hl:[0.15, 1.2, 0.35], pr:[-0.3, -1, 0.3], pl:[1, -0.5, -0.1] });
const FH_HIT = Q({ c:0.45, lean:0.22, twist:0, pyaw:0.15, hr:[-0.3, 0.96, 0.26], ra:[-0.9, 0.05, 0.42], rf:[-0.35, -0.05, -1], hl:[0.3, 1.15, 0.25], pr:[-0.4, -1, 0.2], pl:[1, -0.6, -0.3] });
const FH_FOLLOW = Q({ c:0.4, lean:0.2, twist:0.65, pyaw:0.4, hr:[0, 1.32, 0.42], ra:[0.25, 0.95, 0.05], rf:[-0.95, -0.1, -0.25], hl:[0.32, 1.2, 0.2], pr:[-0.3, -0.4, 1], pl:[1, -0.6, -0.4] });
const FH_FINISH = Q({ c:0.38, lean:0.18, twist:1.0, pyaw:0.55, hr:[0.22, 1.42, 0.12], ra:[0.35, -0.25, -0.9], rf:[0.85, 0.35, 0.3], hl:[0.3, 1.25, 0.12], pr:[-0.1, 0.2, 1], pl:[1, -0.6, -0.4] });
// esquerda a duas mãos: as duas mãos juntas no cabo durante todo o gesto
const B2 = { hg:1, gd:0.085, lp:-1 };
const BH_TURN = Q({ ...B2, c:0.5, lean:0.15, twist:1.15, pyaw:0.55, hr:[0.22, 1.05, 0.05], ra:[0.15, 0.8, -0.55], rf:[0.95, 0, 0.2], pr:[0, -1, 0.5], pl:[0.6, -1, -0.3] });
const BH_BACK = Q({ ...B2, c:0.55, lean:0.15, twist:1.35, pyaw:0.6, hr:[0.38, 1.0, -0.25], ra:[0.3, 0.55, -0.78], rf:[0.95, 0.2, 0.1], pr:[0, -1, 0.5], pl:[0.6, -1, -0.3] });
const BH_DROP = Q({ ...B2, c:0.55, lean:0.18, twist:1.1, pyaw:0.4, hr:[0.42, 0.88, -0.22], ra:[0.3, -0.5, -0.8], rf:[0.35, -0.85, 0.35], pr:[0, -1, 0.5], pl:[0.6, -1, -0.3] });
const BH_SWING = Q({ ...B2, c:0.5, lean:0.2, twist:0.6, pyaw:0.15, hr:[0.4, 0.86, 0.05], ra:[0.65, -0.3, -0.7], rf:[0.3, -0.3, 0.9], pr:[0.1, -1, 0.4], pl:[0.7, -1, -0.2] });
const BH_HIT = Q({ ...B2, c:0.45, lean:0.22, twist:0.15, pyaw:-0.05, hr:[0.29, 0.96, 0.25], ra:[0.9, 0.05, 0.42], rf:[-0.35, 0.05, 1], pr:[0.2, -1, 0.3], pl:[0.8, -0.8, -0.2] });
const BH_FOLLOW = Q({ ...B2, c:0.4, lean:0.2, twist:-0.65, pyaw:-0.4, hr:[0, 1.3, 0.42], ra:[-0.25, 0.95, 0.05], rf:[-0.95, 0.1, 0.25], pr:[-0.2, -0.6, 1], pl:[0.5, -0.4, 1] });
const BH_FINISH = Q({ ...B2, c:0.38, lean:0.18, twist:-1.0, pyaw:-0.55, hr:[-0.2, 1.42, 0.12], ra:[-0.35, -0.25, -0.9], rf:[-0.85, 0.35, 0.3], pr:[-0.5, 0.2, 1], pl:[0.2, 0.2, 1] });
// vóleis: gesto curto, cabeça da raquete acima do pulso, face aberta, contacto bem à frente
const VF_PREP = Q({ c:0.5, lean:0.3, twist:-0.55, pyaw:-0.25, hr:[-0.45, 1.22, 0.18], ra:[-0.35, 0.8, -0.2], rf:[0.15, -0.15, -1], hl:[-0.1, 1.2, 0.45], pr:[-0.4, -1, -0.3], pl:[1, -0.5, 0] });
const VF_HIT = Q({ c:0.5, lean:0.3, twist:-0.2, pyaw:-0.1, hr:[-0.36, 0.77, 0.28], ra:[-0.75, 0.45, 0.35], rf:[-0.1, -0.35, -1], hl:[0.2, 1.15, 0.35], pr:[-0.4, -1, 0.1], pl:[1, -0.5, -0.2] });
const VB_PREP = Q({ c:0.5, lean:0.3, twist:0.6, pyaw:0.25, hr:[0.22, 1.2, 0.12], ra:[0.4, 0.8, -0.15], rf:[0.15, 0.15, 1], hg:1, gd:0.27, lp:-1, pr:[0, -1, 0.4], pl:[0.5, -1, 0] });
const VB_HIT = Q({ c:0.5, lean:0.3, twist:0.25, pyaw:0.1, hr:[0.36, 0.77, 0.28], ra:[0.75, 0.45, 0.35], rf:[-0.1, 0.35, 1], hl:[-0.25, 1.1, -0.1], pr:[0.2, -1, 0.2], pl:[1, -0.4, -0.6] });
// serviço: de lado para a rede → lança e leva a raquete atrás → "troféu" → raquete cai nas costas → impacto em extensão total → pronação e acaba do lado esquerdo
const SV_WAIT = Q({ c:0.12, lean:0.12, twist:0.15, pyaw:-0.85, hr:[-0.22, 0.95, 0.25], ra:[0.05, -0.3, 0.95], rf:[-1, 0, 0], hl:[0.06, 0.95, 0.38] });
const SV_TOSS = Q({ c:0.2, lean:0, twist:0.1, pyaw:-0.85, hr:[-0.32, 1.1, -0.15], ra:[-0.05, 0.25, -0.97], rf:[-1, 0, 0], hl:[0.1, 1.7, 0.3], pl:[1, -0.3, -0.3] });
const SV_TROPHY = Q({ c:0.5, lean:-0.2, twist:-0.35, pyaw:-0.85, hr:[-0.38, 1.55, -0.2], ra:[0.05, 0.75, -0.65], rf:[-1, 0, 0], hl:[0.12, 2.0, 0.18], pr:[-1, 0.2, -0.4], pl:[1, -0.2, -0.3] });
const SV_DROP = Q({ c:0.3, lean:-0.25, twist:-0.2, pyaw:-0.7, jp:0.04, hr:[-0.25, 1.62, -0.12], ra:[0.1, -0.85, -0.5], rf:[1, 0, 0], hl:[0.2, 1.35, 0.3], pr:[-0.4, 1, 0.3], pl:[1, -0.4, 0.2] });
const SV_HIT = Q({ c:0, lean:0.1, twist:0.25, pyaw:-0.35, jp:0.17, hr:[-0.15, 1.98, 0.28], ra:[0.05, 0.95, 0.3], rf:[0, -0.3, -1], hl:[0.2, 1.25, 0.2], pr:[-1, 0, 0], pl:[1, -0.6, 0.3] });
const SV_FOLLOW = Q({ c:0.32, lean:0.45, twist:0.65, pyaw:0.05, hr:[0.28, 0.85, 0.3], ra:[0.25, -0.85, 0.4], rf:[0, 0, 1], hl:[0.25, 1.0, 0.1], pr:[-0.3, -1, 0.2], pl:[1, -0.6, 0] });
const RT = {
  fh: [[-0.6, R_READY], [-0.42, FH_TURN], [-0.28, FH_BACK], [-0.12, FH_DROP], [-0.05, FH_SWING], [0, FH_HIT], [0.12, FH_FOLLOW], [0.28, FH_FINISH], [0.5, FH_FINISH], [0.8, R_READY]],
  bh: [[-0.6, R_READY], [-0.42, BH_TURN], [-0.28, BH_BACK], [-0.12, BH_DROP], [-0.05, BH_SWING], [0, BH_HIT], [0.12, BH_FOLLOW], [0.28, BH_FINISH], [0.5, BH_FINISH], [0.8, R_READY]],
  vf: [[-0.4, R_READY], [-0.2, VF_PREP], [0, VF_HIT], [0.15, VF_HIT], [0.45, R_READY]],
  vb: [[-0.4, R_READY], [-0.2, VB_PREP], [0, VB_HIT], [0.15, VB_HIT], [0.45, R_READY]],
  sv: [[-0.75, SV_WAIT], [-0.5, SV_TOSS], [-0.2, SV_TROPHY], [-0.07, SV_DROP], [0, SV_HIT], [0.25, SV_FOLLOW], [0.6, SV_FOLLOW], [0.95, R_READY]],
};

// ---------------------------------------------------------------- atleta
const tA = new V3(), tB = new V3(), tC = new V3(), tT = new V3(), tP = new V3(), tHr = new V3(), tHl = new V3(), tRa = new V3(), tRf = new V3(), tD1 = new V3(), tD2 = new V3();
const tG = new V3(), tF = new V3(), tN = new V3(), qL = new THREE.Quaternion(), _mL = new THREE.Matrix4();
const qIdent = new THREE.Quaternion(), qPart = new THREE.Quaternion();
const qTmp = new THREE.Quaternion(), qRacket = new THREE.Quaternion(), UPV = new V3(0, 1, 0);
const BIP = n => 'Bip01_' + n;

export class RealAthlete {
  constructor(scene, assets, look) {
    this.scene = scene; this.assets = assets;
    this.frame = new THREE.Object3D();          // referencial do jogador: pés no chão, +z para a rede
    this.frameMat = new THREE.MeshStandardMaterial({ color:look.racket, roughness:0.35 });
    this.cur = lerpP(R_READY, R_READY, 0, {}); this.tgt = lerpP(R_READY, R_READY, 0, {});
    this.yaw = 0; this.gait = 0; this.t = 0; this.headYaw = 0; this.headPitch = 0;
    this.blinkAt = 1 + Math.random() * 3; this.blink = 0;
    this.dbg = {};
    // rasto do movimento da raquete (fita entre o coração e a ponta da cabeça) nas pancadas rápidas
    this.SN = 12; this.sw = [];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.SN * 2 * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.SN * 2 * 4), 4));
    const idx = []; for (let i = 0; i < this.SN - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } g.setIndex(idx);
    this.swoosh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors:true, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.DoubleSide }));
    this.swoosh.frustumCulled = false; this.swoosh.visible = false; this.swoosh.renderOrder = 3; scene.add(this.swoosh);
    this.swK = 0;
    this.setLook(look);
  }

  // rasto da raquete: guarda os últimos pontos (coração e ponta) e desenha uma fita que se desvanece
  updateSwoosh(dt, on) {
    const r = this.racket; r.updateMatrixWorld(true);
    const a = r.localToWorld(new V3(0, -0.27, 0)), b = r.localToWorld(new V3(0, -0.56, 0));
    const last = this.sw[this.sw.length - 1];
    const speed = last && dt > 0 ? b.distanceTo(last.b) / dt : 0;
    this.swK += ((on ? clamp((speed - 7) / 9, 0, 1) : 0) - this.swK) * Math.min(1, dt * 18);
    this.sw.push({ a, b }); if (this.sw.length > this.SN) this.sw.shift();
    const N = this.sw.length, m = this.swoosh;
    m.visible = this.swK > 0.03 && N > 2;
    if (!m.visible) return;
    const P = m.geometry.attributes.position.array, C = m.geometry.attributes.color.array;
    for (let i = 0; i < this.SN; i++) {
      const s = this.sw[Math.max(0, N - this.SN + i)], u = i / (this.SN - 1), al = u * u * 0.32 * this.swK;
      P[i * 6] = s.a.x; P[i * 6 + 1] = s.a.y; P[i * 6 + 2] = s.a.z; P[i * 6 + 3] = s.b.x; P[i * 6 + 4] = s.b.y; P[i * 6 + 5] = s.b.z;
      C[i * 8] = 1; C[i * 8 + 1] = 1; C[i * 8 + 2] = 1; C[i * 8 + 3] = al * 0.35;
      C[i * 8 + 4] = 1; C[i * 8 + 5] = 1; C[i * 8 + 6] = 1; C[i * 8 + 7] = al;
    }
    m.geometry.attributes.position.needsUpdate = true; m.geometry.attributes.color.needsUpdate = true;
  }

  build(sex) {
    if (this.model) { this.scene.remove(this.model); this.mixer?.stopAllAction(); }
    const A = this.assets, src = A[sex];
    const model = this.model = SkeletonUtils.clone(src.gltf.scene);
    this.sex = sex;
    // um material por tipo, partilhado por todas as partes da malha (o glTF divide a malha por material)
    const hairMat = new THREE.MeshStandardMaterial({ map:src.hair, alphaTest:0.45, side:THREE.DoubleSide, roughness:0.8 });
    const mk = (n, roughness) => { const m = new THREE.MeshStandardMaterial({ name:n, normalMap:n === 'head' ? src.headN : src.bodyN, roughness }); m.normalScale.set(0.8, 0.8); return m; };
    this.mats = { body:mk('body', 0.7), head:mk('head', 0.58) };
    model.traverse(o => {
      if (!o.isSkinnedMesh) return;
      o.frustumCulled = false; o.castShadow = true;
      const list = (Array.isArray(o.material) ? o.material : [o.material]).map(m => m.name === 'opacity' ? hairMat : m.name === 'head' ? this.mats.head : this.mats.body);
      o.material = list.length === 1 ? list[0] : list;
    });
    const B = name => model.getObjectByName(BIP(name));
    // a coluna que as camadas de ténis rodam começa acima das ancas (no Biped as pernas penduram-se em Bip01_Spine)
    this.b = {
      pelvis:B('Pelvis'), spine:[B('Spine1'), B('Spine2'), B('Neck')], head:B('Head'),
      uaR:B('R_UpperArm'), laR:B('R_Forearm'), hR:B('R_Hand'), uaL:B('L_UpperArm'), laL:B('L_Forearm'), hL:B('L_Hand'),
      thL:B('L_Thigh'), caL:B('L_Calf'), ftL:B('L_Foot'), baL:B('L_Toe0'), thR:B('R_Thigh'), caR:B('R_Calf'), ftR:B('R_Foot'), baR:B('R_Toe0'),
    };
    this.lids = ['LEyeBlinkTop', 'REyeBlinkTop'].map(B).filter(Boolean).map(bn => ({ bn, p0:bn.position.clone() }));
    // medidas na pose de ligação
    model.position.set(0, 0, 0); model.rotation.set(0, 0, 0); model.updateMatrixWorld(true);
    const wp = o => o.getWorldPosition(new V3()), b = this.b;
    this.len = { ua:wp(b.uaR).distanceTo(wp(b.laR)), la:wp(b.laR).distanceTo(wp(b.hR)), th:wp(b.thR).distanceTo(wp(b.caR)), ca:wp(b.caR).distanceTo(wp(b.ftR)) };
    this.hipH = wp(b.pelvis).y; this.ankleH = wp(b.ftR).y;
    // calibração de cada braço para o pulso anatómico (posição neutra = pose de ligação)
    const armCal = (ua, la, hand) => {
      const hwq = hand.getWorldQuaternion(new THREE.Quaternion());
      return { ua, la, hand, uaRest:ua.quaternion.clone(), laRest:la.quaternion.clone(), qRel:hand.quaternion.clone(), qRelInv:hand.quaternion.clone().invert(), axisLocal:hand.position.clone().normalize(),
        nLocal:wp(hand).sub(wp(la)).normalize().applyQuaternion(hwq.invert()) };
    };
    this.cal = { R:armCal(b.uaR, b.laR, b.hR), L:armCal(b.uaL, b.laL, b.hL) };
    this.faceOffset = wp(b.hL).x > 0 ? 0 : Math.PI;                       // o modelo olha para +z ou -z
    this.lidDrop = wp(B('LEyeBlinkTop') || b.head).distanceTo(wp(B('LEyeBlinkBottom') || b.head)) * 0.9;
    // raquete na palma da mão direita, calibrada pelos ossos da mão (os dedos já vêm a agarrar):
    // o cabo atravessa a palma na diagonal (da base do indicador ao calcanhar da mão) e o topo do cabo fica rente ao mindinho
    const hW = wp(b.hR), F = wp(B('R_Finger2')).sub(hW).normalize(), Acr = wp(B('R_Finger1')).sub(wp(B('R_Finger4'))).normalize();
    const N = new V3().crossVectors(F, Acr).normalize();                  // costas da mão
    const axisW = Acr.clone().addScaledVector(F, 0.6).normalize();
    const hq = b.hR.getWorldQuaternion(new THREE.Quaternion()), hqi = hq.clone().invert();
    const qWorld = basisQuat(axisW, N, new THREE.Quaternion());
    this.racket = makeRacket(this.frameMat);
    this.racket.quaternion.copy(hqi).multiply(qWorld);
    // a escala do modelo (cm → m) está acima dos ossos: a raquete compensa para ficar com o tamanho real
    const ws = this.ws = b.hR.getWorldScale(new V3()).x; this.racket.scale.setScalar(1 / ws);
    this.gripY = 0.035;                                                     // centro da palma no eixo do cabo (coordenadas da raquete)
    const palmR = hW.clone().addScaledVector(F, 0.07).addScaledVector(N, -0.02);
    this.racket.position.copy(b.hR.worldToLocal(palmR.addScaledVector(axisW, this.gripY)));
    b.hR.add(this.racket);
    this.qRacketInv = this.racket.quaternion.clone().invert();
    // mão esquerda: base (dedos, mindinho→indicador, palma) na pose de ligação, para a pôr a agarrar o cabo ou o coração da raquete
    const hWl = wp(b.hL), Fl = wp(B('L_Finger2')).sub(hWl).normalize(), Al = wp(B('L_Finger1')).sub(wp(B('L_Finger4')));
    Al.addScaledVector(Fl, -Al.dot(Fl)).normalize();
    const Pl = new V3().crossVectors(Fl, Al).normalize();                   // palma da mão esquerda
    const qBasisL = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Fl, Al, Pl));
    this.qLHand = qBasisL.invert().multiply(b.hL.getWorldQuaternion(new THREE.Quaternion()));
    this.palmL = b.hL.worldToLocal(hWl.clone().addScaledVector(Fl, 0.075).addScaledVector(Pl, 0.02));
    // ossos que as camadas de ténis alteram: guardamos o valor da animação para o repor antes de cada atualização
    // (o misturador do three.js só reescreve um osso quando o valor da animação muda; sem isto as correções acumulavam)
    // capturas de ténis (ossos, estado da mistura, pega por pancada)
    this.tn = src.tennis;
    this.tnRoot = model.getObjectByName('Bip01');
    this.tnBones = this.tn ? this.tn.bones.map(n => model.getObjectByName(n)) : [];
    const NB = this.tnBones.length * 4 + 3;
    this.tOut = new Float32Array(NB); this.tTmp = new Float32Array(NB); this.tFrom = new Float32Array(NB);
    this.tw = 0; this.tKey = null; this.tTime = 0; this.tBlend = 1;
    this.gripDefault = this.racket.quaternion.clone(); this.gripClip = this.racket.quaternion.clone(); this.gripFrom = this.racket.quaternion.clone();
    this.palmLocal = this.racket.position.clone().add(new V3(0, this.gripY, 0).applyQuaternion(this.racket.quaternion).multiplyScalar(this.racket.scale.x));
    this.legIdx = this.tnBones.map(bn => /Thigh|Calf|Foot/.test(bn.name));
    const set = new Set([b.pelvis, ...b.spine, b.head, b.uaR, b.laR, b.hR, b.uaL, b.laL, b.hL, b.thL, b.caL, b.ftL, b.thR, b.caR, b.ftR, ...this.tnBones, this.tnRoot].filter(Boolean));
    this.modBones = [...set];
    this.saved = this.modBones.map(() => ({ q:new THREE.Quaternion(), p:new V3() })); this.hasSaved = false;
    // animações
    this.mixer = new THREE.AnimationMixer(model);
    this.act = {};
    for (const clip of src.gltf.animations) { const a = this.mixer.clipAction(clip); a.play(); a.setEffectiveWeight(0); this.act[clip.name] = a; }
    this.scene.add(model);
  }

  setLook(look) {
    this.look = look;
    const sex = look.sex === 'f' ? 'f' : 'm';
    if (!this.model || this.sex !== sex) this.build(sex);
    const kit = kitFor(this.assets, sex, look);
    if (this.mats.body) { this.mats.body.map = kit.body; this.mats.body.needsUpdate = true; }
    if (this.mats.head) { this.mats.head.map = kit.head; this.mats.head.needsUpdate = true; }
    this.frameMat.color.setHex(look.racket);
  }

  // s: { x, z, vx, vz, side, ball, act:{type,t,h,lat}|null, mode, split }
  update(dt, s) {
    this.t += dt;
    const sp = Math.hypot(s.vx, s.vz), b = this.b;
    const netYaw = s.side > 0 ? Math.PI : 0;
    let wantYaw = netYaw;
    if (!s.act && sp > 2.6 && s.mode !== 'serve') { const d = angDiff(Math.atan2(s.vx, s.vz), netYaw); if (Math.abs(d) < 2.0) wantYaw = netYaw + d * 0.85; }
    this.yaw += angDiff(wantYaw, this.yaw) * (1 - Math.exp(-9 * dt));
    const run0 = smooth(1.4, 3.4, sp);
    // 0) captura de ténis: que pancada, em que instante, e quanto pesa
    const T = this.tn && this.tn.clips;
    let key = null, time = 0;
    if (T && s.act && T[s.act.type]) { key = s.act.type; time = T[key].contact + (key === 'sv' && s.act.t < -0.3 ? -0.3 + (s.act.t + 0.3) * 2 : s.act.t); }
    else if (T && T.ready && s.mode === 'ready' && !s.act) { key = 'ready'; time = this.t * 0.75; }
    const want = key ? (s.act ? 1 : 1 - run0) : 0;
    this.tw = s.snap ? want : this.tw + (want - this.tw) * (1 - Math.exp(-(want > this.tw ? 16 : 7) * dt));
    if (key && key !== this.tKey) {                                         // troca de pancada: parte da pose atual
      if (this.tKey && this.tw > 0.02 && !s.snap) { this.tFrom.set(this.tOut); this.gripFrom.copy(this.gripClip); this.tBlend = 0; } else this.tBlend = 1;
      this.tKey = key;
    }
    if (key) this.tTime = time;
    const tw = this.tKey ? this.tw : 0;
    // correção para a raquete encontrar a bola: parte com um passo do corpo, parte com o braço (e agachamento)
    const corr = this.corr || (this.corr = { on:false, dx:0, dy:0, dz:0, wr:0, wc:0, rx:0, rz:0 });
    corr.on = false;
    if (T && s.act && key && key !== 'ready' && key !== 'sv' && s.act.h !== undefined) {
      const cc = T[key].cc, fhS = key === 'fh' || key === 'vf', lat = s.act.lat ?? Math.abs(cc.x);
      corr.dx = (fhS ? -lat : lat) - cc.x; corr.dy = s.act.h - cc.y; corr.dz = (s.act.fw ?? cc.z) - cc.z;
      corr.rx = clamp(corr.dx, -0.35, 0.35) * 0.75; corr.rz = clamp(corr.dz, -0.45, 0.45) * 0.85;
      corr.wr = smooth(-0.55, -0.15, s.act.t) * (1 - smooth(0.25, 0.65, s.act.t)) * tw;
      corr.wc = Math.exp(-((s.act.t / 0.2) ** 2)) * tw;
      corr.on = true;
    }
    const jp = (this.cur.jp || 0) * (1 - tw);                                // salto do serviço (procedural, se não houver captura)
    this.frame.position.set(s.x, jp, s.z); this.frame.rotation.set(0, this.yaw, 0); this.frame.updateMatrixWorld(true);
    this.model.position.set(s.x, jp, s.z); this.model.rotation.set(0, this.yaw + this.faceOffset, 0);
    if (corr.on && corr.wr > 0.001) this.model.position.add(tC.set(corr.rx * corr.wr, 0, corr.rz * corr.wr).applyQuaternion(this.frame.quaternion));

    // pose de ténis alvo
    const tg = this.tgt;
    if (s.act && RT[s.act.type]) {
      sampleP(RT[s.act.type], s.act.t, tg);
      if (s.act.h !== undefined) tg.c = Math.min(0.8, tg.c + clamp(0.95 - s.act.h, 0, 0.4) * 0.9 * Math.exp(-((s.act.t / 0.25) ** 2)));
    } else {
      const base = s.mode === 'serve' ? SV_WAIT : s.mode === 'happy' ? R_HAPPY : s.mode === 'sad' ? R_SAD : s.mode === 'walk' ? R_WALK : R_READY;
      lerpP(base, base, 0, tg);
      if (s.mode === 'serve') tg.hl[1] = 0.88 + Math.abs(Math.sin(this.t * 4.2)) * 0.12;
      if (s.mode === 'happy') tg.hl[1] += Math.sin(this.t * 9) * 0.06;
    }
    const cu = this.cur; lerpP(cu, tg, s.snap ? 1 : 1 - Math.exp(-(s.act ? 26 : 9) * dt), cu);

    // 1) animações de base: espera / andar / corrida / sprint
    const wWalk = smooth(0.25, 1.0, sp) * (1 - smooth(1.9, 3.0, sp)), wJog = smooth(1.9, 3.0, sp) * (1 - smooth(4.4, 5.6, sp)), wSpr = smooth(4.4, 5.6, sp);
    const wStand = Math.max(0, 1 - wWalk - wJog - wSpr), ready = s.mode === 'ready' || !!s.act;
    const A = this.act;
    A.Sword_Idle?.setEffectiveWeight(ready ? wStand : 0); A.Idle_Loop?.setEffectiveWeight(ready ? 0 : wStand);
    A.Walk_Loop?.setEffectiveWeight(wWalk); A.Jog_Fwd_Loop?.setEffectiveWeight(wJog); A.Sprint_Loop?.setEffectiveWeight(wSpr);
    A.Walk_Loop?.setEffectiveTimeScale(clamp(sp / 1.3, 0.6, 1.6)); A.Jog_Fwd_Loop?.setEffectiveTimeScale(clamp(sp / 3.3, 0.75, 1.4)); A.Sprint_Loop?.setEffectiveTimeScale(clamp(sp / 5.8, 0.8, 1.25));
    if (this.hasSaved) this.modBones.forEach((bn, i) => { bn.quaternion.copy(this.saved[i].q); bn.position.copy(this.saved[i].p); });
    this.mixer.update(dt);
    this.modBones.forEach((bn, i) => { this.saved[i].q.copy(bn.quaternion); this.saved[i].p.copy(bn.position); }); this.hasSaved = true;
    // 1b) pancadas reais por cima da corrida (pernas da captura só quando o jogador está quase parado)
    if (tw > 0.001) {
      const clip = T[this.tKey], legsW = s.act ? 1 - smooth(1.2, 3.0, sp) : 1 - run0;
      this.sampleClip(clip, this.tTime, this.tTmp);
      if (this.tBlend < 1) { this.tBlend = Math.min(1, this.tBlend + dt / 0.16); blendPose(this.tFrom, this.tTmp, smooth(0, 1, this.tBlend), this.tOut); }
      else this.tOut.set(this.tTmp);
      const o = this.tOut;
      this.tnBones.forEach((bn, j) => { _qs.set(o[j * 4], o[j * 4 + 1], o[j * 4 + 2], o[j * 4 + 3]); bn.quaternion.slerp(_qs, tw * (this.legIdx[j] ? legsW : 1)); });
      // deslocação da anca: o passo para a bola fica; depois da pancada volta suavemente ao sítio do jogador
      // (no serviço só uma parte, porque o jogador real entra no campo)
      const pi = this.tnBones.length * 4, at = s.act ? s.act.t : 0;
      const hf = s.act ? (this.tKey === 'sv' ? 0.35 : 1) * (1 - smooth(0.2, 0.7, at)) : 1;
      this.tnRoot.position.lerp(tA.set(o[pi] * hf, o[pi + 1], o[pi + 2] * hf), tw * legsW);
      // pega da raquete: a da pancada (calibrada no contacto), misturada com a pega normal
      this.gripClip.copy(this.tBlend < 1 ? qL.copy(this.gripFrom).slerp(clip.grip, smooth(0, 1, this.tBlend)) : clip.grip);
    }
    this.racket.quaternion.copy(this.gripDefault).slerp(this.gripClip, tw);
    this.racket.position.copy(this.palmLocal).sub(tA.set(0, this.gripY, 0).applyQuaternion(this.racket.quaternion).multiplyScalar(this.racket.scale.x));
    this.model.updateMatrixWorld(true);

    // camadas procedurais (poses-chave) só onde não há captura
    const run = run0, kP = 1 - tw;
    const wLegs = (s.act ? 1 - smooth(2.6, 4.2, sp) : 1 - smooth(0.5, 2.0, sp)) * kP;
    const wBody = (s.act ? 1 : 1 - 0.7 * run) * kP;
    const wArmR = (s.act ? 1 : 1 - 0.75 * run) * kP;
    const wArmL = (s.act ? 1 : cu.hg > 0.5 ? 1 - 0.8 * run : 1 - run) * kP;
    const fq = this.frame.quaternion;
    // bolas baixas: baixa mais a anca e inclina o tronco para a raquete lá chegar
    const low = s.act && s.act.h !== undefined ? clamp(0.95 - s.act.h, 0, 0.45) * Math.exp(-((s.act.t / 0.25) ** 2)) : 0;

    // 2) anca: altura (agachamento), split-step e rotação
    const D = this.dbg;
    if (wLegs > 0.001 && !D.noPelvis) {
      const sk = s.split !== undefined && s.split >= 0 && s.split < 0.32 && sp < 3 ? Math.sin(s.split / 0.32 * Math.PI) : 0;
      const bounce = (!s.act && s.mode === 'ready' && sp < 0.3) ? Math.sin(this.t * 11) * 0.012 : 0;
      b.pelvis.getWorldPosition(tA);
      const wantY = jp + this.hipH - cu.c * 0.2 - low * 0.3 + bounce + sk * 0.05;
      tA.y += (wantY - tA.y) * wLegs;
      b.pelvis.position.copy(b.pelvis.parent.worldToLocal(tA)); b.pelvis.updateMatrixWorld(true);
      // orientação ABSOLUTA das ancas (a animação de base já traz o corpo rodado; aqui fica exatamente como a pose pede)
      rotateWorld(b.pelvis, qTmp.setFromAxisAngle(UPV, angDiff(this.yaw + cu.pyaw, yawOf(b.thL, b.thR))), wLegs);
    }
    // 3) tronco: ombros com a rotação pedida (absoluta), repartida pela coluna, e inclinação
    const right = tB.set(1, 0, 0).applyQuaternion(fq);
    if (!D.noSpine) {
      const dTw = angDiff(this.yaw + cu.pyaw + cu.twist, yawOf(b.uaL, b.uaR)) / b.spine.length;
      for (const sb of b.spine) {
        rotateWorld(sb, qTmp.setFromAxisAngle(UPV, dTw), wBody);
        rotateWorld(sb, qTmp.setFromAxisAngle(right, (cu.lean * 0.55 + low * 1.1) / 3), wBody);
      }
    }
    // 4) pernas: base de apoio com os pés no chão (parado / a bater)
    if (wLegs > 0.001 && !D.noLegs) {
      const moving = sp > 0.15; if (moving) this.gait += dt * (4.5 + sp * 1.7);
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), lx = s.vx * cy - s.vz * sy, lz = s.vx * sy + s.vz * cy;
      const stride = Math.min(0.45, sp * 0.12), lift = Math.min(0.14, sp * 0.035), dx = moving ? lx / sp : 0, dz = moving ? lz / sp : 0;
      const stanceW = 0.13 + cu.c * 0.12, fy = cu.pyaw * 0.55, cf = Math.cos(fy), sf = Math.sin(fy);
      for (const [th, ca, ft, ba, sx] of [[b.thL, b.caL, b.ftL, b.baL, 1], [b.thR, b.caR, b.ftR, b.baR, -1]]) {
        const ph = this.gait + (sx > 0 ? 0 : Math.PI);
        let fx = sx * stanceW, fz = sx * 0.03; [fx, fz] = [fx * cf + fz * sf, -fx * sf + fz * cf];
        if (moving) { fx += dx * Math.sin(ph) * stride; fz += dz * Math.sin(ph) * stride; }
        tT.set(fx, this.ankleH + (moving ? Math.max(0, Math.cos(ph)) * lift : 0), fz).applyMatrix4(this.frame.matrixWorld);
        th.getWorldPosition(tA);
        tP.set(Math.sin(fy) + sx * 0.15, 0, Math.cos(fy)).applyQuaternion(fq);
        ik2(tA, tT, this.len.th, this.len.ca, tP, tD1, tD2);
        aimBone(th, ca, tD1, wLegs); aimBone(ca, ft, tD2, wLegs);
        aimBone(ft, ba, tC.set(Math.sin(fy) * 0.98, -0.2, Math.cos(fy)).normalize().applyQuaternion(fq), wLegs * 0.8);
      }
    }
    // 5) braços: raquete na direita (IK + orientação da face), esquerda no punho ou livre
    const toW = v => v.applyMatrix4(this.frame.matrixWorld);
    tHr.fromArray(cu.hr);
    if (s.act && s.act.h !== undefined) {
      const w = Math.exp(-((s.act.t / 0.2) ** 2)), fh = s.act.type === 'fh' || s.act.type === 'vf';
      tHr.y += clamp(s.act.h - 0.98, -0.45, 0.6) * w;
      tHr.x += (fh ? -1 : 1) * clamp((s.act.lat ?? 0.72) - 0.72, -0.4, 0.5) * w;
    }
    tRa.fromArray(cu.ra).normalize(); tRf.fromArray(cu.rf).normalize();
    toW(tHr); tRa.applyQuaternion(fq); tRf.applyQuaternion(fq);
    // mão direita orientada para a raquete apontar e a face ficar certa; o braço adapta-se para o pulso ficar natural
    basisQuat(tRa, tRf, qRacket).multiply(this.qRacketInv);
    if (!D.noArms) this.arm(this.cal.R, tHr, tP.fromArray(cu.pr).applyQuaternion(fq), wArmR, qRacket, wArmR);
    // mão esquerda: livre, ou a agarrar a raquete onde ela está de facto (cabo na esquerda a duas mãos, coração na espera)
    tHl.fromArray(cu.hl); toW(tHl);
    const gripW = D.noArms ? 0 : cu.hg * (s.act ? 1 : 1 - run) * kP;
    if (gripW > 0.01) {
      this.racket.updateMatrixWorld(true); this.racket.getWorldQuaternion(qL);
      tG.set(0, this.gripY - cu.gd, 0); this.racket.localToWorld(tG);               // ponto da raquete onde a mão agarra
      tA.set(0, -1, 0).applyQuaternion(qL);                                         // eixo da raquete (para a cabeça)
      // a mão pode rodar à volta do cabo: escolhe o ângulo em que o antebraço continua naturalmente para a mão
      tN.set(0, 0, 1).applyQuaternion(qL); tN.addScaledVector(tA, -tN.dot(tA)).normalize();
      tF.crossVectors(tA, tN);                                                      // 2.º eixo perpendicular ao cabo
      this.b.uaL.getWorldPosition(tB); tB.subVectors(tG, tB).normalize();          // do ombro esquerdo para o cabo
      let best = -9, bestA = 0;
      for (let k = 0; k < 16; k++) {
        const a = k * Math.PI / 8, ca = Math.cos(a), sa = Math.sin(a);
        tT.copy(tN).multiplyScalar(ca).addScaledVector(tF, sa);                     // palma candidata
        tP.crossVectors(tA, tT);                                                    // dedos
        qTmp.setFromRotationMatrix(_mL.makeBasis(tP, tA, tT)).multiply(this.qLHand);
        const sc = tC.copy(this.cal.L.nLocal).applyQuaternion(qTmp).dot(tB);
        if (sc > best) { best = sc; bestA = a; }
      }
      if (this.lphi === undefined || !(gripW > 0.02)) this.lphi = bestA;
      this.lphi += angDiff(bestA, this.lphi) * (s.snap ? 1 : 1 - Math.exp(-14 * dt));
      tT.copy(tN).multiplyScalar(Math.cos(this.lphi)).addScaledVector(tF, Math.sin(this.lphi));
      tF.crossVectors(tA, tT);                                                      // dedos à volta do cabo
      qTmp.setFromRotationMatrix(_mL.makeBasis(tF, tA, tT)).multiply(this.qLHand);  // rotação da mão esquerda no mundo
      tC.copy(this.palmL).multiplyScalar(this.ws).applyQuaternion(qTmp);            // do pulso ao centro da palma
      tHl.lerp(tG.sub(tC), gripW);
    }
    if (!D.noArms) this.arm(this.cal.L, tHl, tP.fromArray(cu.pl).applyQuaternion(fq), Math.max(wArmL, gripW), gripW > 0.01 ? qTmp : null, gripW);

    // 5b) pancada real: a raquete vai ter com a bola (agacha nas bolas baixas, o braço ajusta o resto)
    if (corr.on && corr.wc > 0.001 && !D.noCorr) {
      const drop = clamp(-corr.dy - 0.08, 0, 0.3) * corr.wc;
      if (drop > 0.002) this.crouch(drop);
      tC.set(corr.dx - corr.rx * corr.wr / Math.max(tw, 1e-3), corr.dy + drop / Math.max(corr.wc, 1e-3), corr.dz - corr.rz * corr.wr / Math.max(tw, 1e-3)).multiplyScalar(corr.wc).applyQuaternion(fq);
      if (tC.lengthSq() > 1e-6) { this.nudgeArm(this.cal.R, tC); if (this.tKey === 'bh') this.nudgeArm(this.cal.L, tC); }
    }

    // 6) cabeça segue a bola
    let wantY = 0, wantP = 0.1;
    if (s.ball) {
      b.head.getWorldPosition(tA); tB.set(s.ball.x, s.ball.y, s.ball.z).sub(tA);
      tB.applyQuaternion(_q.copy(fq).invert());
      wantY = clamp(Math.atan2(tB.x, tB.z) - cu.twist - cu.pyaw, -1.0, 1.0);
      wantP = clamp(Math.atan2(-tB.y, Math.hypot(tB.x, tB.z)), -0.5, 0.6);
    }
    if (s.mode === 'sad') { wantP = 0.55; wantY = 0; }
    if (s.mode === 'happy') wantP = -0.2;
    const hk = 1 - Math.exp(-10 * dt);
    this.headYaw += (wantY - this.headYaw) * hk; this.headPitch += (wantP - this.headPitch) * hk;
    const wHead = 1 - 0.75 * tw;                                            // na pancada real a cabeça já vem da captura
    if (!D.noHead) rotateWorld(b.head, qTmp.setFromAxisAngle(UPV, this.headYaw * 0.8), wHead);
    rotateWorld(b.head, qTmp.setFromAxisAngle(tC.set(1, 0, 0).applyQuaternion(fq).applyAxisAngle(UPV, this.headYaw * 0.8), this.headPitch * 0.7), wHead);

    // 6b) rasto da raquete nas pancadas
    this.updateSwoosh(s.snap ? 0 : dt, !!s.act && tw > 0.5);

    // 7) piscar de olhos (pálpebras de cima descem ~0,12 s, a intervalos irregulares)
    if (this.lids.length) {
      if (this.t > this.blinkAt) { this.blink = 0.12; this.blinkAt = this.t + 2 + Math.random() * 3.5; }
      this.blink = Math.max(0, this.blink - dt);
      const k = this.blink > 0 ? Math.sin(this.blink / 0.12 * Math.PI) : 0;
      for (const l of this.lids) {
        l.bn.position.copy(l.p0);
        if (k > 0) { l.bn.parent.getWorldQuaternion(_qp); tC.set(0, -this.lidDrop * k, 0).applyQuaternion(_qp.invert()); l.bn.position.addScaledVector(tC, 1 / l.bn.parent.getWorldScale(tA).x); }
      }
    }
  }

  // amostra uma pancada captada (interpolação entre fotogramas; a espera vai e volta para não "saltar" no fim)
  sampleClip(clip, t, out) {
    const fps = this.tn.fps, NB = this.tnBones.length;
    if (clip.loop) { const L = clip.dur, m = t % (2 * L); t = m > L ? 2 * L - m : m; }
    const f = clamp(t * fps, 0, clip.frames - 1), i0 = Math.floor(f), i1 = Math.min(i0 + 1, clip.frames - 1), u = f - i0;
    const q = clip.q, p = clip.p;
    for (let j = 0; j < NB; j++) {
      const a = (i0 * NB + j) * 4, c = (i1 * NB + j) * 4;
      _qw.set(q[a], q[a + 1], q[a + 2], q[a + 3]).normalize(); _qp.set(q[c], q[c + 1], q[c + 2], q[c + 3]).normalize(); _qw.slerp(_qp, u);
      out[j * 4] = _qw.x; out[j * 4 + 1] = _qw.y; out[j * 4 + 2] = _qw.z; out[j * 4 + 3] = _qw.w;
    }
    const k = NB * 4;
    for (let i = 0; i < 3; i++) out[k + i] = p[i0 * 3 + i] + (p[i1 * 3 + i] - p[i0 * 3 + i]) * u;
  }

  // agachar (anca desce) mantendo os pés onde estão
  crouch(drop) {
    const b = this.b;
    const legs = [[b.thL, b.caL, b.ftL], [b.thR, b.caR, b.ftR]].map(([th, ca, ft]) => ({ th, ca, ft, p:ft.getWorldPosition(new V3()), q:ft.getWorldQuaternion(new THREE.Quaternion()), k:ca.getWorldPosition(new V3()).sub(th.getWorldPosition(new V3())) }));
    this.tnRoot.position.y -= drop / this.ws; this.tnRoot.updateMatrixWorld(true);
    for (const L of legs) {
      L.th.getWorldPosition(tA);
      ik2(tA, L.p, this.len.th, this.len.ca, L.k.normalize(), tD1, tD2);
      aimBone(L.th, L.ca, tD1, 1); aimBone(L.ca, L.ft, tD2, 1);
      L.ca.getWorldQuaternion(_qp).invert().multiply(L.q); L.ft.quaternion.copy(_qp); L.ft.updateMatrixWorld(true);
    }
  }

  // empurra a mão (pulso) por "off" (mundo) mantendo o cotovelo no mesmo plano e a orientação da mão (e da raquete)
  nudgeArm(A, off) {
    A.ua.getWorldPosition(tA); A.la.getWorldPosition(tP); A.hand.getWorldPosition(tT);
    A.hand.getWorldQuaternion(qL);
    tB.copy(tT).add(off);
    tP.sub(tA).addScaledVector(tT.sub(tA).normalize(), -tP.dot(tT));         // cotovelo em relação à linha ombro–pulso
    ik2(tA, tB, this.len.ua, this.len.la, tP.lengthSq() > 1e-8 ? tP.normalize() : tP.set(0, -1, 0), tD1, tD2);
    aimBone(A.ua, A.la, tD1, 1); aimBone(A.la, A.hand, tD2, 1);
    A.la.getWorldQuaternion(_qp).invert().multiply(qL); A.hand.quaternion.copy(_qp); A.hand.updateMatrixWorld(true);
  }

  // braço com IK de 2 ossos e pulso anatómico: se houver orientação desejada para a mão (qh),
  // 1) o cotovelo coloca-se para o antebraço ficar alinhado com a mão, 2) a rotação à volta do antebraço
  // (pronação/supinação) passa para o antebraço, 3) a dobra do pulso fica limitada a ângulos reais
  arm(A, target, pole, w, qh, wHand) {
    if (w <= 0.001) return;
    A.ua.getWorldPosition(tA);
    if (qh) {
      tC.copy(A.nLocal).applyQuaternion(qh);                                   // direção do antebraço com o pulso direito
      tB.copy(target).addScaledVector(tC, -this.len.la).sub(tA).normalize();   // onde o cotovelo devia estar
      pole.normalize().multiplyScalar(0.3).addScaledVector(tB, 0.7);
    }
    // braço e antebraço partem da pose de repouso: a torção que resulta da IK é anatómica (não herdada da animação)
    A.ua.quaternion.slerp(A.uaRest, w); A.la.quaternion.slerp(A.laRest, w); A.ua.updateMatrixWorld(true);
    ik2(tA, target, this.len.ua, this.len.la, pole.normalize(), tD1, tD2);
    aimBone(A.ua, A.la, tD1, w); aimBone(A.la, A.hand, tD2, w);
    if (!qh || wHand <= 0.001) return;
    // rotação do pulso pedida, no referencial do antebraço, a partir da posição neutra
    A.la.getWorldQuaternion(_qp); _qw.copy(_qp).invert().multiply(qh).multiply(A.qRelInv);
    // torção à volta do eixo do antebraço → antebraço (limitada a ±95°)
    const ax = A.axisLocal, d = _qw.x * ax.x + _qw.y * ax.y + _qw.z * ax.z;
    _qs.set(ax.x * d, ax.y * d, ax.z * d, _qw.w); if (_qs.lengthSq() < 1e-9) _qs.identity(); else _qs.normalize();
    if (_qs.w < 0) _qs.set(-_qs.x, -_qs.y, -_qs.z, -_qs.w);
    const tw = 2 * Math.acos(clamp(_qs.w, -1, 1));
    if (tw > 1.65) _qs.slerp(qIdent, 1 - 1.65 / tw);
    qPart.copy(qIdent).slerp(_qs, wHand);
    A.la.quaternion.multiply(qPart); A.la.updateMatrixWorld(true);
    _qw.premultiply(qPart.invert());                                           // o que sobra para o pulso
    if (_qw.w < 0) _qw.set(-_qw.x, -_qw.y, -_qw.z, -_qw.w);
    const bend = 2 * Math.acos(clamp(_qw.w, -1, 1));
    if (bend > 1.15) _qw.slerp(qIdent, 1 - 1.15 / bend);                       // pulso: no máximo ~66°
    A.hand.quaternion.slerp(_qw.multiply(A.qRel), wHand); A.hand.updateMatrixWorld(true);
  }

  setVisible(v) { this.model.visible = v; }
  dispose() { this.scene.remove(this.model); this.scene.remove(this.swoosh); this.mixer.stopAllAction(); }
}
