// Endpoints HTTP /api/* (executados dentro do Hub, que é dono da base de dados).
import * as db from './store.js';
import { iceServers } from './ice.js';
import {
  HttpError,
  clampInt,
  cleanLook,
  cleanName,
  envInt,
  hmacB64url,
  isId,
  isMatchId,
  json,
  linkKeyFor,
  newId,
  newTag,
  newToken,
  normalizeTag,
  readJson,
  requireSecret,
  safeEqual,
  sha256Hex,
} from './util.js';

const HOUR = 60 * 60 * 1000;
const MAX_FRIENDS = 200;
const MAX_OUTGOING_REQUESTS = 50;
const MAX_GAMES_PER_MATCH = 50;
const REPORT_WINDOW_MS = 24 * HOUR; // relatórios aceites até 24 h depois de a partida ser criada
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);

function limitOrThrow(hub, key, limit, now) {
  if (!db.rateLimit(hub.sql, key, limit, HOUR, now)) {
    throw new HttpError(429, 'rate_limited', 'Too many requests, try again later');
  }
}

/** [a, b] inteiros 0–99; tem de ser um array de 2. */
function cleanScore(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) throw new HttpError(400, 'bad_score', 'score must be [a, b]');
  return [clampInt(raw[0], 0, 99, 0), clampInt(raw[1], 0, 99, 0)];
}

// ---------- Conta ----------

async function register(hub, req) {
  const body = await readJson(req);
  const name = cleanName(body.name);
  const look = cleanLook(body.look);
  const secret = requireSecret(hub.env);
  const now = Date.now();

  // 20/h por IP (o IP nunca é guardado: só um HMAC dele). REGISTER_LIMIT só existe para os testes locais.
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const limit = envInt(hub.env, 'REGISTER_LIMIT', 20, 1, 100000);
  limitOrThrow(hub, 'reg:' + (await hmacB64url(secret, 'ip:' + ip)).slice(0, 22), limit, now);
  if (Math.random() < 0.05) db.pruneRateLimits(hub.sql, now - 2 * HOUR);

  const token = newToken();
  const tokenHash = await sha256Hex(token);
  const id = newId();
  let tag = newTag();
  for (let i = 0; i < 20 && db.tagExists(hub.sql, tag); i++) tag = newTag();
  if (db.tagExists(hub.sql, tag)) throw new HttpError(503, 'try_again', 'Could not allocate a friend code');

  db.insertUser(hub.sql, { id, tokenHash, name, tag, look, now });
  console.log('register', id);
  return json({ token, user: { id, name, tag, look }, linkKey: await linkKeyFor(secret, tag) });
}

async function getMe(hub, req, me) {
  const sql = hub.sql;
  return json({
    user: db.publicUser(me),
    linkKey: await linkKeyFor(requireSecret(hub.env), me.tag),
    record: db.record(sql, me.id),
    friends: hub.friendsOf(me.id),
    requests: { incoming: db.incomingRequests(sql, me.id), outgoing: db.outgoingRequests(sql, me.id) },
  });
}

async function patchMe(hub, req, me) {
  const body = await readJson(req);
  const changes = {};
  if (body.name !== undefined) changes.name = cleanName(body.name);
  if (body.look !== undefined) changes.look = cleanLook(body.look);
  db.updateUser(hub.sql, me.id, changes);
  return json({ user: db.publicUser(db.userById(hub.sql, me.id)) });
}

// ---------- Amigos ----------

function makeFriends(hub, me, other) {
  const sql = hub.sql;
  if (db.countFriends(sql, me.id) >= MAX_FRIENDS || db.countFriends(sql, other.id) >= MAX_FRIENDS) {
    throw new HttpError(409, 'friend_limit', `Friend list is full (max ${MAX_FRIENDS})`);
  }
  db.addFriendship(sql, me.id, other.id, Date.now());
  // Avisa os dois lados (todas as abas abertas).
  hub.send(other.id, { t: 'friend-added', friend: hub.friendView(other.id, me) });
  const mine = hub.friendView(me.id, other);
  hub.send(me.id, { t: 'friend-added', friend: mine });
  return mine;
}

async function postFriend(hub, req, me) {
  const body = await readJson(req);
  const sql = hub.sql;
  const tag = normalizeTag(body.tag);
  if (!tag) throw notFound('No player with that code');
  limitOrThrow(hub, 'fr:' + me.id, 60, Date.now());

  const other = db.userByTag(sql, tag);
  if (!other) throw notFound('No player with that code');
  if (other.id === me.id) throw new HttpError(400, 'self', 'That is your own code');
  const user = db.publicUser(other);
  if (db.areFriends(sql, me.id, other.id)) return json({ status: 'already', user });

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const keyOk = key.length > 0 && safeEqual(key, await linkKeyFor(requireSecret(hub.env), other.tag));
  if (keyOk || db.hasRequest(sql, other.id, me.id)) {
    makeFriends(hub, me, other);
    return json({ status: 'friends', user });
  }

  if (!db.hasRequest(sql, me.id, other.id)) {
    if (db.countOutgoing(sql, me.id) >= MAX_OUTGOING_REQUESTS) {
      throw new HttpError(409, 'request_limit', 'Too many pending friend requests');
    }
    db.addRequest(sql, me.id, other.id, Date.now());
    hub.send(other.id, { t: 'friend-request', from: db.publicUser(me) });
  }
  return json({ status: 'requested', user });
}

async function acceptFriend(hub, req, me, id) {
  if (!db.hasRequest(hub.sql, id, me.id)) throw notFound('No pending request from that player');
  const other = db.userById(hub.sql, id);
  if (!other) throw notFound();
  return json({ friend: makeFriends(hub, me, other) });
}

async function deleteFriend(hub, req, me, id) {
  const removed = db.removeRelation(hub.sql, me.id, id);
  hub.cancelInvitesBetween(me.id, id);
  if (removed.friendship || removed.request) {
    hub.send(id, { t: 'friend-removed', id: me.id });
    hub.send(me.id, { t: 'friend-removed', id });
  }
  return json({ ok: true });
}

// ---------- Utilizadores e partidas ----------

async function getUser(hub, req, me, id) {
  const sql = hub.sql;
  const user = db.userById(sql, id);
  if (!user) throw notFound('No such player');
  return json({
    user: db.publicUser(user),
    record: db.record(sql, id),
    h2h: db.h2h(sql, me.id, id),
    recent: db.listMatches(sql, me.id, id, 10),
  });
}

async function getMatches(hub, req, me, _id, url) {
  const withId = url.searchParams.get('with');
  if (withId !== null && !isId(withId)) throw new HttpError(400, 'bad_request', 'Invalid "with" id');
  const limit = clampInt(url.searchParams.get('limit'), 1, 50, 20);
  return json({ matches: db.listMatches(hub.sql, me.id, withId, limit) });
}

function reportOnline(hub, me, body, now) {
  const sql = hub.sql;
  if (!isMatchId(body.matchId)) throw notFound('Unknown match');
  if (!Number.isInteger(body.game) || body.game < 1 || body.game > MAX_GAMES_PER_MATCH) {
    throw new HttpError(400, 'bad_game', `game must be an integer 1–${MAX_GAMES_PER_MATCH}`);
  }
  const match = sql.exec('SELECT id, p1, p2, created_at FROM matches WHERE id = ?', body.matchId).toArray()[0];
  if (!match) throw notFound('Unknown match');
  if (me.id !== match.p1 && me.id !== match.p2) throw new HttpError(403, 'forbidden', 'You did not play this match');
  if (body.winner !== match.p1 && body.winner !== match.p2) {
    throw new HttpError(400, 'bad_winner', 'winner must be one of the two players');
  }
  if (now - match.created_at > REPORT_WINDOW_MS) throw new HttpError(403, 'match_closed', 'Match is too old to report');
  const score = cleanScore(body.score);
  const stats = body.stats && typeof body.stats === 'object' ? body.stats : {};

  return hub.ctx.storage.transactionSync(() => {
    const reports = sql
      .exec('SELECT reporter, winner FROM reports WHERE match_id = ? AND game = ?', match.id, body.game)
      .toArray();
    if (reports.some((r) => r.reporter === me.id)) {
      // Repetição do mesmo jogador: idempotente, devolve o estado atual.
      const row = sql
        .exec('SELECT status FROM results WHERE match_id = ? AND game = ? AND user_id = ?', match.id, body.game, me.id)
        .toArray()[0];
      return row ? row.status : 'reported';
    }
    sql.exec(
      'INSERT INTO reports (match_id, game, reporter, winner, score1, score2, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      match.id,
      body.game,
      me.id,
      body.winner,
      score[0],
      score[1],
      now,
    );
    const firstReport = reports[0];
    if (!firstReport) {
      // Primeiro relatório: guarda o resultado para os dois jogadores (score[0] = p1/anfitrião).
      for (const [uid, opp, mine, theirs] of [
        [match.p1, match.p2, score[0], score[1]],
        [match.p2, match.p1, score[1], score[0]],
      ]) {
        db.insertResult(sql, {
          userId: uid,
          mode: 'online',
          matchId: match.id,
          game: body.game,
          oppId: opp,
          won: body.winner === uid,
          scoreMe: mine,
          scoreOpp: theirs,
          status: 'reported',
          at: now,
          stats: db.cleanStats(stats[uid]),
        });
      }
      return 'reported';
    }
    // Segundo relatório: confirma ou marca como disputado (o primeiro prevalece).
    const status = firstReport.winner === body.winner ? 'confirmed' : 'disputed';
    sql.exec('UPDATE results SET status = ? WHERE match_id = ? AND game = ?', status, match.id, body.game);
    if (status === 'disputed') console.log('match_disputed', match.id, body.game);
    return status;
  });
}

function reportCpu(hub, me, body, now) {
  if (typeof body.clientId !== 'string' || !CLIENT_ID_RE.test(body.clientId)) {
    throw new HttpError(400, 'bad_client_id', 'clientId must be 16–64 chars [A-Za-z0-9_-]');
  }
  const score = cleanScore(body.score);
  const inserted = db.insertResult(hub.sql, {
    userId: me.id,
    mode: 'cpu',
    matchId: newId(16),
    game: 1,
    clientId: body.clientId,
    level: clampInt(body.level, 0, 20, 1),
    oppId: null,
    won: body.won === true,
    scoreMe: score[0],
    scoreOpp: score[1],
    status: 'confirmed',
    at: now,
    stats: db.cleanStats(body.stats),
  });
  return inserted ? 'confirmed' : 'duplicate';
}

async function postMatch(hub, req, me) {
  const body = await readJson(req);
  const now = Date.now();
  if (body.mode !== 'online' && body.mode !== 'cpu') throw new HttpError(400, 'bad_mode', 'mode must be online or cpu');
  limitOrThrow(hub, 'mr:' + me.id, 300, now);
  const status = body.mode === 'online' ? reportOnline(hub, me, body, now) : reportCpu(hub, me, body, now);
  return json({ ok: true, status });
}

async function getIce(hub) {
  return json({ iceServers: await iceServers(hub.env) });
}

// ---------- Router ----------

const ROUTES = [
  ['POST', /^\/api\/register$/, register, false],
  ['GET', /^\/api\/me$/, getMe, true],
  ['PATCH', /^\/api\/me$/, patchMe, true],
  ['POST', /^\/api\/friends$/, postFriend, true],
  ['POST', /^\/api\/friends\/([^/]+)\/accept$/, acceptFriend, true],
  ['DELETE', /^\/api\/friends\/([^/]+)$/, deleteFriend, true],
  ['GET', /^\/api\/users\/([^/]+)$/, getUser, true],
  ['POST', /^\/api\/matches$/, postMatch, true],
  ['GET', /^\/api\/matches$/, getMatches, true],
  ['GET', /^\/api\/ice$/, getIce, true],
];

export async function handleApi(hub, request, url) {
  let pathMatched = false;
  for (const [method, re, handler, auth] of ROUTES) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (method !== request.method) continue;

    let me = null;
    if (auth) {
      const header = request.headers.get('Authorization') || '';
      const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
      me = token ? await hub.authUser(token) : null;
      if (!me) throw new HttpError(401, 'unauthorized', 'Missing or invalid token');
    }
    const param = m[1];
    if (param !== undefined && !isId(param)) throw notFound();
    return handler(hub, request, me, param, url);
  }
  if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
  throw notFound('Unknown route');
}
