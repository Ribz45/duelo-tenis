// Acesso a dados do Hub (SQL sempre parametrizado). Todas as funções são síncronas (ctx.storage.sql).
import { STATS } from './schema.js';
import { clampInt } from './util.js';

const first = (cursor) => cursor.toArray()[0] || null;

// ---------- Utilizadores ----------

export const publicUser = (row) => (row ? { id: row.id, name: row.name, tag: row.tag, look: row.look } : null);

const USER_COLS = 'id, name, tag, look, last_seen';

export const userById = (sql, id) => first(sql.exec(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id));
export const userByTag = (sql, tag) => first(sql.exec(`SELECT ${USER_COLS} FROM users WHERE tag = ?`, tag));
export const userByTokenHash = (sql, hash) =>
  first(sql.exec(`SELECT ${USER_COLS} FROM users WHERE token_hash = ?`, hash));

export function insertUser(sql, u) {
  sql.exec(
    'INSERT INTO users (id, token_hash, name, tag, look, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
    u.id,
    u.tokenHash,
    u.name,
    u.tag,
    u.look,
    u.now,
    u.now,
  );
}

export const tagExists = (sql, tag) => !!first(sql.exec('SELECT 1 AS x FROM users WHERE tag = ?', tag));

export function updateUser(sql, id, { name, look }) {
  if (name !== undefined) sql.exec('UPDATE users SET name = ? WHERE id = ?', name, id);
  if (look !== undefined) sql.exec('UPDATE users SET look = ? WHERE id = ?', look, id);
}

export const touchLastSeen = (sql, id, now) => sql.exec('UPDATE users SET last_seen = ? WHERE id = ?', now, id);

// ---------- Amizades e pedidos ----------

export const areFriends = (sql, a, b) =>
  !!first(sql.exec('SELECT 1 AS x FROM friends WHERE user_id = ? AND friend_id = ?', a, b));

export function addFriendship(sql, a, b, now) {
  sql.exec('INSERT OR IGNORE INTO friends (user_id, friend_id, since) VALUES (?, ?, ?), (?, ?, ?)', a, b, now, b, a, now);
  deleteRequests(sql, a, b);
}

/** Remove amizade e pedidos nos dois sentidos. Devolve { friendship, request } (o que existia). */
export function removeRelation(sql, a, b) {
  const f = sql.exec('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', a, b, b, a);
  const r = deleteRequests(sql, a, b);
  return { friendship: f.rowsWritten > 0, request: r > 0 };
}

export const hasRequest = (sql, from, to) =>
  !!first(sql.exec('SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ?', from, to));

export const addRequest = (sql, from, to, now) =>
  sql.exec('INSERT OR IGNORE INTO friend_requests (from_id, to_id, at) VALUES (?, ?, ?)', from, to, now);

export function deleteRequests(sql, a, b) {
  return sql.exec(
    'DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
    a,
    b,
    b,
    a,
  ).rowsWritten;
}

export const countFriends = (sql, id) => first(sql.exec('SELECT COUNT(*) AS n FROM friends WHERE user_id = ?', id)).n;
export const countOutgoing = (sql, id) =>
  first(sql.exec('SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?', id)).n;
export const countIncoming = (sql, id) =>
  first(sql.exec('SELECT COUNT(*) AS n FROM friend_requests WHERE to_id = ?', id)).n;

export const friendIds = (sql, id) =>
  sql.exec('SELECT friend_id FROM friends WHERE user_id = ?', id).toArray().map((r) => r.friend_id);

export const friendRows = (sql, id) =>
  sql
    .exec(
      `SELECT u.id, u.name, u.tag, u.look, u.last_seen FROM friends f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ? ORDER BY u.name COLLATE NOCASE`,
      id,
    )
    .toArray();

export const incomingRequests = (sql, id) =>
  sql
    .exec(
      `SELECT u.id, u.name, u.tag, u.look FROM friend_requests r JOIN users u ON u.id = r.from_id
       WHERE r.to_id = ? ORDER BY r.at DESC`,
      id,
    )
    .toArray()
    .map(publicUser);

export const outgoingRequests = (sql, id) =>
  sql
    .exec(
      `SELECT u.id, u.name, u.tag, u.look FROM friend_requests r JOIN users u ON u.id = r.to_id
       WHERE r.from_id = ? ORDER BY r.at DESC`,
      id,
    )
    .toArray()
    .map(publicUser);

// ---------- Resultados, recorde e confrontos diretos ----------

/** Limpa as estatísticas de um jogador: só chaves conhecidas, inteiros ≥ 0 com teto. */
export function cleanStats(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const s of STATS) out[s.key] = clampInt(src[s.key], 0, s.max, 0);
  return out;
}

export function insertResult(sql, r) {
  const cols = ['user_id', 'mode', 'match_id', 'game', 'client_id', 'level', 'opp_id', 'won', 'score_me', 'score_opp', 'status', 'at'];
  const vals = [r.userId, r.mode, r.matchId, r.game, r.clientId ?? null, r.level ?? null, r.oppId ?? null, r.won ? 1 : 0, r.scoreMe, r.scoreOpp, r.status, r.at];
  for (const s of STATS) {
    cols.push(s.col);
    vals.push(r.stats[s.key]);
  }
  const cur = sql.exec(
    `INSERT OR IGNORE INTO results (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...vals,
  );
  return cur.rowsWritten > 0;
}

const RECORD_SQL = `SELECT
    COALESCE(SUM(mode = 'online' AND won = 1), 0) AS ow,
    COALESCE(SUM(mode = 'online' AND won = 0), 0) AS ol,
    COALESCE(SUM(mode = 'cpu' AND won = 1), 0) AS cw,
    COALESCE(SUM(mode = 'cpu' AND won = 0), 0) AS cl,
    COUNT(*) AS matches,
    ${STATS.map((s) => `COALESCE(${s.agg}(${s.col}), 0) AS ${s.col}`).join(',\n    ')}
  FROM results WHERE user_id = ?`;

export function record(sql, userId) {
  const r = first(sql.exec(RECORD_SQL, userId));
  const totals = { matches: r.matches };
  for (const s of STATS) totals[s.key] = r[s.col];
  return { online: { w: r.ow, l: r.ol }, cpu: { w: r.cw, l: r.cl }, totals };
}

export function h2h(sql, userId, oppId) {
  const r = first(
    sql.exec(
      `SELECT COALESCE(SUM(won = 1), 0) AS w, COALESCE(SUM(won = 0), 0) AS l
       FROM results WHERE user_id = ? AND opp_id = ? AND mode = 'online'`,
      userId,
      oppId,
    ),
  );
  return { w: r.w, l: r.l };
}

/** Mapa oppId → { w, l } com todos os confrontos online do utilizador. */
export function h2hAll(sql, userId) {
  const map = new Map();
  const rows = sql.exec(
    `SELECT opp_id, COALESCE(SUM(won = 1), 0) AS w, COALESCE(SUM(won = 0), 0) AS l
     FROM results WHERE user_id = ? AND mode = 'online' GROUP BY opp_id`,
    userId,
  );
  for (const r of rows) map.set(r.opp_id, { w: r.w, l: r.l });
  return map;
}

/** Últimos jogos do utilizador (opcionalmente só contra `withId`), do mais recente para o mais antigo. */
export function listMatches(sql, userId, withId, limit) {
  const base = `SELECT r.match_id, r.game, r.mode, r.level, r.won, r.score_me, r.score_opp, r.status, r.at,
      o.id AS o_id, o.name AS o_name, o.tag AS o_tag, o.look AS o_look
    FROM results r LEFT JOIN users o ON o.id = r.opp_id WHERE r.user_id = ?`;
  const rows = withId
    ? sql.exec(`${base} AND r.opp_id = ? ORDER BY r.at DESC, r.id DESC LIMIT ?`, userId, withId, limit)
    : sql.exec(`${base} ORDER BY r.at DESC, r.id DESC LIMIT ?`, userId, limit);
  return rows.toArray().map((r) => ({
    id: r.match_id,
    game: r.game,
    mode: r.mode,
    level: r.level,
    opp: r.o_id ? { id: r.o_id, name: r.o_name, tag: r.o_tag, look: r.o_look } : null,
    won: r.won === 1,
    score: [r.score_me, r.score_opp],
    status: r.status,
    at: r.at,
  }));
}

// ---------- Limites de pedidos (janela fixa) ----------

/** Conta um pedido e devolve true se ainda estiver dentro do limite. */
export function rateLimit(sql, key, limit, windowMs, now) {
  const win = Math.floor(now / windowMs) * windowMs; // início da janela (ms)
  const row = first(
    sql.exec(
      `INSERT INTO rate_limits (key, win, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.win = excluded.win THEN rate_limits.count + 1 ELSE 1 END,
         win = excluded.win
       RETURNING count`,
      key,
      win,
    ),
  );
  return row.count <= limit;
}

/** Limpeza ocasional de janelas que começaram antes de `olderThanMs` (já não contam). */
export const pruneRateLimits = (sql, olderThanMs) => sql.exec('DELETE FROM rate_limits WHERE win < ?', olderThanMs);
