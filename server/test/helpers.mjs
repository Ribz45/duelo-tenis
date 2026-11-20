// Ajudas partilhadas pelos testes (fetch e WebSocket globais do Node 24).
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = process.env.DT_BASE || 'http://127.0.0.1:8787';
export const WS_BASE = BASE.replace(/^http/, 'ws');
/** true quando o run.mjs arrancou o servidor com as variáveis de teste. */
export const SPAWNED = process.env.DT_SPAWNED === '1';
export const INVITE_TTL_MS = Number(process.env.DT_INVITE_TTL_MS || 30_000);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** IP falso por pedido (o wrangler dev respeita o CF-Connecting-IP enviado; em produção a Cloudflare reescreve-o). */
export const fakeIp = () => `10.${[...randomBytes(3)].join('.')}`;

export async function api(method, urlPath, { token, body, ip, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  h['CF-Connecting-IP'] = ip || fakeIp();
  const res = await fetch(BASE + urlPath, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* não JSON */
  }
  return { status: res.status, data, headers: res.headers };
}

let counter = 0;
export async function register(name, extra = {}) {
  const r = await api('POST', '/api/register', { body: { name: name || `T${++counter}`, ...extra } });
  assert.equal(r.status, 200, `register failed: ${JSON.stringify(r.data)}`);
  return r.data; // { token, user, linkKey }
}

/** Torna `a` e `b` amigos através da chave do link de `b`. */
export async function befriend(a, b) {
  const r = await api('POST', '/api/friends', { token: a.token, body: { tag: b.user.tag, key: b.linkKey } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'friends');
}

// ---------- WebSocket ----------

export class Client {
  constructor(ws) {
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.queue = []; // { data, raw }
    this.waiters = [];
    this.closeInfo = null;
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (e) => {
        this.closeInfo = { code: e.code, reason: e.reason };
        resolve(this.closeInfo);
      });
    });
    ws.addEventListener('message', (e) => {
      const raw = typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8');
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch {
        /* frame não JSON */
      }
      const entry = { data, raw };
      const i = this.waiters.findIndex((w) => w.match(entry));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(entry);
      else this.queue.push(entry);
    });
  }

  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new Client(ws);
      ws.addEventListener('open', () => resolve(client), { once: true });
      ws.addEventListener('error', () => reject(new Error('websocket failed to open')), { once: true });
    });
  }

  /** Resolve true se a ligação for recusada (nunca abre). */
  static async rejected(url, ms = 5000) {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        ws.close();
        resolve(false);
      }, ms);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        ws.close();
        resolve(false);
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  /** Liga e espera pelo fecho: { code, frames } (1006 se o upgrade for recusado por HTTP). */
  static async closeResult(url, ms = 20000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const frames = [];
      const t = setTimeout(() => {
        ws.close();
        reject(new Error('socket was not closed by the server'));
      }, ms);
      ws.addEventListener('message', (e) => frames.push(String(e.data)));
      ws.addEventListener('close', (e) => {
        clearTimeout(t);
        resolve({ code: e.code, frames });
      });
    });
  }

  static matcher(pred) {
    if (typeof pred === 'string') return (e) => e.data && (e.data.t === pred || e.data.$ === pred);
    if (typeof pred === 'function') return (e) => pred(e.data, e.raw);
    return () => true;
  }

  /** Espera pela próxima mensagem que satisfaça `pred` (string = valor de "t" ou "$"). Devolve o objeto. */
  async next(pred, ms = 4000) {
    return (await this.nextEntry(pred, ms)).data;
  }

  async nextRaw(pred, ms = 4000) {
    return (await this.nextEntry(pred, ms)).raw;
  }

  nextEntry(pred, ms) {
    const match = Client.matcher(pred);
    const i = this.queue.findIndex(match);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = {
        match,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timeout waiting for ${String(pred)}; queued: ${this.queue.map((e) => e.raw).join(' | ')}`));
      }, ms);
      this.waiters.push(w);
    });
  }

  /** Garante que nenhuma mensagem que satisfaça `pred` chega em `ms`. */
  async none(pred, ms = 400) {
    const match = Client.matcher(pred);
    await sleep(ms);
    const found = this.queue.find(match);
    assert.equal(found, undefined, `unexpected message: ${found?.raw}`);
  }

  send(msg) {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  async close() {
    if (this.closeInfo) return this.closeInfo;
    this.ws.close(1000);
    return this.closed;
  }
}

export const hubUrl = (token) => `${WS_BASE}/ws?token=${encodeURIComponent(token)}`;
export const roomUrl = (matchId, ticket) => `${WS_BASE}/ws/room/${matchId}?ticket=${encodeURIComponent(ticket)}`;

/** Liga ao hub e consome o "hello". */
export async function connectHub(account) {
  const c = await Client.open(hubUrl(account.token));
  c.hello = await c.next('hello');
  return c;
}

/** Cria uma partida online via convite (a convida, b aceita). Devolve os dois "match" e fecha os sockets se pedido. */
export async function createMatch(a, b, { surface = 'clay', keepOpen = false } = {}) {
  const ha = await connectHub(a);
  const hb = await connectHub(b);
  ha.send({ t: 'invite', to: b.user.id, cfg: { surface } });
  const sent = await ha.next('invite-sent');
  const inv = await hb.next('invite');
  assert.equal(inv.id, sent.id);
  hb.send({ t: 'invite-reply', id: inv.id, accept: true });
  const ma = await ha.next('match');
  const mb = await hb.next('match');
  if (!keepOpen) {
    await ha.close();
    await hb.close();
  }
  return { host: ma, guest: mb, ha, hb };
}

// ---------- Bilhetes forjados (testes de bilhete expirado) ----------

export function devSecret() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
  const m = /^SECRET\s*=\s*"?([^"\r\n]+)"?/m.exec(readFileSync(file, 'utf8'));
  assert.ok(m, 'SECRET not found in .dev.vars');
  return m[1].trim();
}

export function forgeTicket(secret, claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
