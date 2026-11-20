// Relatórios de partidas: online (reported → confirmed / disputed), CPU (dedupe por clientId), recorde e h2h.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { api, befriend, createMatch, register } from './helpers.mjs';

const report = (who, body) => api('POST', '/api/matches', { token: who.token, body });
const clientId = () => randomBytes(12).toString('base64url'); // 16 chars

const statsA = {
  pointsWon: 30, pointsPlayed: 50, aces: 3, doubleFaults: 1, firstIn: 20, firstTotal: 30, firstWon: 15,
  secondWon: 5, secondTotal: 10, winners: 8, errors: 4, fastestServe: 190, longestRally: 12,
};
const statsB = { ...statsA, pointsWon: 20, aces: 1, fastestServe: 170, longestRally: 9 };

test('online report: reported → confirmed, disputed, validation, record and h2h', async () => {
  const a = await register('RepHost');
  const b = await register('RepGuest');
  const outsider = await register('Outsider');
  await befriend(a, b);
  const { host } = await createMatch(a, b);
  const matchId = host.matchId;
  const base = { mode: 'online', matchId, stats: { [a.user.id]: statsA, [b.user.id]: statsB } };

  // Jogo 1: o anfitrião ganha 6-4; os dois concordam.
  let r = await report(a, { ...base, game: 1, winner: a.user.id, score: [6, 4] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true, status: 'reported' });
  assert.equal((await report(a, { ...base, game: 1, winner: a.user.id, score: [6, 4] })).data.status, 'reported');
  r = await report(b, { ...base, game: 1, winner: a.user.id, score: [6, 4] });
  assert.deepEqual(r.data, { ok: true, status: 'confirmed' });
  assert.equal((await report(b, { ...base, game: 1, winner: a.user.id, score: [6, 4] })).data.status, 'confirmed');

  // Jogo 2: discordam → disputed, prevalece o primeiro relatório (a ganhou 7-5).
  r = await report(a, { ...base, game: 2, winner: a.user.id, score: [7, 5] });
  assert.equal(r.data.status, 'reported');
  r = await report(b, { ...base, game: 2, winner: b.user.id, score: [5, 7] });
  assert.equal(r.data.status, 'disputed');

  // Jogo 3: o convidado reporta primeiro e ganha 3-6 (score[0] é sempre o anfitrião).
  r = await report(b, { ...base, game: 3, winner: b.user.id, score: [3, 6] });
  assert.equal(r.data.status, 'reported');

  // Validação.
  assert.equal((await report(outsider, { ...base, game: 1, winner: a.user.id, score: [6, 4] })).status, 403);
  assert.equal((await report(a, { ...base, game: 4, winner: outsider.user.id, score: [6, 4] })).data.error, 'bad_winner');
  assert.equal((await report(a, { ...base, game: 0, winner: a.user.id, score: [6, 4] })).data.error, 'bad_game');
  assert.equal((await report(a, { ...base, game: 1.5, winner: a.user.id, score: [6, 4] })).status, 400);
  assert.equal((await report(a, { ...base, game: 4, winner: a.user.id, score: 6 })).data.error, 'bad_score');
  assert.equal((await report(a, { ...base, matchId: 'b'.repeat(16), game: 1, winner: a.user.id, score: [6, 4] })).status, 404);
  assert.equal((await report(a, { ...base, matchId: '../x', game: 1, winner: a.user.id, score: [6, 4] })).status, 404);
  assert.equal((await report(a, { mode: 'ranked' })).data.error, 'bad_mode');

  // Recorde do anfitrião: 2 vitórias (jogos 1 e 2), 1 derrota (jogo 3).
  const meA = (await api('GET', '/api/me', { token: a.token })).data;
  assert.deepEqual(meA.record.online, { w: 2, l: 1 });
  assert.deepEqual(meA.record.cpu, { w: 0, l: 0 });
  assert.equal(meA.record.totals.matches, 3);
  assert.equal(meA.record.totals.pointsWon, 90);
  assert.equal(meA.record.totals.aces, 9);
  assert.equal(meA.record.totals.fastestServe, 190); // máximo, não soma
  assert.equal(meA.record.totals.longestRally, 12);
  assert.deepEqual(meA.friends.find((f) => f.id === b.user.id).h2h, { w: 2, l: 1 });

  const meB = (await api('GET', '/api/me', { token: b.token })).data;
  assert.deepEqual(meB.record.online, { w: 1, l: 2 });
  assert.equal(meB.record.totals.pointsWon, 60);
  assert.equal(meB.record.totals.fastestServe, 170);
  assert.deepEqual(meB.friends.find((f) => f.id === a.user.id).h2h, { w: 1, l: 2 });

  // /api/users/:id — h2h e últimos jogos do ponto de vista de quem pergunta.
  const viewB = (await api('GET', `/api/users/${b.user.id}`, { token: a.token })).data;
  assert.deepEqual(viewB.user, b.user);
  assert.deepEqual(viewB.record.online, { w: 1, l: 2 });
  assert.deepEqual(viewB.h2h, { w: 2, l: 1 });
  assert.equal(viewB.recent.length, 3);
  const [g3, g2, g1] = viewB.recent;
  assert.deepEqual(g1, { ...g1, id: matchId, game: 1, mode: 'online', level: null, won: true, score: [6, 4], status: 'confirmed' });
  assert.deepEqual(g1.opp, b.user);
  assert.equal(typeof g1.at, 'number');
  assert.deepEqual([g2.game, g2.won, g2.score, g2.status], [2, true, [7, 5], 'disputed']);
  assert.deepEqual([g3.game, g3.won, g3.score, g3.status], [3, false, [3, 6], 'reported']);

  const viewA = (await api('GET', `/api/users/${a.user.id}`, { token: b.token })).data;
  assert.deepEqual(viewA.h2h, { w: 1, l: 2 });
  const b1 = viewA.recent.find((m) => m.game === 1);
  assert.deepEqual([b1.won, b1.score], [false, [4, 6]]);

  // Um terceiro vê os números de A mas sem confrontos.
  const viewByOutsider = (await api('GET', `/api/users/${a.user.id}`, { token: outsider.token })).data;
  assert.deepEqual(viewByOutsider.record.online, { w: 2, l: 1 });
  assert.deepEqual(viewByOutsider.h2h, { w: 0, l: 0 });
  assert.deepEqual(viewByOutsider.recent, []);
  assert.equal((await api('GET', '/api/users/zzzzzzzzzzzz', { token: a.token })).status, 404);

  // GET /api/matches
  const list = (await api('GET', `/api/matches?with=${b.user.id}&limit=2`, { token: a.token })).data.matches;
  assert.deepEqual(list.map((m) => m.game), [3, 2]);
  const all = (await api('GET', '/api/matches?limit=999', { token: a.token })).data.matches;
  assert.equal(all.length, 3);
  assert.equal((await api('GET', '/api/matches?with=nope', { token: a.token })).status, 400);
});

test('CPU report: dedupe by clientId, stats clamped', async () => {
  const p = await register('Solo');
  const id1 = clientId();
  const body = {
    mode: 'cpu', clientId: id1, level: 2, won: true, score: [10, 7],
    stats: { ...statsA, fastestServe: 999, longestRally: 9999, aces: -5, bogus: 77, winners: '6' },
  };
  assert.deepEqual((await report(p, body)).data, { ok: true, status: 'confirmed' });
  assert.deepEqual((await report(p, body)).data, { ok: true, status: 'duplicate' });
  assert.equal((await report(p, { ...body, clientId: clientId(), won: false, score: [3, 10] })).data.status, 'confirmed');
  assert.equal((await report(p, { ...body, clientId: 'short' })).data.error, 'bad_client_id');

  // O mesmo clientId de outro jogador não colide.
  const q = await register('Other');
  assert.equal((await report(q, body)).data.status, 'confirmed');

  const me = (await api('GET', '/api/me', { token: p.token })).data;
  assert.deepEqual(me.record.cpu, { w: 1, l: 1 });
  assert.deepEqual(me.record.online, { w: 0, l: 0 });
  assert.equal(me.record.totals.matches, 2);
  assert.equal(me.record.totals.fastestServe, 260);
  assert.equal(me.record.totals.longestRally, 500);
  assert.equal(me.record.totals.aces, 0);
  assert.equal(me.record.totals.winners, 12);
  assert.equal(me.record.totals.pointsWon, 60);
  assert.equal(me.record.totals.bogus, undefined);

  const list = (await api('GET', '/api/matches', { token: p.token })).data.matches;
  assert.equal(list.length, 2);
  const won = list.find((m) => m.won);
  assert.deepEqual([won.mode, won.level, won.opp, won.score, won.status], ['cpu', 2, null, [10, 7], 'confirmed']);
});
