// Acesso a dados do Hub (SQL sempre parametrizado). Todas as funções são síncronas (ctx.storage.sql).
import { STATS } from './schema.js';
import { clampInt } from './util.js';

const first = (cursor) => cursor.toArray()[0] || null;

// ---------- Utilizadores ----------

export const publicUser = (row) => (row ? { id: row.id, name: row.name, tag: row.tag, look: row.look } : null);

const USER_COLS = 'id, name, tag, look, last_seen, elo';

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

// ---------- Resumo da carreira (visível aos amigos) ----------

// Colunas de `careers c` com prefixo, para juntar a outras consultas (LEFT JOIN → c_uid NULL se não houver).
const CAREER_SELECT = `c.user_id AS c_uid, c.rank AS c_rank, c.best_rank AS c_best, c.titles AS c_titles,
  c.majors AS c_majors, c.level AS c_level, c.season AS c_season, c.name AS c_name`;

/** { rank, bestRank, titles, majors, level, season, name? } ou null. */
function careerFromRow(r) {
  if (!r || r.c_uid === null || r.c_uid === undefined) return null;
  const s = {
    rank: r.c_rank,
    bestRank: r.c_best,
    titles: r.c_titles,
    majors: r.c_majors,
    level: r.c_level,
    season: r.c_season,
  };
  if (r.c_name) s.name = r.c_name;
  return s;
}

export const careerSummary = (sql, userId) =>
  careerFromRow(first(sql.exec(`SELECT ${CAREER_SELECT} FROM careers c WHERE c.user_id = ?`, userId)));

export function setCareer(sql, userId, s, now) {
  sql.exec(
    `INSERT INTO careers (user_id, rank, best_rank, titles, majors, level, season, name, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET rank = excluded.rank, best_rank = excluded.best_rank,
       titles = excluded.titles, majors = excluded.majors, level = excluded.level, season = excluded.season,
       name = excluded.name, at = excluded.at`,
    userId,
    s.rank,
    s.bestRank,
    s.titles,
    s.majors,
    s.level,
    s.season,
    s.name ?? null,
    now,
  );
}

export const deleteCareer = (sql, userId) => sql.exec('DELETE FROM careers WHERE user_id = ?', userId);

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

/** Amigos com o resumo da carreira já junto (`row.career`, ou null) e o Elo (`row.elo`). */
export const friendRows = (sql, id) =>
  sql
    .exec(
      `SELECT u.id, u.name, u.tag, u.look, u.last_seen, u.elo, ${CAREER_SELECT}
       FROM friends f JOIN users u ON u.id = f.friend_id LEFT JOIN careers c ON c.user_id = u.id
       WHERE f.user_id = ? ORDER BY u.name COLLATE NOCASE`,
      id,
    )
    .toArray()
    .map((r) => ({ ...r, career: careerFromRow(r) }));

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

// ---------- Elo (escada de amigos) ----------

export const ELO_K = 32;

/** Novo rating de A depois de um jogo contra B (scoreA: 1 vitória, 0 derrota), arredondado. */
export function eloAfter(ra, rb, scoreA) {
  const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
  return Math.round(ra + ELO_K * (scoreA - expected));
}

/** Aplica um resultado online ao Elo e às vitórias/derrotas da escada. Ignora jogos inválidos. */
export function applyElo(sql, winnerId, loserId) {
  if (!winnerId || !loserId || winnerId === loserId) return false;
  const w = first(sql.exec('SELECT elo FROM users WHERE id = ?', winnerId));
  const l = first(sql.exec('SELECT elo FROM users WHERE id = ?', loserId));
  if (!w || !l) return false;
  sql.exec('UPDATE users SET elo = ?, elo_w = elo_w + 1 WHERE id = ?', eloAfter(w.elo, l.elo, 1), winnerId);
  sql.exec('UPDATE users SET elo = ?, elo_l = elo_l + 1 WHERE id = ?', eloAfter(l.elo, w.elo, 0), loserId);
  return true;
}

/** Eu + amigos aceites, por Elo (desc). */
export function ladder(sql, userId) {
  return sql
    .exec(
      `SELECT id, name, tag, look, elo, elo_w, elo_l FROM users
       WHERE id = ? OR id IN (SELECT friend_id FROM friends WHERE user_id = ?)
       ORDER BY elo DESC, elo_w DESC, name COLLATE NOCASE, id`,
      userId,
      userId,
    )
    .toArray()
    .map((r) => ({ user: publicUser(r), elo: r.elo, w: r.elo_w, l: r.elo_l, me: r.id === userId }));
}

// ---------- Gravações por utilizador ----------

export const getSave = (sql, userId, key) =>
  first(sql.exec('SELECT rev, data, at FROM saves WHERE user_id = ? AND key = ?', userId, key));

export const saveMeta = (sql, userId, key) =>
  first(sql.exec('SELECT rev, at FROM saves WHERE user_id = ? AND key = ?', userId, key));

export function putSave(sql, userId, key, rev, data, at) {
  sql.exec(
    `INSERT INTO saves (user_id, key, rev, data, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET rev = excluded.rev, data = excluded.data, at = excluded.at`,
    userId,
    key,
    rev,
    data,
    at,
  );
}

// ---------- Desafio diário ----------

export const dailyScore = (sql, day, userId) =>
  first(sql.exec('SELECT score, detail, at FROM daily_scores WHERE day = ? AND user_id = ?', day, userId));

export function setDailyScore(sql, day, userId, score, detail, at) {
  sql.exec(
    `INSERT INTO daily_scores (day, user_id, score, detail, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, user_id) DO UPDATE SET score = excluded.score, detail = excluded.detail, at = excluded.at`,
    day,
    userId,
    score,
    detail,
    at,
  );
}

/** Eu + amigos aceites com pontuação nesse dia: pontuação desc, depois quem a fez primeiro. */
export function dailyBoard(sql, day, userId, limit) {
  return sql
    .exec(
      `SELECT u.id, u.name, u.tag, u.look, d.score, d.detail FROM daily_scores d JOIN users u ON u.id = d.user_id
       WHERE d.day = ? AND (d.user_id = ? OR d.user_id IN (SELECT friend_id FROM friends WHERE user_id = ?))
       ORDER BY d.score DESC, d.at ASC, d.user_id LIMIT ?`,
      day,
      userId,
      userId,
      limit,
    )
    .toArray()
    .map((r) => ({ user: publicUser(r), score: r.score, detail: r.detail, me: r.id === userId }));
}

/** Limpeza ocasional de dias antigos (`beforeDay` em 'YYYY-MM-DD'; a ordem das strings é a das datas). */
export const pruneDaily = (sql, beforeDay) => sql.exec('DELETE FROM daily_scores WHERE day < ?', beforeDay);

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
