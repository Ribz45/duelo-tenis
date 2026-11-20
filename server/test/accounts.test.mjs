// Contas: health, CORS, registo, /api/me, validação de nomes, PATCH, erros, rate limit e /api/ice.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE, SPAWNED, api, fakeIp, register } from './helpers.mjs';

const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TAG_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

test('GET /api/health', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(typeof r.data.time, 'number');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('CORS preflight', async () => {
  const res = await fetch(`${BASE}/api/me`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.github.io', 'Access-Control-Request-Method': 'PATCH' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
  assert.match(res.headers.get('access-control-allow-methods'), /PATCH/);
});

test('register + /api/me', async () => {
  const reg = await register('Ana', { look: 3 });
  assert.match(reg.token, CROCKFORD_RE);
  assert.match(reg.user.id, /^[0-9a-z]{12}$/);
  assert.match(reg.user.tag, TAG_RE);
  assert.equal(reg.user.name, 'Ana');
  assert.equal(reg.user.look, 3);
  assert.match(reg.linkKey, /^[A-Za-z0-9_-]{8}$/);
  assert.deepEqual(Object.keys(reg.user).sort(), ['id', 'look', 'name', 'tag']);

  const me = await api('GET', '/api/me', { token: reg.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.user, reg.user);
  assert.equal(me.data.linkKey, reg.linkKey);
  assert.deepEqual(me.data.friends, []);
  assert.deepEqual(me.data.requests, { incoming: [], outgoing: [] });
  assert.deepEqual(me.data.record.online, { w: 0, l: 0 });
  assert.deepEqual(me.data.record.cpu, { w: 0, l: 0 });
  assert.equal(me.data.record.totals.matches, 0);
  assert.equal(me.data.record.totals.fastestServe, 0);

  // O "código da conta" escrito à mão (minúsculas, hífenes) também serve.
  const typed = reg.token.toLowerCase().replace(/(.{5})/g, '$1-');
  const me2 = await api('GET', '/api/me', { token: typed });
  assert.equal(me2.status, 200);
  assert.equal(me2.data.user.id, reg.user.id);
});

test('look defaults to 0 and is clamped', async () => {
  assert.equal((await register('Def')).user.look, 0);
  assert.equal((await register('Big', { look: 42 })).user.look, 9);
  assert.equal((await register('Neg', { look: -3 })).user.look, 0);
  const bad = await api('POST', '/api/register', { body: { name: 'X', look: 'red' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid_look');
});

test('name validation', async () => {
  for (const name of ['', '   ', '\u0000\u0007', 'x'.repeat(17), 42, null, ['a']]) {
    const r = await api('POST', '/api/register', { body: { name } });
    assert.equal(r.status, 400, `name ${JSON.stringify(name)} should be rejected`);
    assert.equal(r.data.error, 'invalid_name');
    assert.equal(typeof r.data.message, 'string');
  }
  const missing = await api('POST', '/api/register', { body: {} });
  assert.equal(missing.status, 400);

  assert.equal((await register('  Ana   Rita  ')).user.name, 'Ana Rita');
  assert.equal((await register('Jo\u0000ão​\n')).user.name, 'João');
  assert.equal((await register('É'.repeat(16))).user.name, 'É'.repeat(16));
  assert.equal((await register('🎾 Duelo')).user.name, '🎾 Duelo');
});

test('PATCH /api/me', async () => {
  const reg = await register('Old');
  const r = await api('PATCH', '/api/me', { token: reg.token, body: { name: ' New ', look: 7 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.user, { ...reg.user, name: 'New', look: 7 });
  const bad = await api('PATCH', '/api/me', { token: reg.token, body: { name: '' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid_name');
  const me = await api('GET', '/api/me', { token: reg.token });
  assert.equal(me.data.user.name, 'New');
});

test('auth and error shapes', async () => {
  const none = await api('GET', '/api/me');
  assert.equal(none.status, 401);
  assert.equal(none.data.error, 'unauthorized');
  const wrong = await api('GET', '/api/me', { token: '0'.repeat(26) });
  assert.equal(wrong.status, 401);
  const junk = await api('GET', '/api/me', { token: 'not a token' });
  assert.equal(junk.status, 401);

  const badJson = await api('POST', '/api/register', { body: '{nope' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.data.error, 'bad_json');

  const big = await api('POST', '/api/register', { body: { name: 'A', pad: 'x'.repeat(20000) } });
  assert.equal(big.status, 413);

  const unknown = await api('GET', '/api/nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error, 'not_found');
  const method = await api('PUT', '/api/me');
  assert.equal(method.status, 405);
  const root = await api('GET', '/');
  assert.equal(root.status, 404);

  const reg = await register();
  const badId = await api('GET', '/api/users/..%2Fme', { token: reg.token });
  assert.equal(badId.status, 404);
});

test('register rate limit per CF-Connecting-IP', async () => {
  const ip = fakeIp();
  let ok = 0;
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await api('POST', '/api/register', { body: { name: `RL${i}` }, ip });
    if (r.status === 200) ok++;
    else limited = r;
  }
  assert.ok(limited, 'expected a 429 within 21 attempts');
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error, 'rate_limited');
  assert.ok(ok >= 1 && ok <= 20, `allowed ${ok}`);
  if (SPAWNED) assert.equal(ok, Number(process.env.DT_REGISTER_LIMIT));
  // Continua bloqueado; outro IP continua a poder registar.
  assert.equal((await api('POST', '/api/register', { body: { name: 'again' }, ip })).status, 429);
  assert.equal((await api('POST', '/api/register', { body: { name: 'other' }, ip: fakeIp() })).status, 200);
});

test('GET /api/ice returns STUN (no TURN configured)', async () => {
  const reg = await register();
  assert.equal((await api('GET', '/api/ice')).status, 401);
  const r = await api('GET', '/api/ice', { token: reg.token });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.iceServers));
  const urls = r.data.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
  assert.ok(urls.includes('stun:stun.cloudflare.com:3478'));
  assert.ok(urls.includes('stun:stun.l.google.com:19302'));
  if (SPAWNED) assert.ok(!urls.some((u) => u.startsWith('turn')), 'no TURN without env');
});
