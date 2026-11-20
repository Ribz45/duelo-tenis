// Hub WebSocket: hello, ping, presença, estado, convites (aceitar, recusar, expirar, cancelar, falhas).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INVITE_TTL_MS, Client, befriend, connectHub, hubUrl, register, sleep } from './helpers.mjs';

test('hub rejects bad tokens', async () => {
  assert.equal(await Client.rejected(hubUrl('0'.repeat(26))), true);
  assert.equal(await Client.rejected(hubUrl('garbage')), true);
});

test('hello + ping/pong', async () => {
  const a = await register('Hello');
  const b = await register('Friend');
  await befriend(a, b);
  const ha = await connectHub(a);
  try {
    assert.deepEqual(ha.hello.me, a.user);
    assert.equal(ha.hello.friends.length, 1);
    const f = ha.hello.friends[0];
    assert.equal(f.id, b.user.id);
    assert.equal(f.online, false);
    assert.equal(f.status, null);
    assert.equal(typeof f.lastSeen, 'number');
    assert.deepEqual(f.h2h, { w: 0, l: 0 });
    ha.send({ t: 'ping' });
    const pong = await ha.next('pong');
    assert.equal(typeof pong.time, 'number');
    // Lixo e tipos desconhecidos são ignorados sem fechar a ligação.
    ha.send('not json');
    ha.send({ t: 'whatever' });
    ha.send({ t: 'ping' });
    await ha.next('pong');
  } finally {
    await ha.close();
  }
});

test('presence online/offline between two hub sockets', async () => {
  const a = await register('PresA');
  const b = await register('PresB');
  await befriend(a, b);
  const ha = await connectHub(a);
  const hb = await connectHub(b);
  try {
    assert.deepEqual(await ha.next('presence'), { t: 'presence', id: b.user.id, online: true, status: 'lobby' });
    const fa = hb.hello.friends.find((f) => f.id === a.user.id);
    assert.equal(fa.online, true);
    assert.equal(fa.status, 'lobby');

    hb.send({ t: 'status', s: 'match' });
    assert.deepEqual(await ha.next('presence'), { t: 'presence', id: b.user.id, online: true, status: 'match' });
    hb.send({ t: 'status', s: 'bogus' });
    await ha.none('presence', 300);
    hb.send({ t: 'status', s: 'lobby' });
    assert.equal((await ha.next('presence')).status, 'lobby');

    // Segunda aba: continua online até fechar a última.
    const hb2 = await connectHub(b);
    await ha.none('presence', 300);
    await hb.close();
    await ha.none('presence', 400);
    const before = Date.now();
    await hb2.close();
    const off = await ha.next('presence');
    assert.equal(off.id, b.user.id);
    assert.equal(off.online, false);
    assert.equal(off.status, null);
    assert.ok(off.lastSeen >= before - 5000 && off.lastSeen <= Date.now() + 5000);
  } finally {
    await ha.close();
    await hb.close();
  }
});

test('invite → accept → both get match with tickets', async () => {
  const a = await register('Host');
  const b = await register('Guest');
  await befriend(a, b);
  const ha = await connectHub(a);
  const hb = await connectHub(b);
  try {
    await ha.next('presence');
    ha.send({ t: 'invite', to: b.user.id, cfg: { surface: 'grass', junk: 1 } });
    const sent = await ha.next('invite-sent');
    assert.equal(sent.to, b.user.id);
    assert.match(sent.id, /^[0-9a-z]{12}$/);
    const inv = await hb.next('invite');
    assert.equal(inv.id, sent.id);
    assert.deepEqual(inv.from, a.user);
    assert.deepEqual(inv.cfg, { surface: 'grass' });
    assert.equal(inv.exp, sent.exp);
    assert.ok(inv.exp > Date.now());

    hb.send({ t: 'invite-reply', id: inv.id, accept: true });
    const mh = await ha.next('match');
    const mg = await hb.next('match');
    assert.equal(mh.matchId, mg.matchId);
    assert.match(mh.matchId, /^[0-9a-z]{16}$/);
    assert.equal(mh.role, 'host');
    assert.equal(mg.role, 'guest');
    assert.deepEqual(mh.opp, b.user);
    assert.deepEqual(mg.opp, a.user);
    assert.deepEqual(mh.cfg, { surface: 'grass' });
    assert.deepEqual(mg.cfg, { surface: 'grass' });
    assert.match(mh.ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.notEqual(mh.ticket, mg.ticket);
    const claims = JSON.parse(Buffer.from(mh.ticket.split('.')[0], 'base64url').toString());
    assert.equal(claims.m, mh.matchId);
    assert.equal(claims.u, a.user.id);
    assert.ok(claims.e > Date.now() + 2.9 * 3600 * 1000);

    // Os dois passam a 'match'.
    assert.equal((await ha.next((m) => m?.t === 'presence' && m.status === 'match')).id, b.user.id);
    assert.equal((await hb.next((m) => m?.t === 'presence' && m.status === 'match')).id, a.user.id);

    // Convidar alguém em partida → busy.
    const c = await register('Third');
    await befriend(c, a);
    const hc = await connectHub(c);
    hc.send({ t: 'invite', to: a.user.id, cfg: { surface: 'hard' } });
    assert.deepEqual(await hc.next('invite-failed'), { t: 'invite-failed', to: a.user.id, reason: 'busy' });
    await hc.close();

    // Responder outra vez ao mesmo convite → expirado.
    hb.send({ t: 'invite-reply', id: inv.id, accept: true });
    assert.deepEqual(await hb.next('invite-expired'), { t: 'invite-expired', id: inv.id });
  } finally {
    await ha.close();
    await hb.close();
  }
});

test('invite decline', async () => {
  const a = await register();
  const b = await register();
  await befriend(a, b);
  const ha = await connectHub(a);
  const hb = await connectHub(b);
  try {
    ha.send({ t: 'invite', to: b.user.id, cfg: { surface: 'clay' } });
    const inv = await hb.next('invite');
    hb.send({ t: 'invite-reply', id: inv.id, accept: false });
    assert.deepEqual(await ha.next('invite-declined'), { t: 'invite-declined', id: inv.id });
    await ha.none('match', 300);
  } finally {
    await ha.close();
    await hb.close();
  }
});

test('invite expiry and unknown id', { timeout: INVITE_TTL_MS + 15_000 }, async () => {
  const a = await register();
  const b = await register();
  await befriend(a, b);
  const ha = await connectHub(a);
  const hb = await connectHub(b);
  try {
    hb.send({ t: 'invite-reply', id: 'zzzzzzzzzzzz', accept: true });
    assert.deepEqual(await hb.next('invite-expired'), { t: 'invite-expired', id: 'zzzzzzzzzzzz' });
    hb.send({ t: 'invite-reply', id: 42, accept: true });
    assert.equal((await hb.next('invite-expired')).id, null);

    ha.send({ t: 'invite', to: b.user.id, cfg: {} });
    const inv = await hb.next('invite');
    assert.deepEqual(inv.cfg, { surface: 'hard' }); // superfície por omissão
    await sleep(inv.exp - Date.now() + 300);
    hb.send({ t: 'invite-reply', id: inv.id, accept: true });
    assert.deepEqual(await hb.next('invite-expired'), { t: 'invite-expired', id: inv.id });
    await ha.none('match', 300);
  } finally {
    await ha.close();
    await hb.close();
  }
});

test('invite failures: offline friend, not a friend', async () => {
  const a = await register();
  const b = await register();
  const stranger = await register();
  await befriend(a, b);
  const ha = await connectHub(a);
  try {
    ha.send({ t: 'invite', to: b.user.id, cfg: { surface: 'hard' } });
    assert.deepEqual(await ha.next('invite-failed'), { t: 'invite-failed', to: b.user.id, reason: 'offline' });
    ha.send({ t: 'invite', to: stranger.user.id });
    assert.equal((await ha.next('invite-failed')).reason, 'not-friend');
    ha.send({ t: 'invite', to: a.user.id });
    assert.equal((await ha.next('invite-failed')).reason, 'not-friend');
    ha.send({ t: 'invite', to: { evil: true } });
    assert.deepEqual(await ha.next('invite-failed'), { t: 'invite-failed', to: null, reason: 'not-friend' });
  } finally {
    await ha.close();
  }
});

test('invite cancel, replacement, wrong replier, inviter leaving', async () => {
  const a = await register();
  const b = await register();
  const c = await register();
  await befriend(a, b);
  await befriend(c, b);
  const ha = await connectHub(a);
  const hb = await connectHub(b);
  const hc = await connectHub(c);
  try {
    // Cancelar pelo remetente.
    ha.send({ t: 'invite', to: b.user.id });
    const inv1 = await hb.next('invite');
    ha.send({ t: 'invite-cancel', id: inv1.id });
    assert.deepEqual(await hb.next('invite-cancelled'), { t: 'invite-cancelled', id: inv1.id });

    // Um novo convite para a mesma pessoa substitui o anterior.
    ha.send({ t: 'invite', to: b.user.id });
    const inv2 = await hb.next('invite');
    ha.send({ t: 'invite', to: b.user.id });
    assert.equal((await hb.next('invite-cancelled')).id, inv2.id);
    const inv3 = await hb.next('invite');

    // Só o destinatário pode responder; o convite continua válido para ele.
    hc.send({ t: 'invite-reply', id: inv3.id, accept: true });
    assert.equal((await hc.next('invite-expired')).id, inv3.id);
    // Quem não é o remetente não pode cancelar.
    hc.send({ t: 'invite-cancel', id: inv3.id });
    await hb.none('invite-cancelled', 300);

    // O remetente sai → o convite é cancelado.
    await ha.close();
    assert.equal((await hb.next('invite-cancelled')).id, inv3.id);
    hb.send({ t: 'invite-reply', id: inv3.id, accept: true });
    assert.equal((await hb.next('invite-expired')).id, inv3.id);

    // Convite pendente é reenviado a quem volta a ligar.
    hc.send({ t: 'invite', to: b.user.id });
    const inv4 = await hb.next('invite');
    const hb2 = await connectHub(b);
    assert.equal((await hb2.next('invite')).id, inv4.id);
    await hb2.close();
  } finally {
    await ha.close();
    await hb.close();
    await hc.close();
  }
});
