// Esquema SQLite do Hub (ctx.storage.sql). Migrações numeradas; a versão aplicada fica em `meta`.
// Correm sozinhas no arranque do Hub (dentro de uma transação). Nunca editar uma migração já publicada:
// acrescentar uma nova no fim do array.

// Colunas de estatísticas: chave do jogo → coluna SQL, limite máximo e agregação.
export const STATS = [
  { key: 'pointsWon', col: 'points_won', max: 5000, agg: 'SUM' },
  { key: 'pointsPlayed', col: 'points_played', max: 5000, agg: 'SUM' },
  { key: 'aces', col: 'aces', max: 1000, agg: 'SUM' },
  { key: 'doubleFaults', col: 'double_faults', max: 1000, agg: 'SUM' },
  { key: 'firstIn', col: 'first_in', max: 5000, agg: 'SUM' },
  { key: 'firstTotal', col: 'first_total', max: 5000, agg: 'SUM' },
  { key: 'firstWon', col: 'first_won', max: 5000, agg: 'SUM' },
  { key: 'secondWon', col: 'second_won', max: 5000, agg: 'SUM' },
  { key: 'secondTotal', col: 'second_total', max: 5000, agg: 'SUM' },
  { key: 'winners', col: 'winners', max: 5000, agg: 'SUM' },
  { key: 'errors', col: 'errors', max: 5000, agg: 'SUM' },
  { key: 'fastestServe', col: 'fastest_serve', max: 260, agg: 'MAX' },
  { key: 'longestRally', col: 'longest_rally', max: 500, agg: 'MAX' },
];

const statCols = STATS.map((s) => `${s.col} INTEGER NOT NULL DEFAULT 0`).join(',\n    ');

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tag TEXT NOT NULL UNIQUE,
    look INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0
  );

  -- Amizade guardada nos dois sentidos (duas linhas) para consultas simples por user_id.
  CREATE TABLE IF NOT EXISTS friends (
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    since INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS friend_requests (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests (to_id);

  -- Partida online criada quando um convite é aceite (p1 = anfitrião/quem convidou, p2 = convidado).
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    p1 TEXT NOT NULL,
    p2 TEXT NOT NULL,
    cfg TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Um relatório por jogador por jogo (game = 1, 2, 3… desforras na mesma sala).
  CREATE TABLE IF NOT EXISTS reports (
    match_id TEXT NOT NULL,
    game INTEGER NOT NULL,
    reporter TEXT NOT NULL,
    winner TEXT NOT NULL,
    score1 INTEGER NOT NULL,
    score2 INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (match_id, game, reporter)
  ) WITHOUT ROWID;

  -- Resultado do ponto de vista de cada jogador (online: 2 linhas por jogo; cpu: 1 linha).
  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    match_id TEXT NOT NULL,
    game INTEGER NOT NULL DEFAULT 1,
    client_id TEXT,
    level INTEGER,
    opp_id TEXT,
    won INTEGER NOT NULL,
    score_me INTEGER NOT NULL,
    score_opp INTEGER NOT NULL,
    status TEXT NOT NULL,
    at INTEGER NOT NULL,
    ${statCols}
  );
  CREATE UNIQUE INDEX IF NOT EXISTS results_game_user ON results (match_id, game, user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS results_cpu_client ON results (user_id, client_id) WHERE client_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS results_user_at ON results (user_id, at);
  CREATE INDEX IF NOT EXISTS results_user_opp ON results (user_id, opp_id, at);

  -- Convites pendentes (curtos: 30 s). Em SQLite para sobreviverem à hibernação do Hub.
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    cfg TEXT NOT NULL,
    exp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS invites_from ON invites (from_id);
  CREATE INDEX IF NOT EXISTS invites_to ON invites (to_id);
  CREATE INDEX IF NOT EXISTS invites_exp ON invites (exp);

  -- Limites de pedidos por janela fixa (chave = tipo + hash do IP/utilizador).
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    win INTEGER NOT NULL,
    count INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS rate_limits_win ON rate_limits (win);
  `,

  // v2 — gravações por utilizador (carreira, conquistas), resumo da carreira visível aos amigos,
  // desafio diário e Elo da escada de amigos. Os resultados online já guardados não contam para o Elo.
  `
  -- Uma gravação por utilizador e chave ('career' | 'achievements'); data = JSON (≤ 64 Ki caracteres).
  CREATE TABLE IF NOT EXISTS saves (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    rev INTEGER NOT NULL,
    data TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  ) WITHOUT ROWID;

  -- Resumo da carreira (vem com a gravação 'career'), mostrado aos amigos.
  CREATE TABLE IF NOT EXISTS careers (
    user_id TEXT PRIMARY KEY,
    rank INTEGER NOT NULL,
    best_rank INTEGER NOT NULL,
    titles INTEGER NOT NULL,
    majors INTEGER NOT NULL,
    level INTEGER NOT NULL,
    season INTEGER NOT NULL,
    name TEXT,
    at INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- Melhor pontuação de cada utilizador em cada dia (UTC, 'YYYY-MM-DD'); at = quando foi feita.
  CREATE TABLE IF NOT EXISTS daily_scores (
    day TEXT NOT NULL,
    user_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (day, user_id)
  ) WITHOUT ROWID;

  -- Elo (começa em 1000) e vitórias/derrotas online que contaram para ele.
  ALTER TABLE users ADD COLUMN elo INTEGER NOT NULL DEFAULT 1000;
  ALTER TABLE users ADD COLUMN elo_w INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN elo_l INTEGER NOT NULL DEFAULT 0;
  `,
];

export function migrate(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  const row = sql.exec("SELECT v FROM meta WHERE k = 'schema'").toArray()[0];
  let version = row ? Number(row.v) : 0;
  while (version < MIGRATIONS.length) {
    sql.exec(MIGRATIONS[version]);
    version++;
    sql.exec("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(version));
  }
}
