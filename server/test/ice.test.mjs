// Teste unitário de src/ice.js (sem servidor): formatos de resposta do TURN da Cloudflare, falhas e TURN estático.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const realFetch = globalThis.fetch;
let n = 0;
// Cada teste importa uma cópia nova do módulo (a cache de credenciais é por módulo).
const freshIce = async () => (await import(`../src/ice.js?case=${++n}`)).iceServers;
const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const CF_ENV = { TURN_KEY_ID: 'kid', TURN_KEY_TOKEN: 'tok' };
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status });

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('ice: STUN only without TURN env', async () => {
  const iceServers = await freshIce();
  globalThis.fetch = () => assert.fail('must not call fetch');
  assert.deepEqual((await iceServers({})).map((s) => s.urls), STUN);
});

test('ice: Cloudflare generate-ice-servers shape, port 53 filtered, cached', async () => {
  const iceServers = await freshIce();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'u',
          credential: 'c',
        },
      ],
    });
  };
  const servers = await iceServers(CF_ENV);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials/generate-ice-servers');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ttl: 86400 });
  assert.deepEqual(servers.slice(0, 2).map((s) => s.urls), STUN);
  const turn = servers.find((s) => s.username);
  assert.deepEqual(turn, {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'u',
    credential: 'c',
  });
  await iceServers(CF_ENV);
  assert.equal(calls.length, 1, 'second call served from cache');
});

test('ice: older /credentials/generate shape is accepted', async () => {
  const iceServers = await freshIce();
  globalThis.fetch = async () =>
    jsonResponse({ iceServers: { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'x', credential: 'y' } });
  const servers = await iceServers(CF_ENV);
  assert.equal(servers.length, 3);
  assert.equal(servers[2].username, 'x');
});

test('ice: TURN failure never fails, falls back to static TURN or STUN', async () => {
  let iceServers = await freshIce();
  globalThis.fetch = async () => jsonResponse({ error: 'nope' }, 500);
  assert.deepEqual((await iceServers(CF_ENV)).map((s) => s.urls), STUN);

  iceServers = await freshIce();
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const env = { ...CF_ENV, TURN_URLS: 'turn:a.example:3478, turns:a.example:5349', TURN_USERNAME: 'su', TURN_CREDENTIAL: 'sc' };
  const servers = await iceServers(env);
  assert.deepEqual(servers[2], { urls: ['turn:a.example:3478', 'turns:a.example:5349'], username: 'su', credential: 'sc' });
});

test('ice: static TURN env', async () => {
  const iceServers = await freshIce();
  const servers = await iceServers({ TURN_URLS: 'turn:t.example:3478', TURN_USERNAME: 'a', TURN_CREDENTIAL: 'b' });
  assert.deepEqual(servers[2], { urls: ['turn:t.example:3478'], username: 'a', credential: 'b' });
  // Sem credenciais completas, nada de TURN.
  assert.equal((await iceServers({ TURN_URLS: 'turn:t.example:3478' })).length, 2);
});
