// Hub: instância global única. Dono da base de dados (SQLite) e da presença/convites por WebSocket.
// Hibernação: o estado de cada socket vive em serializeAttachment ({ uid, sid, status, at }) e é sempre
// reconstruído a partir de ctx.getWebSockets(); os convites ficam em SQLite. Nada depende de memória.
import { DurableObject } from 'cloudflare:workers';
import { handleApi } from './api.js';
import { migrate } from './schema.js';
import * as db from './store.js';
import {
  HttpError,
  TICKET_TTL_MS,
  envInt,
  isId,
  jsonError,
  makeTicket,
  newId,
  normalizeToken,
  requireSecret,
  sha256Hex,
} from './util.js';

const MAX_SOCKETS_PER_USER = 5;
const MAX_FRAME_CHARS = 4096;
const MAX_MSGS_PER_SEC = 10;
const MAX_PENDING_INVITES = 5; // por remetente
const SURFACES = ['hard', 'clay', 'grass'];
const STATUSES = ['lobby', 'match'];

const tagOf = (uid) => 'u:' + uid;
const cleanCfg = (cfg) => ({ surface: SURFACES.includes(cfg?.surface) ? cfg.surface : 'hard' });

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => migrate(this.sql));
    // Contadores de mensagens/s por socket (só memória; se hibernar, recomeçam — inofensivo).
    this.rate = new WeakMap();
  }

  get inviteTtl() {
    return envInt(this.env, 'INVITE_TTL_MS', 30_000, 500, 120_000);
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/ws') return await this.acceptSocket(request, url);
      return await handleApi(this, request, url);
    } catch (err) {
      if (err instanceof HttpError) return jsonError(err.status, err.code, err.message);
      console.error('hub_error', err?.name, err?.message, err?.stack);
      return jsonError(500, 'internal', 'Internal error');
    }
  }

  /** Utilizador do token (ou null). Só o hash SHA-256 do token está guardado. */
  async authUser(rawToken) {
    const token = normalizeToken(rawToken);
    if (!token) return null;
    return db.userByTokenHash(this.sql, await sha256Hex(token));
  }

  // ---------- Sockets e presença ----------

  /** Sockets abertos de um utilizador: [{ ws, att }] (opcionalmente sem o socket `exceptSid`). */
  sockets(uid, exceptSid) {
    const out = [];
    for (const ws of this.ctx.getWebSockets(tagOf(uid))) {
      const att = ws.deserializeAttachment();
      if (att && !att.closed && att.sid !== exceptSid) out.push({ ws, att });
    }
    return out;
  }

  presence(uid, exceptSid) {
    const list = this.sockets(uid, exceptSid);
    return { online: list.length > 0, status: list.length ? list[0].att.status : null };
  }

  /** Envia a todos os sockets do utilizador. */
  send(uid, msg) {
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const { ws } of this.sockets(uid)) {
      try {
        ws.send(text);
      } catch {
        /* socket a fechar */
      }
    }
  }

  /** Objeto "friend" visto por `viewerId`: { ...user, online, status, lastSeen, h2h }. */
  friendView(viewerId, row, h2h) {
    const p = this.presence(row.id);
    return {
      ...db.publicUser(row),
      online: p.online,
      status: p.status,
      lastSeen: p.online ? Date.now() : row.last_seen,
      h2h: h2h || db.h2h(this.sql, viewerId, row.id),
    };
  }

  friendsOf(uid) {
    const h2h = db.h2hAll(this.sql, uid);
    return db.friendRows(this.sql, uid).map((row) => this.friendView(uid, row, h2h.get(row.id) || { w: 0, l: 0 }));
  }

  broadcastPresence(uid, lastSeen) {
    const p = this.presence(uid);
    const msg = JSON.stringify(
      p.online
        ? { t: 'presence', id: uid, online: true, status: p.status }
        : { t: 'presence', id: uid, online: false, status: null, lastSeen },
    );
    for (const fid of db.friendIds(this.sql, uid)) this.send(fid, msg);
  }

  setStatus(uid, status) {
    if (!STATUSES.includes(status)) return;
    let changed = false;
    for (const { ws, att } of this.sockets(uid)) {
      if (att.status === status) continue;
      ws.serializeAttachment({ ...att, status });
      changed = true;
    }
    if (changed) this.broadcastPresence(uid);
  }

  async acceptSocket(request, url) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return jsonError(426, 'upgrade_required', 'Expected a WebSocket upgrade');
    }
    const user = await this.authUser(url.searchParams.get('token'));
    if (!user) return jsonError(401, 'unauthorized', 'Missing or invalid token');

    const now = Date.now();
    const existing = this.sockets(user.id);
    // Limite de abas por utilizador: fecha as mais antigas.
    existing.sort((a, b) => a.att.at - b.att.at);
    while (existing.length >= MAX_SOCKETS_PER_USER) {
      const { ws, att } = existing.shift();
      ws.serializeAttachment({ ...att, closed: true });
      try {
        ws.close(4001, 'too many connections');
      } catch {
        /* já fechado */
      }
    }
    // Uma nova aba herda o estado atual; a primeira ligação entra em 'lobby'.
    const status = existing.length ? existing[0].att.status : 'lobby';

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [tagOf(user.id)]);
    server.serializeAttachment({ uid: user.id, sid: newId(8), status, at: now });
    db.touchLastSeen(this.sql, user.id, now);

    server.send(JSON.stringify({ t: 'hello', me: db.publicUser(user), friends: this.friendsOf(user.id) }));
    // Convites ainda pendentes para este utilizador (ex.: reconexão dentro dos 30 s).
    const pending = this.sql.exec('SELECT * FROM invites WHERE to_id = ? AND exp > ?', user.id, now).toArray();
    for (const inv of pending) {
      const from = db.publicUser(db.userById(this.sql, inv.from_id));
      if (from) server.send(JSON.stringify({ t: 'invite', id: inv.id, from, cfg: JSON.parse(inv.cfg), exp: inv.exp }));
    }
    if (!existing.length) this.broadcastPresence(user.id);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    if (!att || att.closed) return;
    if (typeof message !== 'string' || message.length > MAX_FRAME_CHARS) return;

    const sec = Math.floor(Date.now() / 1000);
    let r = this.rate.get(ws);
    if (!r || r.sec !== sec) this.rate.set(ws, (r = { sec, n: 0 }));
    if (++r.n > MAX_MSGS_PER_SEC) return;

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    try {
      switch (msg.t) {
        case 'ping':
          ws.send(JSON.stringify({ t: 'pong', time: Date.now() }));
          break;
        case 'status':
          this.setStatus(att.uid, msg.s);
          break;
        case 'invite':
          this.invite(ws, att.uid, msg);
          break;
        case 'invite-cancel':
          this.inviteCancel(att.uid, msg.id);
          break;
        case 'invite-reply':
          await this.inviteReply(ws, att.uid, msg);
          break;
        default:
          break; // mensagens desconhecidas são ignoradas
      }
    } catch (err) {
      console.error('hub_ws_error', msg.t, err?.message, err?.stack);
    }
  }

  async webSocketClose(ws, code) {
    this.socketGone(ws);
    try {
      ws.close(code >= 3000 && code <= 4999 ? code : 1000, 'bye');
    } catch {
      /* já fechado */
    }
  }

  async webSocketError(ws) {
    this.socketGone(ws);
  }

  socketGone(ws) {
    const att = ws.deserializeAttachment();
    if (!att || att.closed) return;
    try {
      ws.serializeAttachment({ ...att, closed: true });
    } catch {
      /* já fechado: a exclusão por sid chega */
    }
    if (this.sockets(att.uid, att.sid).length) return; // ainda tem outra aba aberta
    const now = Date.now();
    db.touchLastSeen(this.sql, att.uid, now);
    this.cancelInvitesFrom(att.uid); // convites feitos por quem saiu deixam de fazer sentido
    this.broadcastPresence(att.uid, now);
  }

  // ---------- Convites ----------

  /** Apaga o convite e avisa o destinatário (se `notice` for dado). */
  dropInvite(inv, notice) {
    this.sql.exec('DELETE FROM invites WHERE id = ?', inv.id);
    if (notice) this.send(inv.to_id, notice);
  }

  cancelInvitesFrom(uid) {
    for (const inv of this.sql.exec('SELECT id, to_id FROM invites WHERE from_id = ?', uid).toArray()) {
      this.dropInvite(inv, { t: 'invite-cancelled', id: inv.id });
    }
  }

  cancelInvitesBetween(a, b) {
    const rows = this.sql
      .exec('SELECT id, to_id FROM invites WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', a, b, b, a)
      .toArray();
    for (const inv of rows) this.dropInvite(inv, { t: 'invite-cancelled', id: inv.id });
  }

  invite(ws, uid, msg) {
    const to = typeof msg.to === 'string' ? msg.to.slice(0, 32) : null;
    const fail = (reason) => ws.send(JSON.stringify({ t: 'invite-failed', to, reason }));
    if (!isId(to) || to === uid || !db.areFriends(this.sql, uid, to)) return fail('not-friend');
    const target = this.presence(to);
    if (!target.online) return fail('offline');
    if (target.status === 'match') return fail('busy');

    const now = Date.now();
    const sql = this.sql;
    sql.exec('DELETE FROM invites WHERE exp <= ?', now); // limpeza de expirados
    // Um só convite pendente por par: o novo substitui o anterior.
    for (const inv of sql.exec('SELECT id, to_id FROM invites WHERE from_id = ? AND to_id = ?', uid, to).toArray()) {
      this.dropInvite(inv, { t: 'invite-cancelled', id: inv.id });
    }
    const mine = sql.exec('SELECT id, to_id FROM invites WHERE from_id = ? ORDER BY exp', uid).toArray();
    while (mine.length >= MAX_PENDING_INVITES) {
      const inv = mine.shift();
      this.dropInvite(inv, { t: 'invite-cancelled', id: inv.id });
    }

    const id = newId();
    const cfg = cleanCfg(msg.cfg);
    const exp = now + this.inviteTtl;
    sql.exec('INSERT INTO invites (id, from_id, to_id, cfg, exp) VALUES (?, ?, ?, ?, ?)', id, uid, to, JSON.stringify(cfg), exp);
    const from = db.publicUser(db.userById(sql, uid));
    this.send(to, { t: 'invite', id, from, cfg, exp });
    ws.send(JSON.stringify({ t: 'invite-sent', id, to, exp }));
  }

  inviteCancel(uid, id) {
    if (!isId(id)) return;
    const inv = this.sql.exec('SELECT id, to_id FROM invites WHERE id = ? AND from_id = ?', id, uid).toArray()[0];
    if (inv) this.dropInvite(inv, { t: 'invite-cancelled', id });
  }

  async inviteReply(ws, uid, msg) {
    const id = isId(msg.id) ? msg.id : null;
    const expired = () => ws.send(JSON.stringify({ t: 'invite-expired', id: typeof msg.id === 'string' ? msg.id.slice(0, 32) : null }));
    const now = Date.now();
    const sql = this.sql;
    const inv = id ? sql.exec('SELECT * FROM invites WHERE id = ?', id).toArray()[0] : null;
    if (!inv || inv.to_id !== uid) return expired();
    sql.exec('DELETE FROM invites WHERE id = ?', id); // antes de qualquer await: evita dupla aceitação
    if (inv.exp <= now) return expired();

    if (msg.accept !== true) {
      this.send(inv.from_id, { t: 'invite-declined', id });
      return;
    }

    const host = db.userById(sql, inv.from_id);
    const guest = db.userById(sql, uid);
    const hostP = this.presence(inv.from_id);
    if (!host || !guest || !hostP.online || hostP.status === 'match' || !db.areFriends(sql, host.id, guest.id)) {
      return expired();
    }

    // Cria a partida: p1 = quem convidou (anfitrião), p2 = convidado.
    const matchId = newId(16);
    const cfg = JSON.parse(inv.cfg);
    sql.exec('INSERT INTO matches (id, p1, p2, cfg, created_at) VALUES (?, ?, ?, ?, ?)', matchId, host.id, guest.id, inv.cfg, now);
    // Os dois deixam de estar livres: cancela outros convites que tenham feito.
    this.cancelInvitesFrom(host.id);
    this.cancelInvitesFrom(guest.id);
    this.setStatus(host.id, 'match');
    this.setStatus(guest.id, 'match');

    const secret = requireSecret(this.env);
    const exp = now + TICKET_TTL_MS;
    const [hostTicket, guestTicket] = await Promise.all([
      makeTicket(secret, matchId, host.id, exp),
      makeTicket(secret, matchId, guest.id, exp),
    ]);
    this.send(host.id, { t: 'match', matchId, role: 'host', opp: db.publicUser(guest), cfg, ticket: hostTicket });
    this.send(guest.id, { t: 'match', matchId, role: 'guest', opp: db.publicUser(host), cfg, ticket: guestTicket });
    console.log('match_created', matchId);
  }
}
