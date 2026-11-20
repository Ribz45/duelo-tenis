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
  sanitizeText,
  sha256Hex,
  truncateChars,
} from './util.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_FRIENDS = 200;
const MAX_OUTGOING_REQUESTS = 50;
const MAX_GAMES_PER_MATCH = 50;
const REPORT_WINDOW_MS = 24 * HOUR; // relatórios aceites até 24 h depois de a partida ser criada
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const SAVE_KEYS = ['career', 'achievements'];
const SAVE_MAX_CHARS = 65536; // JSON.stringify(data).length
// O corpo pode ter até 4 bytes UTF-8 por caractere dos dados, mais o resumo e a margem.
const SAVE_BODY_MAX_BYTES = 4 * SAVE_MAX_CHARS + 16 * 1024;
const SAVE_PUT_LIMIT = 120; // por hora e utilizador
const SUMMARY_NAME_MAX = 24;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_MAX_SCORE = 100000;
const DAILY_DETAIL_MAX = 120;
const DAILY_BOARD_MAX = 50;
const DAILY_POST_LIMIT = 60; // por hora e utilizador
const DAILY_KEEP_DAYS = 90; // dias mais antigos são apagados de vez em quando

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
    elo: me.elo,
    career: db.careerSummary(sql, me.id),
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
    elo: user.elo,
    career: db.careerSummary(sql, id),
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
      let stored = false;
      for (const [uid, opp, mine, theirs] of [
        [match.p1, match.p2, score[0], score[1]],
        [match.p2, match.p1, score[1], score[0]],
      ]) {
        const inserted = db.insertResult(sql, {
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
        stored = stored || inserted;
      }
      // Elo da escada: só aqui, quando o resultado fica guardado pela primeira vez (nunca na confirmação
      // nem na disputa). Partidas com o mesmo jogador dos dois lados são ignoradas.
      if (stored && match.p1 !== match.p2) {
        db.applyElo(sql, body.winner, body.winner === match.p1 ? match.p2 : match.p1);
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

// ---------- Gravações (carreira, conquistas) ----------

function saveKey(raw) {
  if (!SAVE_KEYS.includes(raw)) throw new HttpError(400, 'bad_key', `key must be one of: ${SAVE_KEYS.join(', ')}`);
  return raw;
}

/** Resumo da carreira: inteiros limitados, nome ≤ 24 caracteres limpo como os nomes (ausente/vazio → sem nome). */
function cleanSummary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'bad_summary', 'summary must be an object');
  }
  const s = {
    rank: clampInt(raw.rank, 1, 999, 999),
    bestRank: clampInt(raw.bestRank, 1, 999, 999),
    titles: clampInt(raw.titles, 0, 999, 0),
    majors: clampInt(raw.majors, 0, 999, 0),
    level: clampInt(raw.level, 1, 99, 1),
    season: clampInt(raw.season, 1, 99, 1),
  };
  const name = typeof raw.name === 'string' ? truncateChars(sanitizeText(raw.name.slice(0, 400)), SUMMARY_NAME_MAX) : '';
  if (name) s.name = name;
  return s;
}

async function readSave(hub, req, me, rawKey) {
  const key = saveKey(rawKey);
  const row = db.getSave(hub.sql, me.id, key);
  if (!row) throw notFound('No save for that key');
  return json({ key, rev: row.rev, data: JSON.parse(row.data), at: row.at });
}

async function writeSave(hub, req, me, rawKey) {
  const key = saveKey(rawKey);
  const sql = hub.sql;
  const now = Date.now();
  limitOrThrow(hub, 'sv:' + me.id, SAVE_PUT_LIMIT, now);
  const body = await readJson(req, SAVE_BODY_MAX_BYTES);

  if (body.data === undefined) throw new HttpError(400, 'bad_data', 'data is required (any JSON value)');
  const data = JSON.stringify(body.data);
  if (data.length > SAVE_MAX_CHARS) {
    throw new HttpError(413, 'too_large', `data must be at most ${SAVE_MAX_CHARS} characters of JSON`);
  }
  const force = body.force === true;
  if (!force && !(Number.isInteger(body.base) && body.base >= 0)) {
    throw new HttpError(400, 'bad_base', 'base must be the last rev seen (integer ≥ 0; 0 if none)');
  }
  // Só a carreira tem resumo. undefined = manter o anterior; null = apagar.
  let summary;
  if (key === 'career' && body.summary !== undefined) summary = body.summary === null ? null : cleanSummary(body.summary);

  return hub.ctx.storage.transactionSync(() => {
    const cur = db.saveMeta(sql, me.id, key);
    const stored = cur ? cur.rev : 0;
    if (!force && stored !== body.base) {
      return json(
        { error: 'conflict', message: 'The save changed on another device', rev: stored, at: cur ? cur.at : null },
        409,
      );
    }
    const rev = stored + 1;
    db.putSave(sql, me.id, key, rev, data, now);
    if (summary === null) db.deleteCareer(sql, me.id);
    else if (summary) db.setCareer(sql, me.id, summary, now);
    return json({ ok: true, rev, at: now });
  });
}

// ---------- Desafio diário ----------

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** 'YYYY-MM-DD' de uma data real, ou null. */
function validDay(raw) {
  if (typeof raw !== 'string' || !DAY_RE.test(raw)) return null;
  const t = Date.parse(raw + 'T00:00:00Z');
  return Number.isFinite(t) && utcDay(t) === raw ? raw : null;
}

async function postDaily(hub, req, me) {
  const body = await readJson(req);
  const sql = hub.sql;
  const now = Date.now();
  limitOrThrow(hub, 'dy:' + me.id, DAILY_POST_LIMIT, now);

  const day = validDay(body.day);
  if (!day || (day !== utcDay(now) && day !== utcDay(now - DAY))) {
    throw new HttpError(400, 'bad_day', "day must be today's or yesterday's UTC date (YYYY-MM-DD)");
  }
  const score = body.score;
  if (!Number.isInteger(score) || score < 0 || score > DAILY_MAX_SCORE) {
    throw new HttpError(400, 'bad_score', `score must be an integer 0–${DAILY_MAX_SCORE}`);
  }
  let detail = null;
  if (body.detail !== undefined && body.detail !== null) {
    if (typeof body.detail !== 'string') throw new HttpError(400, 'bad_detail', 'detail must be a string');
    detail = sanitizeText(body.detail);
    if ([...detail].length > DAILY_DETAIL_MAX) {
      throw new HttpError(400, 'bad_detail', `detail must be at most ${DAILY_DETAIL_MAX} characters`);
    }
    if (!detail) detail = null;
  }

  const result = hub.ctx.storage.transactionSync(() => {
    const cur = db.dailyScore(sql, day, me.id);
    // Fica a melhor pontuação; num empate mantém-se a primeira (desempate do quadro: quem chegou primeiro).
    if (cur && score <= cur.score) return { best: cur.score, improved: false };
    db.setDailyScore(sql, day, me.id, score, detail, now);
    return { best: score, improved: true };
  });
  if (Math.random() < 0.02) db.pruneDaily(sql, utcDay(now - DAILY_KEEP_DAYS * DAY));
  return json({ ok: true, ...result });
}

async function getDaily(hub, req, me, _id, url) {
  const raw = url.searchParams.get('day');
  const day = raw === null ? utcDay(Date.now()) : validDay(raw);
  if (!day) throw new HttpError(400, 'bad_day', 'day must be a date YYYY-MM-DD');
  const mine = db.dailyScore(hub.sql, day, me.id);
  return json({
    day,
    me: mine ? { score: mine.score, detail: mine.detail } : null,
    board: db.dailyBoard(hub.sql, day, me.id, DAILY_BOARD_MAX),
  });
}

// ---------- Escada de amigos (Elo) ----------

async function getLadder(hub, req, me) {
  return json({ players: db.ladder(hub.sql, me.id) });
}

async function getIce(hub) {
  return json({ iceServers: await iceServers(hub.env) });
}

// ---------- Router ----------

// [método, caminho, handler, precisa de token, validação do parâmetro (por omissão: id de utilizador)]
const anyParam = () => true; // o handler valida (ex.: chave da gravação → 400 bad_key)

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
  ['GET', /^\/api\/save\/([^/]+)$/, readSave, true, anyParam],
  ['PUT', /^\/api\/save\/([^/]+)$/, writeSave, true, anyParam],
  ['POST', /^\/api\/daily$/, postDaily, true],
  ['GET', /^\/api\/daily$/, getDaily, true],
  ['GET', /^\/api\/ladder$/, getLadder, true],
];

export async function handleApi(hub, request, url) {
  let pathMatched = false;
  for (const [method, re, handler, auth, checkParam = isId] of ROUTES) {
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
    if (param !== undefined && !checkParam(param)) throw notFound();
    return handler(hub, request, me, param, url);
  }
  if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
  throw notFound('Unknown route');
}
