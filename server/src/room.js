// Room: uma instância por partida online. Relay puro entre os dois jogadores (jogo + sinalização WebRTC).
// Não guarda nada durável. Estado por socket em serializeAttachment → sobrevive à hibernação.
import { DurableObject } from 'cloudflare:workers';
import { HttpError, isMatchId, jsonError, newId, requireSecret, verifyTicket } from './util.js';

const MAX_FRAME_BYTES = 16 * 1024;
const MAX_FRAMES_PER_SEC = 80;
const SYSTEM_FRAME_RE = /^\s*\{\s*"\$"/; // frames "$" só podem vir do servidor
const enc = new TextEncoder();

/**
 * Recusa com um código de fecho visível pelo jogo: um browser não vê o status HTTP de um upgrade falhado
 * (só 1006), por isso aceitamos e fechamos logo com 4003 ("bilhete inválido/expirado" → não voltar a tentar).
 */
function refuse(code, reason) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

function frameBytes(msg) {
  if (typeof msg !== 'string') return msg.byteLength;
  if (msg.length * 3 <= MAX_FRAME_BYTES) return msg.length; // garantidamente abaixo do limite
  return enc.encode(msg).length;
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Contadores de frames/s em memória: se o objeto hibernar, recomeçam do zero (inofensivo).
    this.rate = new WeakMap();
  }

  /** Sockets ativos (não substituídos) com o respetivo attachment. */
  members() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && !att.replaced) out.push({ ws, att });
    }
    return out;
  }

  sendToOthers(uid, text) {
    for (const { ws, att } of this.members()) {
      if (att.uid === uid) continue;
      try {
        ws.send(text);
      } catch {
        /* socket a fechar */
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const matchId = url.pathname.split('/').pop();
    if (!isMatchId(matchId)) return jsonError(400, 'bad_match', 'Invalid matchId');
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return jsonError(426, 'upgrade_required', 'Expected a WebSocket upgrade');
    }

    let secret;
    try {
      secret = requireSecret(this.env);
    } catch (e) {
      if (e instanceof HttpError) return jsonError(e.status, e.code, e.message);
      throw e;
    }
    const uid = await verifyTicket(secret, url.searchParams.get('ticket'), matchId);
    if (!uid) return refuse(4003, 'bad ticket');

    const mine = [];
    const others = new Set();
    for (const { ws, att } of this.members()) {
      if (att.uid === uid) mine.push({ ws, att });
      else others.add(att.uid);
    }
    if (others.size >= 2) return refuse(4003, 'room full');

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid, sid: newId(8), at: Date.now() });

    // Reconexão do mesmo jogador: o socket antigo é marcado e fechado (não gera "$leave").
    for (const { ws, att } of mine) {
      ws.serializeAttachment({ ...att, replaced: true });
      try {
        ws.close(4000, 'replaced');
      } catch {
        /* já fechado */
      }
    }

    server.send(JSON.stringify({ $: 'room', you: uid, peers: [...others] }));
    this.sendToOthers(uid, JSON.stringify({ $: 'join', id: uid }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    if (!att || att.replaced) return;
    if (frameBytes(message) > MAX_FRAME_BYTES) return;

    const sec = Math.floor(Date.now() / 1000);
    let r = this.rate.get(ws);
    if (!r || r.sec !== sec) this.rate.set(ws, (r = { sec, n: 0 }));
    if (++r.n > MAX_FRAMES_PER_SEC) return;

    if (typeof message === 'string' && SYSTEM_FRAME_RE.test(message)) return;
    this.sendToOthers(att.uid, message); // verbatim
  }

  async webSocketClose(ws, code) {
    const replacedByUs = ws.deserializeAttachment()?.replaced; // fomos nós que o fechámos (reconexão)
    this.left(ws);
    if (replacedByUs) return;
    try {
      // Completa o fecho pedido pelo cliente (1005/1006 não podem ser reenviados).
      ws.close(code >= 3000 && code <= 4999 ? code : 1000, 'bye');
    } catch {
      /* já fechado */
    }
  }

  async webSocketError(ws) {
    this.left(ws);
  }

  left(ws) {
    const att = ws.deserializeAttachment();
    if (!att || att.replaced) return;
    try {
      ws.serializeAttachment({ ...att, replaced: true }); // não voltar a anunciar a saída
    } catch {
      /* socket já fechado: a exclusão por sid abaixo chega */
    }
    const stillHere = this.members().some(({ att: a }) => a.uid === att.uid && a.sid !== att.sid);
    if (!stillHere) this.sendToOthers(att.uid, JSON.stringify({ $: 'leave', id: att.uid }));
  }
}
