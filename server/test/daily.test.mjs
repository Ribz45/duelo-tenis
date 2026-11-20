// Desafio diário: hoje/ontem (UTC), melhor pontuação, improved, validação, quadro só comigo + amigos, ordem.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, befriend, register, sleep } from './helpers.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
const post = (who, body) => api('POST', '/api/daily', { token: who.token, body });
const get = (who, day) => api('GET', day === undefined ? '/api/daily' : `/api/daily?day=${encodeURIComponent(day)}`, { token: who.token });

test('daily: submit today, best kept, improved flag, yesterday', async () => {
  const p = await register('Diario');
  const today = utcDay();
  let r = await get(p, today);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { day: today, me: null, board: [] });

  r = await post(p, { day: today, score: 500, detail: '3 aces, 2 winners' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true, best: 500, improved: true });
  // Pior ou igual: fica o melhor (e o detalhe dele).
  assert.deepEqual((await post(p, { day: today, score: 300, detail: 'worse' })).data, { ok: true, best: 500, improved: false });
  assert.deepEqual((await post(p, { day: today, score: 500, detail: 'same' })).data, { ok: true, best: 500, improved: false });
  r = await get(p, today);
  assert.deepEqual(r.data.me, { score: 500, detail: '3 aces, 2 winners' });

  // Melhor: substitui pontuação e detalhe (sem detalhe → null).
  assert.deepEqual((await post(p, { day: today, score: 800 })).data, { ok: true, best: 800, improved: true });
  r = await get(p, today);
  assert.deepEqual(r.data, {
    day: today,
    me: { score: 800, detail: null },
    board: [{ user: p.user, score: 800, detail: null, me: true }],
  });
  // Sem ?day= → hoje.
  assert.deepEqual((await get(p)).data, r.data);

  // Ontem também é aceite, e é um dia à parte.
  const yesterday = utcDay(-1);
  assert.deepEqual((await post(p, { day: yesterday, score: 120, detail: 'late' })).data, { ok: true, best: 120, improved: true });
  r = await get(p, yesterday);
  assert.deepEqual(r.data.me, { score: 120, detail: 'late' });
  assert.deepEqual(r.data.board.map((e) => e.score), [120]);
  assert.equal((await get(p, today)).data.me.score, 800);
  // Um dia antigo sem pontuações.
  assert.deepEqual((await get(p, '2020-01-01')).data, { day: '2020-01-01', me: null, board: [] });
});

test('daily: validation (day, score, detail, auth)', async () => {
  const p = await register();
  const today = utcDay();
  for (const day of [utcDay(1), utcDay(-2), '2020-01-01', '2026-13-01', '2026-02-30', 'today', today + 'T00:00:00Z', 20261120, null, undefined]) {
    const r = await post(p, { day, score: 10 });
    assert.equal(r.status, 400, `day ${JSON.stringify(day)}`);
    assert.equal(r.data.error, 'bad_day');
  }
  for (const score of [-1, 100001, 1.5, '100', null, undefined, Infinity, [5]]) {
    const r = await post(p, { day: today, score });
    assert.equal(r.status, 400, `score ${JSON.stringify(score)}`);
    assert.equal(r.data.error, 'bad_score');
  }
  for (const detail of ['x'.repeat(121), 42, { a: 1 }, ['x']]) {
    const r = await post(p, { day: today, score: 1, detail });
    assert.equal(r.status, 400, `detail ${JSON.stringify(detail)?.slice(0, 20)}`);
    assert.equal(r.data.error, 'bad_detail');
  }
  // Limites aceites; o detalhe é limpo (controlos fora, espaços colapsados; vazio → null).
  assert.deepEqual((await post(p, { day: today, score: 0, detail: ' \u0007 ' })).data, { ok: true, best: 0, improved: true });
  assert.equal((await get(p, today)).data.me.detail, null);
  assert.equal((await post(p, { day: today, score: 1, detail: 'é'.repeat(120) })).status, 200);
  assert.deepEqual((await post(p, { day: today, score: 100000, detail: ' Rally\u0000  de   40 ' })).data, { ok: true, best: 100000, improved: true });
  assert.deepEqual((await get(p, today)).data.me, { score: 100000, detail: 'Rally de 40' });

  for (const day of ['nope', '2026-1-1', '2026-02-30', '']) {
    const r = await get(p, day);
    assert.equal(r.status, 400, `GET day ${day}`);
    assert.equal(r.data.error, 'bad_day');
  }
  assert.equal((await api('GET', '/api/daily')).status, 401);
  assert.equal((await api('POST', '/api/daily', { body: { day: today, score: 1 } })).status, 401);
});

test('daily board: me + accepted friends only, score desc then earliest', async () => {
  const today = utcDay();
  const me = await register('Eu');
  const f1 = await register('Amiga1');
  const f2 = await register('Amigo2');
  const f3 = await register('SemPontos');
  const stranger = await register('Estranho');
  const pending = await register('Pendente');
  await befriend(me, f1);
  await befriend(me, f2);
  await befriend(me, f3);
  // Pedido de amizade ainda não aceite: não conta.
  assert.equal((await api('POST', '/api/friends', { token: pending.token, body: { tag: me.user.tag } })).data.status, 'requested');

  await post(f1, { day: today, score: 700, detail: 'first 700' });
  await sleep(15);
  await post(me, { day: today, score: 900 });
  await post(stranger, { day: today, score: 5000 });
  await post(pending, { day: today, score: 4000 });
  await sleep(15);
  await post(f2, { day: today, score: 700, detail: 'second 700' });

  let r = await get(me, today);
  assert.deepEqual(r.data.me, { score: 900, detail: null });
  assert.deepEqual(r.data.board, [
    { user: me.user, score: 900, detail: null, me: true },
    { user: f1.user, score: 700, detail: 'first 700', me: false },
    { user: f2.user, score: 700, detail: 'second 700', me: false },
  ]);

  // f2 melhora e passa para a frente; f1 empata com 900 mais tarde → fica atrás de mim.
  await post(f2, { day: today, score: 950 });
  await sleep(15);
  await post(f1, { day: today, score: 900 });
  r = await get(me, today);
  assert.deepEqual(r.data.board.map((e) => [e.user.id, e.score, e.me]), [
    [f2.user.id, 950, false],
    [me.user.id, 900, true],
    [f1.user.id, 900, false],
  ]);

  // O quadro de f1 é f1 + os amigos de f1 (só eu): f2 não aparece.
  r = await get(f1, today);
  assert.deepEqual(r.data.board.map((e) => [e.user.id, e.me]), [
    [me.user.id, false],
    [f1.user.id, true],
  ]);
  // Quem não tem amigos só se vê a si.
  r = await get(stranger, today);
  assert.deepEqual(r.data.board, [{ user: stranger.user, score: 5000, detail: null, me: true }]);

  // As pontuações de hoje não aparecem ontem.
  assert.deepEqual((await get(me, utcDay(-1))).data.board, []);
});

test('daily: 60 posts per hour per user', async () => {
  const p = await register('Grinder');
  const today = utcDay();
  for (let i = 0; i < 60; i++) {
    const r = await post(p, { day: today, score: i });
    assert.equal(r.status, 200, `POST #${i + 1}`);
  }
  const r = await post(p, { day: today, score: 99 });
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'rate_limited');
  assert.equal((await get(p, today)).data.me.score, 59);
});
