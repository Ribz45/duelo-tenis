// Jogadores com modelos humanos (Quaternius, CC0) e animações de corrida/espera, com as poses de ténis por cima:
// pernas fletidas e base de apoio, rotação do tronco, braços em IK com a raquete alinhada à bola e a cabeça a seguir a bola.
// Mesma interface do boneco simples (player3d.js): update(dt, s), setLook(look).
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from './vendor/jsm/utils/SkeletonUtils.js';
import { TRACKS, sampleTrack, lerpPose, ik2, READY, WALK, HAPPY, SAD, SV_IDLE, strings, angDiff, clamp } from './player3d.js?v=6';

const V3 = THREE.Vector3;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const SHOES = 0xf4f5f7, SOCKS = 0xf2f2f2;

// ---------------------------------------------------------------- carregar os ficheiros (uma vez)
const loadImage = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
export async function loadAthleteAssets(base = 'models/') {
  const loader = new GLTFLoader(), tl = new THREE.TextureLoader();
  const tex = (u, srgb = true) => new Promise((res, rej) => tl.load(base + 'tex/' + u, t => { t.flipY = false; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; res(t); }, undefined, rej));
  const [m, f, anims, fingers, mL, mD, fL, fD, mN, fN, h1, h2, eyes] = await Promise.all([
    loader.loadAsync(base + 'char_male.glb'), loader.loadAsync(base + 'char_female.glb'), loader.loadAsync(base + 'anims.glb'),
    fetch(base + 'fingers.json').then(r => r.json()),
    loadImage(base + 'tex/male_light.jpg'), loadImage(base + 'tex/male_dark.jpg'), loadImage(base + 'tex/female_light.jpg'), loadImage(base + 'tex/female_dark.jpg'),
    tex('male_normal.jpg', false), tex('female_normal.jpg', false), tex('hair1.jpg'), tex('hair2.jpg'), tex('eyes.jpg'),
  ]);
  return { m:{ gltf:m, skin:{ light:mL, dark:mD }, normal:mN }, f:{ gltf:f, skin:{ light:fL, dark:fD }, normal:fN },
    clips:anims.animations, fingers, hair:{ 1:h1, 2:h2 }, eyes, regions:new Map() };
}

// ---------------------------------------------------------------- roupa pintada na textura (pelos ossos de cada vértice)
// 0 pele · 1 camisola · 2 calções · 3 meias · 4 sapatilhas
function bodyRegions(mesh) {
  const g = mesh.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const names = mesh.skeleton.bones.map(b => b.name), m4 = new THREE.Matrix4();
  const bp = n => new V3().setFromMatrixPosition(m4.copy(mesh.skeleton.boneInverses[names.indexOf(n)]).invert());
  const hipY = (bp('thigh_l').y + bp('thigh_r').y) / 2, kneeY = (bp('calf_l').y + bp('calf_r').y) / 2, ankleY = (bp('foot_l').y + bp('foot_r').y) / 2;
  const arm = { l:[bp('upperarm_l'), bp('lowerarm_l')], r:[bp('upperarm_r'), bp('lowerarm_r')] };
  const reg = new Uint8Array(pos.count), p = new V3(), d = new V3();
  for (let i = 0; i < pos.count; i++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
    const b = names[best], y = pos.getY(i);
    let r = 0;
    if (/^spine_0[1-3]$|^clavicle_/.test(b)) r = 1;
    else if (/^upperarm_/.test(b)) {
      const [s, e] = arm[b.slice(-1)]; p.fromBufferAttribute(pos, i).sub(s); d.subVectors(e, s);
      r = p.dot(d) / d.lengthSq() < 0.42 ? 1 : 0;                         // manga curta
    }
    else if (b === 'pelvis') r = y > hipY + 0.07 ? 1 : 2;
    else if (/^thigh_/.test(b)) r = y > kneeY + (hipY - kneeY) * 0.45 ? 2 : 0;
    else if (/^calf_/.test(b)) r = y < ankleY + 0.12 ? 3 : 0;
    else if (/^(foot|ball)_/.test(b)) r = 4;
    reg[i] = r;
  }
  return reg;
}
function paintKit(img, mesh, reg, look) {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, S, S);
  const layer = document.createElement('canvas'); layer.width = layer.height = S;
  const L = layer.getContext('2d'), uv = mesh.geometry.attributes.uv, idx = mesh.geometry.index;
  const cols = [null, look.shirt, look.shorts, SOCKS, SHOES].map(h => h == null ? null : '#' + new THREE.Color(h).getHexString());
  L.lineJoin = 'round'; L.lineWidth = 2.5;
  const n = idx ? idx.count : uv.count;
  for (let t = 0; t < n; t += 3) {
    const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, cc = idx ? idx.getX(t + 2) : t + 2;
    const ra = reg[a], rb = reg[b], rc = reg[cc];
    const r = ra === rb || ra === rc ? ra : rb === rc ? rb : Math.max(ra, rb, rc);
    if (!r) continue;
    L.fillStyle = L.strokeStyle = cols[r];
    L.beginPath(); L.moveTo(uv.getX(a) * S, uv.getY(a) * S); L.lineTo(uv.getX(b) * S, uv.getY(b) * S); L.lineTo(uv.getX(cc) * S, uv.getY(cc) * S); L.closePath();
    L.fill(); L.stroke();
  }
  // um pouco do relevo original por cima da roupa (só onde há roupa)
  L.globalCompositeOperation = 'source-atop'; L.globalAlpha = 0.16; L.filter = 'grayscale(1) contrast(1.3)';
  L.drawImage(img, 0, 0, S, S);
  g.drawImage(layer, 0, 0);
  const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
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
const _a = new V3(), _b = new V3(), _c = new V3(), _q = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qs = new THREE.Quaternion();
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
// orientação no mundo de uma base (eixo da raquete = -y, normal da face = +z)
function basisQuat(axis, face, out) {
  _y.copy(axis).negate().normalize();
  _z.copy(face).addScaledVector(_y, -face.dot(_y)); if (_z.lengthSq() < 1e-6) _z.set(1, 0, 0).addScaledVector(_y, -_y.x); _z.normalize();
  _x.crossVectors(_y, _z);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

// ---------------------------------------------------------------- atleta
const tA = new V3(), tB = new V3(), tC = new V3(), tT = new V3(), tP = new V3(), tHr = new V3(), tHl = new V3(), tRa = new V3(), tRf = new V3(), tD1 = new V3(), tD2 = new V3();
const qTmp = new THREE.Quaternion(), qRacket = new THREE.Quaternion(), qInvR = new THREE.Quaternion(), UPV = new V3(0, 1, 0);

export class RealAthlete {
  constructor(scene, assets, look) {
    this.scene = scene; this.assets = assets;
    this.frame = new THREE.Object3D();          // referencial do jogador: pés no chão, +z para a rede
    this.frameMat = new THREE.MeshStandardMaterial({ color:look.racket, roughness:0.35 });
    this.cur = lerpPose(READY, READY, 0, {}); this.tgt = lerpPose(READY, READY, 0, {});
    this.yaw = 0; this.gait = 0; this.t = 0; this.headYaw = 0; this.headPitch = 0;
    this.dbg = {};
    this.setLook(look);
  }

  build(sex) {
    if (this.model) { this.scene.remove(this.model); this.mixer?.stopAllAction(); }
    const A = this.assets, src = A[sex];
    const model = this.model = SkeletonUtils.clone(src.gltf.scene);
    this.sex = sex; this.meshes = {}; this.hairs = [];
    model.traverse(o => {
      if (!o.isSkinnedMesh) return;
      o.frustumCulled = false; o.castShadow = true;
      const mn = o.material.name;
      if (mn === 'body') this.meshes.body = o;
      else if (mn === 'eyes') { o.material = new THREE.MeshStandardMaterial({ map:A.eyes, roughness:0.3 }); o.castShadow = false; }
      else {
        const isBrow = /Eyebrows/.test(o.name);
        o.material = new THREE.MeshStandardMaterial({ map:A.hair[o.userData.hairTex || 1], roughness:0.75, side:THREE.DoubleSide });
        if (isBrow && o.name !== 'Eyebrows') o.visible = false;             // sobrancelhas repetidas
        else if (!isBrow) this.hairs.push(o);
        if (isBrow) o.castShadow = false;
      }
    });
    const body = this.meshes.body;
    const key = sex;
    if (!A.regions.has(key)) A.regions.set(key, bodyRegions(body));
    this.regions = A.regions.get(key);
    body.material = new THREE.MeshStandardMaterial({ normalMap:src.normal, roughness:0.62 });
    const B = name => model.getObjectByName(name);
    this.b = {
      pelvis:B('pelvis'), spine:[B('spine_01'), B('spine_02'), B('spine_03')], head:B('Head'),
      uaR:B('upperarm_r'), laR:B('lowerarm_r'), hR:B('hand_r'), uaL:B('upperarm_l'), laL:B('lowerarm_l'), hL:B('hand_l'),
      thL:B('thigh_l'), caL:B('calf_l'), ftL:B('foot_l'), baL:B('ball_l'), thR:B('thigh_r'), caR:B('calf_r'), ftR:B('foot_r'), baR:B('ball_r'),
    };
    // medidas na pose de ligação
    model.position.set(0, 0, 0); model.rotation.set(0, 0, 0); model.updateMatrixWorld(true);
    const wp = o => o.getWorldPosition(new V3()), b = this.b;
    this.len = { ua:wp(b.uaR).distanceTo(wp(b.laR)), la:wp(b.laR).distanceTo(wp(b.hR)), th:wp(b.thR).distanceTo(wp(b.caR)), ca:wp(b.caR).distanceTo(wp(b.ftR)) };
    this.hipH = wp(b.pelvis).y; this.ankleH = wp(b.ftR).y;
    this.faceOffset = wp(b.hL).x > 0 ? 0 : Math.PI;                       // o modelo olha para +z ou -z
    // pose dos dedos (mão direita a agarrar, esquerda relaxada)
    for (const [n, q] of Object.entries(A.fingers)) { const bone = B(n); if (bone) bone.quaternion.fromArray(q); }
    // raquete na palma da mão direita, calibrada pelos ossos da mão
    model.updateMatrixWorld(true);
    const hW = wp(b.hR), F = wp(B('middle_01_r')).sub(hW).normalize(), Acr = wp(B('index_01_r')).sub(wp(B('pinky_01_r'))).normalize();
    const N = new V3().crossVectors(F, Acr).normalize();
    const axisW = Acr.clone().addScaledVector(F, 0.35).normalize();
    const hq = b.hR.getWorldQuaternion(new THREE.Quaternion()), hqi = hq.clone().invert();
    const qWorld = basisQuat(axisW, N, new THREE.Quaternion());
    this.racket = makeRacket(this.frameMat);
    this.racket.quaternion.copy(hqi).multiply(qWorld);
    this.racket.position.copy(b.hR.worldToLocal(hW.clone().addScaledVector(F, 0.075).addScaledVector(N, -0.02)));
    b.hR.add(this.racket);
    qInvR.copy(this.racket.quaternion).invert(); this.qRacketInv = qInvR.clone();
    // ossos que as camadas de ténis alteram: guardamos o valor da animação para o repor antes de cada atualização
    // (o misturador do three.js só reescreve um osso quando o valor da animação muda; sem isto as correções acumulavam)
    this.modBones = [b.pelvis, ...b.spine, b.head, b.uaR, b.laR, b.hR, b.uaL, b.laL, b.hL, b.thL, b.caL, b.ftL, b.thR, b.caR, b.ftR];
    this.saved = this.modBones.map(() => ({ q:new THREE.Quaternion(), p:new V3() })); this.hasSaved = false;
    // animações
    this.mixer = new THREE.AnimationMixer(model);
    this.act = {};
    for (const clip of A.clips) { const a = this.mixer.clipAction(clip); a.play(); a.setEffectiveWeight(0); this.act[clip.name] = a; }
    this.scene.add(model);
  }

  setLook(look) {
    this.look = look;
    const sex = look.sex === 'f' ? 'f' : 'm';
    if (!this.model || this.sex !== sex) this.build(sex);
    const src = this.assets[sex];
    const old = this.meshes.body.material.map; if (old) old.dispose();
    this.meshes.body.material.map = paintKit(src.skin[look.tone === 'dark' ? 'dark' : 'light'], this.meshes.body, this.regions, look);
    this.meshes.body.material.needsUpdate = true;
    for (const h of this.hairs) {
      h.visible = h.name === look.hairStyle || (h.name === 'Hair_Beard' && !!look.beard);
      h.material.color.setHex(look.hair).lerp(new THREE.Color(0xffffff), 0.35);
    }
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
    this.frame.position.set(s.x, 0, s.z); this.frame.rotation.set(0, this.yaw, 0); this.frame.updateMatrixWorld(true);
    this.model.position.set(s.x, 0, s.z); this.model.rotation.set(0, this.yaw + this.faceOffset, 0);

    // pose de ténis alvo (igual ao boneco simples)
    const tg = this.tgt;
    if (s.act && TRACKS[s.act.type]) {
      sampleTrack(TRACKS[s.act.type], s.act.t, tg);
      if (s.act.h !== undefined) tg.c = Math.min(0.8, tg.c + clamp(0.95 - s.act.h, 0, 0.4) * 0.9 * Math.exp(-((s.act.t / 0.25) ** 2)));
    } else {
      const base = s.mode === 'serve' ? SV_IDLE : s.mode === 'happy' ? HAPPY : s.mode === 'sad' ? SAD : s.mode === 'walk' ? WALK : READY;
      lerpPose(base, base, 0, tg);
      if (s.mode === 'serve') tg.hl[1] = 0.88 + Math.abs(Math.sin(this.t * 4.2)) * 0.12;
      if (s.mode === 'happy') tg.hl[1] += Math.sin(this.t * 9) * 0.06;
    }
    const cu = this.cur; lerpPose(cu, tg, 1 - Math.exp(-(s.act ? 26 : 9) * dt), cu);

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
    this.model.updateMatrixWorld(true);

    const run = smooth(1.4, 3.4, sp);
    const wLegs = s.act ? 1 - smooth(2.6, 4.2, sp) : 1 - smooth(0.5, 2.0, sp);
    const wBody = s.act ? 1 : 1 - 0.7 * run;
    const wArmR = s.act ? 1 : 1 - 0.75 * run;
    const wArmL = s.act ? 1 : cu.hg > 0.5 ? 1 - 0.8 * run : 1 - run;
    const fq = this.frame.quaternion;
    // bolas baixas: baixa mais a anca e inclina o tronco para a raquete lá chegar
    const low = s.act && s.act.h !== undefined ? clamp(0.95 - s.act.h, 0, 0.45) * Math.exp(-((s.act.t / 0.25) ** 2)) : 0;

    // 2) anca: altura (agachamento), split-step e rotação
    const D = this.dbg;
    if (wLegs > 0.001 && !D.noPelvis) {
      const sk = s.split !== undefined && s.split >= 0 && s.split < 0.32 && sp < 3 ? Math.sin(s.split / 0.32 * Math.PI) : 0;
      const bounce = (!s.act && s.mode === 'ready' && sp < 0.3) ? Math.sin(this.t * 11) * 0.012 : 0;
      b.pelvis.getWorldPosition(tA);
      const wantY = this.hipH - cu.c * 0.2 - low * 0.3 + bounce + sk * 0.05;
      tA.y += (wantY - tA.y) * wLegs;
      b.pelvis.position.copy(b.pelvis.parent.worldToLocal(tA)); b.pelvis.updateMatrixWorld(true);
      rotateWorld(b.pelvis, qTmp.setFromAxisAngle(UPV, cu.pyaw), wLegs);
    }
    // 3) tronco: rotação dos ombros e inclinação, repartidas pela coluna
    const right = tB.set(1, 0, 0).applyQuaternion(fq);
    if (!D.noSpine) for (const sb of b.spine) {
      rotateWorld(sb, qTmp.setFromAxisAngle(UPV, (cu.twist + (wLegs > 0.5 ? 0 : cu.pyaw * 0.5)) / 3), wBody);
      rotateWorld(sb, qTmp.setFromAxisAngle(right, (cu.lean * 0.55 + low * 1.1) / 3), wBody);
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
    tHl.fromArray(cu.hl); if (cu.hg > 0.01) tHl.lerp(tC.copy(tHr).addScaledVector(tRa, 0.13), cu.hg);
    toW(tHr); toW(tHl); tRa.applyQuaternion(fq); tRf.applyQuaternion(fq);
    if (!D.noArms) this.arm(b.uaR, b.laR, b.hR, tHr, tP.fromArray(cu.pr).applyQuaternion(fq), wArmR);
    if (wArmR > 0.001 && !D.noArms) {                                                  // mão orientada para a raquete apontar e a face ficar certa
      basisQuat(tRa, tRf, qRacket).multiply(this.qRacketInv);
      b.laR.getWorldQuaternion(_qp).invert().multiply(qRacket);
      b.hR.quaternion.slerp(_qp, wArmR); b.hR.updateMatrixWorld(true);
    }
    if (!D.noArms) this.arm(b.uaL, b.laL, b.hL, tHl, tP.fromArray(cu.pl).applyQuaternion(fq), wArmL);

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
    if (!D.noHead) rotateWorld(b.head, qTmp.setFromAxisAngle(UPV, this.headYaw * 0.8), 1);
    rotateWorld(b.head, qTmp.setFromAxisAngle(tC.set(1, 0, 0).applyQuaternion(fq).applyAxisAngle(UPV, this.headYaw * 0.8), this.headPitch * 0.7), 1);
  }

  arm(ua, la, hand, target, pole, w) {
    if (w <= 0.001) return;
    ua.getWorldPosition(tA);
    ik2(tA, target, this.len.ua, this.len.la, pole.normalize(), tD1, tD2);
    aimBone(ua, la, tD1, w); aimBone(la, hand, tD2, w);
  }

  setVisible(v) { this.model.visible = v; }
  dispose() { this.scene.remove(this.model); this.mixer.stopAllAction(); }
}
