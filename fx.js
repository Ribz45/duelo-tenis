// Efeitos de impacto: pó no ressalto, marcas da bola, rasto da bola rápida, rede a abanar e tremor de câmara.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const DUST = {
  clay:  { cols:[0xd98a58, 0xc46a3c, 0xe8a77a], size:0.17, life:0.9,  n:18, up:1.0, out:1.2, mark:0x8a3f1f, markA:0.4,  markLife:9 },
  hard:  { cols:[0xe8eef6, 0xc4d4e8],           size:0.07, life:0.32, n:8,  up:0.6, out:0.8, mark:0x1c3557, markA:0.12, markLife:1.6 },
  grass: { cols:[0x86c45f, 0x4f8f32, 0xb0dc86], size:0.08, life:0.5,  n:10, up:0.8, out:0.9, mark:0x5d8a3c, markA:0.3,  markLife:6 },
};
const PER = 18;

function softDot() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _col = new THREE.Color();

export class FX {
  constructor(scene) {
    this.scene = scene;
    const dot = softDot();
    this.bursts = [];
    for (let i = 0; i < 8; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PER * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(PER * 3), 3));
      const mat = new THREE.PointsMaterial({ size:0.1, map:dot, vertexColors:true, transparent:true, depthWrite:false, opacity:0 });
      const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.visible = false; scene.add(pts);
      this.bursts.push({ pts, vel:new Float32Array(PER * 3), n:0, t:0, life:1 });
    }
    this.bi = 0;
    this.marks = [];
    const mg = new THREE.CircleGeometry(0.055, 18);
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ color:0, transparent:true, opacity:0, depthWrite:false }));
      m.scale.set(1, 2.0, 1); m.renderOrder = 1; m.visible = false; scene.add(m);
      this.marks.push({ m, t:0, life:1, a:0 });
    }
    this.mi = 0;
    // rasto: fita que afina e só aparece com a bola rápida
    this.TN = 14; this.tp = [];
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.TN * 2 * 3), 3));
    tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.TN * 2 * 4), 4));
    const idx = []; for (let i = 0; i < this.TN - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } tg.setIndex(idx);
    this.trail = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors:true, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.DoubleSide }));
    this.trail.frustumCulled = false; scene.add(this.trail);
    this.net = null; this.netBase = null; this.waves = [];
    this.shakeAmp = 0; this.shakeDur = 0.3; this.shakeT = 1; this.offset = new THREE.Vector3();
  }

  dust(pos, surface, strength, dirX = 0, dirZ = 0) {
    const D = DUST[surface] || DUST.hard, b = this.bursts[this.bi++ % this.bursts.length];
    const n = Math.min(PER, Math.round(D.n * (0.5 + strength * 0.6)));
    const P = b.pts.geometry.attributes.position.array, C = b.pts.geometry.attributes.color.array;
    for (let i = 0; i < PER; i++) {
      const on = i < n, ang = Math.random() * Math.PI * 2, sp = D.out * (0.25 + Math.random() * 0.75) * (0.5 + strength * 0.6);
      P[i * 3] = pos.x; P[i * 3 + 1] = on ? 0.03 : -10; P[i * 3 + 2] = pos.z;
      b.vel[i * 3] = Math.cos(ang) * sp + dirX * 0.7; b.vel[i * 3 + 1] = D.up * (0.3 + Math.random() * 0.7) * (0.5 + strength * 0.6); b.vel[i * 3 + 2] = Math.sin(ang) * sp + dirZ * 0.7;
      _col.setHex(D.cols[(Math.random() * D.cols.length) | 0]); C[i * 3] = _col.r; C[i * 3 + 1] = _col.g; C[i * 3 + 2] = _col.b;
    }
    b.pts.geometry.attributes.position.needsUpdate = true; b.pts.geometry.attributes.color.needsUpdate = true;
    b.pts.material.size = D.size * (0.7 + strength * 0.5); b.n = n; b.t = 0; b.life = D.life; b.pts.visible = true;
  }

  mark(pos, surface, dirX, dirZ) {
    const D = DUST[surface] || DUST.hard; if (!D.mark) return;
    const k = this.marks[this.mi++ % this.marks.length];
    k.m.material.color.setHex(D.mark); k.a = D.markA; k.life = D.markLife; k.t = 0;
    k.m.position.set(pos.x, 0.004, pos.z); k.m.rotation.set(-Math.PI / 2, 0, Math.atan2(-dirX, -dirZ)); k.m.visible = true;
  }

  setNet(mesh) { this.net = mesh; this.netBase = mesh.geometry.attributes.position.array.slice(); this.waves.length = 0; }
  netHit(x, strength, dir) { this.waves.push({ x, a:(0.05 + strength * 0.1) * Math.sign(dir || 1), t:0 }); if (this.waves.length > 3) this.waves.shift(); }

  shake(amount, dur = 0.3) { if (amount >= this.shakeAmp * (1 - this.shakeT / this.shakeDur)) { this.shakeAmp = amount; this.shakeDur = dur; this.shakeT = 0; } }

  updateTrail(ballPos, speed, visible, camera) {
    const k = visible ? Math.min(1, Math.max(0, (speed - 14) / 12)) : 0;
    if (visible) { this.tp.push(ballPos.clone()); if (this.tp.length > this.TN) this.tp.shift(); } else this.tp.length = 0;
    const pos = this.trail.geometry.attributes.position.array, col = this.trail.geometry.attributes.color.array, N = this.tp.length;
    this.trail.visible = k > 0.02 && N > 2;
    if (!this.trail.visible) return;
    for (let i = 0; i < this.TN; i++) {
      const p = this.tp[Math.max(0, N - this.TN + i)] || ballPos, q = this.tp[Math.min(N - 1, Math.max(0, N - this.TN + i + 1))] || ballPos;
      _a.subVectors(q, p); if (_a.lengthSq() < 1e-8) _a.set(0, 0, 1);
      _b.subVectors(camera.position, p); _c.crossVectors(_a, _b).normalize();
      const u = i / (this.TN - 1), w = 0.05 * u;
      pos[i * 6] = p.x + _c.x * w; pos[i * 6 + 1] = p.y + _c.y * w; pos[i * 6 + 2] = p.z + _c.z * w;
      pos[i * 6 + 3] = p.x - _c.x * w; pos[i * 6 + 4] = p.y - _c.y * w; pos[i * 6 + 5] = p.z - _c.z * w;
      const al = u * u * 0.8 * k;
      for (const o of [0, 4]) { col[i * 8 + o] = 1; col[i * 8 + o + 1] = 1; col[i * 8 + o + 2] = 0.72; col[i * 8 + o + 3] = al; }
    }
    this.trail.geometry.attributes.position.needsUpdate = true; this.trail.geometry.attributes.color.needsUpdate = true;
  }

  update(dt) {
    for (const b of this.bursts) {
      if (!b.pts.visible) continue;
      b.t += dt; const u = b.t / b.life;
      if (u >= 1) { b.pts.visible = false; continue; }
      const P = b.pts.geometry.attributes.position.array, drag = Math.exp(-3 * dt);
      for (let i = 0; i < b.n; i++) {
        b.vel[i * 3] *= drag; b.vel[i * 3 + 2] *= drag; b.vel[i * 3 + 1] -= 2.6 * dt;
        P[i * 3] += b.vel[i * 3] * dt; P[i * 3 + 1] = Math.max(0.01, P[i * 3 + 1] + b.vel[i * 3 + 1] * dt); P[i * 3 + 2] += b.vel[i * 3 + 2] * dt;
      }
      b.pts.geometry.attributes.position.needsUpdate = true;
      b.pts.material.opacity = (1 - u) * (1 - u) * 0.9;
    }
    for (const k of this.marks) {
      if (!k.m.visible) continue;
      k.t += dt; const fade = Math.min(1, (k.life - k.t) / Math.min(2, k.life * 0.5));
      if (fade <= 0) { k.m.visible = false; continue; }
      k.m.material.opacity = k.a * Math.min(1, k.t / 0.05) * fade;
    }
    if (this.net) {
      const arr = this.net.geometry.attributes.position.array, base = this.netBase;
      let any = false;
      for (const w of this.waves) w.t += dt;
      while (this.waves.length && this.waves[0].t > 1.4) this.waves.shift();
      const h = this.net.geometry.parameters.height;
      for (let i = 0; i < arr.length; i += 3) {
        let dz = 0;
        if (this.waves.length) {
          const x = base[i], yN = (base[i + 1] + h / 2) / h, prof = 4 * yN * (1 - yN) * 0.85 + 0.15 * (1 - yN);
          for (const w of this.waves) dz += w.a * Math.exp(-((x - w.x) * (x - w.x)) / 1.3) * Math.exp(-w.t * 4.5) * Math.cos(w.t * 21) * prof;
          any = true;
        }
        arr[i + 2] = base[i + 2] + dz;
      }
      if (any || this.netDirty) { this.net.geometry.attributes.position.needsUpdate = true; this.netDirty = any; }
    }
    this.shakeT += dt;
    const s = this.shakeT < this.shakeDur ? this.shakeAmp * Math.pow(1 - this.shakeT / this.shakeDur, 2) : 0;
    this.offset.set((Math.random() * 2 - 1) * s, (Math.random() * 2 - 1) * s * 0.6, (Math.random() * 2 - 1) * s * 0.4);
    return this.offset;
  }
}
