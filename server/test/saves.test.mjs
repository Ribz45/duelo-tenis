// Gravações por utilizador: GET/PUT com rev (concorrência otimista), force, chaves, tamanho, limite de pedidos,
// e o resumo da carreira visível aos amigos (/api/me, /api/users/:id, hello do hub).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, befriend, connectHub, register } from './helpers.mjs';

const getSave = (who, key) => api('GET', `/api/save/${key}`, { token: who.token });
const putSave = (who, key, body) => api('PUT', `/api/save/${key}`, { token: who.token, body });
const me = async (who) => (await api('GET', '/api/me', { token: who.token })).data;

test('save: 404 → PUT base 0 → GET → stale base 409 → force', async () => {
  const p = await register('Saver');
  let r = await getSave(p, 'career');
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'not_found');
  assert.equal(typeof r.data.message, 'string');

  const data1 = { season: 1, week: 3, players: ['a', 'b'], nested: { x: [1, 2, { y: null }] }, txt: 'Ténis 🎾' };
  r = await putSave(p, 'career', { base: 0, data: data1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.rev, 1);
  assert.equal(typeof r.data.at, 'number');
  assert.deepEqual(Object.keys(r.data).sort(), ['at', 'ok', 'rev']);
  const at1 = r.data.at;

  r = await getSave(p, 'career');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { key: 'career', rev: 1, data: data1, at: at1 });
  // A outra chave é independente.
  assert.equal((await getSave(p, 'achievements')).status, 404);

  // Atualização normal com a base certa.
  const data2 = { ...data1, week: 4 };
  r = await putSave(p, 'career', { base: 1, data: data2 });
  assert.equal(r.status, 200);
  assert.equal(r.data.rev, 2);
  const at2 = r.data.at;

  // Base desatualizada (outro telemóvel ainda está na rev 1) → 409 com a rev/at guardadas.
  r = await putSave(p, 'career', { base: 1, data: { stale: true } });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'conflict');
  assert.equal(typeof r.data.message, 'string');
  assert.equal(r.data.rev, 2);
  assert.equal(r.data.at, at2);
  // base 0 quando o servidor já tem uma gravação → também é conflito.
  r = await putSave(p, 'career', { base: 0, data: { fresh: true } });
  assert.equal(r.status, 409);
  assert.equal(r.data.rev, 2);
  // Nada mudou.
  assert.deepEqual((await getSave(p, 'career')).data, { key: 'career', rev: 2, data: data2, at: at2 });

  // force escreve por cima e a rev continua a subir.
  r = await putSave(p, 'career', { base: 1, data: { forced: true }, force: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.rev, 3);
  r = await getSave(p, 'career');
  assert.equal(r.data.rev, 3);
  assert.deepEqual(r.data.data, { forced: true });
  // force sem base também serve; force tem de ser exatamente true.
  assert.equal((await putSave(p, 'career', { data: 1, force: true })).data.rev, 4);
  assert.equal((await putSave(p, 'career', { base: 1, data: 1, force: 'yes' })).status, 409);

  // Chave nunca gravada com base ≠ 0 → 409 com rev 0 e at null.
  r = await putSave(p, 'achievements', { base: 5, data: [] });
  assert.equal(r.status, 409);
  assert.equal(r.data.rev, 0);
  assert.equal(r.data.at, null);
  // Qualquer valor JSON: arrays, strings, números, null.
  assert.equal((await putSave(p, 'achievements', { base: 0, data: ['ace', 'first-win'] })).data.rev, 1);
  assert.deepEqual((await getSave(p, 'achievements')).data.data, ['ace', 'first-win']);
  assert.equal((await putSave(p, 'achievements', { base: 1, data: null })).data.rev, 2);
  r = await getSave(p, 'achievements');
  assert.equal(r.data.rev, 2);
  assert.equal(r.data.data, null);
  assert.equal((await putSave(p, 'achievements', { base: 2, data: 'texto' })).data.rev, 3);
  assert.equal((await getSave(p, 'achievements')).data.data, 'texto');

  // As gravações são de cada utilizador.
  const q = await register('Other');
  assert.equal((await getSave(q, 'career')).status, 404);
  assert.equal((await putSave(q, 'career', { base: 0, data: {} })).data.rev, 1);
  assert.equal((await getSave(p, 'career')).data.rev, 4);
});

test('save: bad key, auth, validation, too large', async () => {
  const p = await register();
  for (const key of ['settings', 'Career', 'achievementz', 'aaaaaaaaaaaa', 'career2', 'x'.repeat(100)]) {
    const g = await getSave(p, key);
    assert.equal(g.status, 400, `GET ${key}`);
    assert.equal(g.data.error, 'bad_key');
    const w = await putSave(p, key, { base: 0, data: {} });
    assert.equal(w.status, 400, `PUT ${key}`);
    assert.equal(w.data.error, 'bad_key');
  }
  assert.equal((await api('GET', '/api/save/career')).status, 401);
  assert.equal((await api('PUT', '/api/save/career', { body: { base: 0, data: {} } })).status, 401);
  assert.equal((await api('DELETE', '/api/save/career', { token: p.token })).status, 405);

  assert.equal((await putSave(p, 'career', { base: 0 })).data.error, 'bad_data');
  for (const base of [undefined, null, -1, 1.5, '0', [0]]) {
    const r = await putSave(p, 'career', { base, data: {} });
    assert.equal(r.status, 400, `base ${JSON.stringify(base)}`);
    assert.equal(r.data.error, 'bad_base');
  }
  for (const summary of ['x', 5, [1, 2], true]) {
    const r = await putSave(p, 'career', { base: 0, data: {}, summary });
    assert.equal(r.status, 400, `summary ${JSON.stringify(summary)}`);
    assert.equal(r.data.error, 'bad_summary');
  }
  // Nas conquistas o resumo é ignorado (mesmo inválido).
  assert.equal((await putSave(p, 'achievements', { base: 0, data: {}, summary: 'x' })).status, 200);

  // Limite: JSON.stringify(data).length ≤ 65536.
  const okData = 'x'.repeat(65534); // + 2 aspas = 65536
  let r = await putSave(p, 'career', { base: 0, data: okData });
  assert.equal(r.status, 200);
  assert.equal(r.data.rev, 1);
  assert.equal((await getSave(p, 'career')).data.data, okData);
  r = await putSave(p, 'career', { base: 1, data: 'x'.repeat(65535) });
  assert.equal(r.status, 413);
  assert.equal(r.data.error, 'too_large');
  r = await putSave(p, 'career', { base: 1, data: { list: Array.from({ length: 9000 }, (_, i) => i * 1000) } });
  assert.equal(r.status, 413);
  // Caracteres não ASCII contam como caracteres, não bytes.
  assert.equal((await putSave(p, 'career', { base: 1, data: 'é'.repeat(65534) })).status, 200);
  // Corpo enorme: recusado antes de ser lido por inteiro.
  r = await putSave(p, 'career', { base: 2, data: 'x'.repeat(400_000) });
  assert.equal(r.status, 413);
  assert.equal(r.data.error, 'too_large');
  assert.equal((await getSave(p, 'career')).data.rev, 2);
});

test('save: 120 PUTs per hour per user', async () => {
  const p = await register('Spammer');
  for (let i = 0; i < 120; i++) {
    const r = await putSave(p, i % 2 ? 'career' : 'achievements', { data: i, force: true });
    assert.equal(r.status, 200, `PUT #${i + 1}`);
  }
  const r = await putSave(p, 'career', { data: 'one more', force: true });
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'rate_limited');
  // Ler continua a funcionar, e outro utilizador não é afetado.
  assert.equal((await getSave(p, 'career')).status, 200);
  const q = await register();
  assert.equal((await putSave(q, 'career', { base: 0, data: 1 })).status, 200);
});

test('career summary: clamped, kept, cleared, visible to friends (me, users/:id, hub hello)', async () => {
  const a = await register('Carreira');
  const b = await register('Amigo');
  const stranger = await register('Estranho');
  await befriend(a, b);

  // Antes de haver resumo: null em todo o lado; Elo inicial 1000.
  const meA0 = await me(a);
  assert.equal(meA0.career, null);
  assert.equal(meA0.elo, 1000);
  const fa0 = (await me(b)).friends.find((f) => f.id === a.user.id);
  assert.equal(fa0.career, null);
  assert.equal(fa0.elo, 1000);
  assert.equal((await api('GET', `/api/users/${a.user.id}`, { token: b.token })).data.career, null);

  // Valores fora dos limites são limitados; o nome é limpo como os nomes de utilizador.
  const summaryIn = {
    rank: 0, bestRank: 5000, titles: -3, majors: 2.7, level: 150, season: 0,
    name: '  Rafa\u0000​   Nadal  ', extra: 'ignored',
  };
  let r = await putSave(a, 'career', { base: 0, data: { any: 'thing' }, summary: summaryIn });
  assert.equal(r.status, 200);
  const expected = { rank: 1, bestRank: 999, titles: 0, majors: 2, level: 99, season: 1, name: 'Rafa Nadal' };

  assert.deepEqual((await me(a)).career, expected);
  const meB = await me(b);
  const fa = meB.friends.find((f) => f.id === a.user.id);
  assert.deepEqual(fa.career, expected);
  assert.equal(fa.elo, 1000);
  assert.equal(meB.career, null); // o meu resumo, não o do amigo
  const viewA = (await api('GET', `/api/users/${a.user.id}`, { token: b.token })).data;
  assert.deepEqual(viewA.career, expected);
  assert.equal(viewA.elo, 1000);
  // Como o recorde, o resumo também se vê em /api/users/:id por quem não é amigo.
  assert.deepEqual((await api('GET', `/api/users/${a.user.id}`, { token: stranger.token })).data.career, expected);

  // Hub: o hello de B traz o resumo e o Elo de A.
  const hb = await connectHub(b);
  try {
    const f = hb.hello.friends.find((x) => x.id === a.user.id);
    assert.deepEqual(f.career, expected);
    assert.equal(f.elo, 1000);
  } finally {
    await hb.close();
  }

  // Nome longo é cortado a 24; nome vazio/não texto → sem nome; números em texto são aceites.
  r = await putSave(a, 'career', {
    base: 1, data: {}, summary: { rank: '42', bestRank: 7, titles: 3, majors: 1, level: 12, season: 2, name: 'N'.repeat(30) },
  });
  assert.equal(r.data.rev, 2);
  assert.deepEqual((await me(a)).career, { rank: 42, bestRank: 7, titles: 3, majors: 1, level: 12, season: 2, name: 'N'.repeat(24) });
  await putSave(a, 'career', { base: 2, data: {}, summary: { rank: 40, bestRank: 7, titles: 3, majors: 1, level: 12, season: 2, name: ' \u0007 ' } });
  const noName = { rank: 40, bestRank: 7, titles: 3, majors: 1, level: 12, season: 2 };
  assert.deepEqual((await me(a)).career, noName);

  // Sem summary mantém-se o anterior; um PUT em conflito não mexe no resumo; resumo nas conquistas é ignorado.
  assert.equal((await putSave(a, 'career', { base: 3, data: { more: 1 } })).data.rev, 4);
  assert.equal((await putSave(a, 'career', { base: 1, data: {}, summary: { rank: 1 } })).status, 409);
  await putSave(a, 'achievements', { base: 0, data: [], summary: { rank: 1 } });
  assert.deepEqual((await me(a)).career, noName);
  assert.deepEqual((await me(b)).friends.find((f) => f.id === a.user.id).career, noName);

  // friend-added (e a resposta de aceitar) também trazem o resumo de quem passa a amigo.
  const c = await register('Novo');
  await api('POST', '/api/friends', { token: c.token, body: { tag: a.user.tag } });
  const acc = await api('POST', `/api/friends/${c.user.id}/accept`, { token: a.token });
  assert.equal(acc.data.friend.career, null);
  assert.equal(acc.data.friend.elo, 1000);
  assert.deepEqual((await me(c)).friends.find((f) => f.id === a.user.id).career, noName);

  // summary: null apaga o resumo.
  assert.equal((await putSave(a, 'career', { base: 4, data: {}, summary: null })).data.rev, 5);
  assert.equal((await me(a)).career, null);
  assert.equal((await me(b)).friends.find((f) => f.id === a.user.id).career, null);
});
