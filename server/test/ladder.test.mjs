// Escada de amigos: Elo (K = 32) aplicado só quando o resultado online é guardado pela primeira vez,
// nunca na confirmação, na repetição nem na disputa; ordem por Elo; vitórias/derrotas; amigos apenas.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { api, befriend, createMatch, register } from './helpers.mjs';

const report = (who, body) => api('POST', '/api/matches', { token: who.token, body });
const ladder = async (who) => {
  const r = await api('GET', '/api/ladder', { token: who.token });
  assert.equal(r.status, 200);
  return r.data.players;
};
const me = async (who) => (await api('GET', '/api/me', { token: who.token })).data;
const row = (p) => [p.user.id, p.elo, p.w, p.l, p.me];

test('ladder: Elo once per online game, ordering, w/l, friends only', async () => {
  const a = await register('EloA');
  const b = await register('EloB');
  const c = await register('EloC');
  const stranger = await register('EloX');
  await befriend(a, b);
  await befriend(a, c);

  // Toda a gente começa com 1000 e 0-0.
  let players = await ladder(a);
  assert.equal(players.length, 3);
  for (const p of players) assert.deepEqual([p.elo, p.w, p.l], [1000, 0, 0]);
  assert.deepEqual(players.find((p) => p.me).user, a.user);
  assert.equal(players.filter((p) => p.me).length, 1);
  assert.deepEqual(Object.keys(players[0]).sort(), ['elo', 'l', 'me', 'user', 'w']);

  const { host } = await createMatch(a, b);
  const base = { mode: 'online', matchId: host.matchId, stats: {} };

  // Jogo 1: A (anfitrião) ganha. O primeiro relatório aplica o Elo: 1016 / 984.
  const g1 = { ...base, game: 1, winner: a.user.id, score: [6, 3] };
  assert.equal((await report(a, g1)).data.status, 'reported');
  assert.equal((await me(a)).elo, 1016);
  assert.equal((await me(b)).elo, 984);
  // A confirmação de B e as repetições não voltam a aplicar.
  assert.equal((await report(b, g1)).data.status, 'confirmed');
  assert.equal((await report(a, g1)).data.status, 'confirmed');
  assert.equal((await report(b, g1)).data.status, 'confirmed');
  const meA = await me(a);
  assert.equal(meA.elo, 1016);
  assert.equal(meA.friends.find((f) => f.id === b.user.id).elo, 984);
  assert.equal(meA.friends.find((f) => f.id === c.user.id).elo, 1000);
  assert.equal((await me(b)).elo, 984);

  players = await ladder(a);
  assert.deepEqual(players.map(row), [
    [a.user.id, 1016, 1, 0, true],
    [c.user.id, 1000, 0, 0, false],
    [b.user.id, 984, 0, 1, false],
  ]);
  assert.deepEqual(players[0].user, a.user);
  // A escada de B: B + os amigos de B (só A).
  assert.deepEqual((await ladder(b)).map(row), [
    [a.user.id, 1016, 1, 0, false],
    [b.user.id, 984, 0, 1, true],
  ]);

  // Jogo 2: B reporta primeiro que ganhou; A discorda → disputed, conta só o primeiro relatório.
  // Elo: B 984 vs A 1016 → B 1001, A 999 (esperado de B = 1/(1+10^(32/400)) ≈ 0.4541).
  assert.equal((await report(b, { ...base, game: 2, winner: b.user.id, score: [4, 6] })).data.status, 'reported');
  assert.equal((await report(a, { ...base, game: 2, winner: a.user.id, score: [6, 4] })).data.status, 'disputed');
  assert.deepEqual((await ladder(a)).map(row), [
    [b.user.id, 1001, 1, 1, false],
    [c.user.id, 1000, 0, 0, false],
    [a.user.id, 999, 1, 1, true],
  ]);
  // O recorde online (calculado dos resultados) bate certo: também conta o primeiro relatório.
  assert.deepEqual((await me(a)).record.online, { w: 1, l: 1 });

  // Relatórios recusados (quem não jogou, vencedor inválido) não mexem no Elo.
  assert.equal((await report(stranger, { ...base, game: 3, winner: a.user.id, score: [6, 0] })).status, 403);
  assert.equal((await report(a, { ...base, game: 3, winner: stranger.user.id, score: [6, 0] })).status, 400);
  // Jogos contra o CPU também não.
  const cpu = { mode: 'cpu', clientId: randomBytes(12).toString('base64url'), level: 3, won: true, score: [10, 2], stats: {} };
  assert.equal((await report(c, cpu)).data.status, 'confirmed');

  const final = await ladder(a);
  assert.deepEqual(final.map(row), [
    [b.user.id, 1001, 1, 1, false],
    [c.user.id, 1000, 0, 0, false],
    [a.user.id, 999, 1, 1, true],
  ]);
  // Quem não é amigo não aparece; sem amigos, a escada sou só eu.
  assert.ok(!final.some((p) => p.user.id === stranger.user.id));
  assert.deepEqual((await ladder(stranger)).map(row), [[stranger.user.id, 1000, 0, 0, true]]);
  assert.equal((await api('GET', '/api/ladder')).status, 401);
});
