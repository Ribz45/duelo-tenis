// Room: relay nos dois sentidos, $room/$join/$leave, reconexão, limites e bilhetes inválidos/expirados.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, befriend, createMatch, devSecret, forgeTicket, register, roomUrl, sleep } from './helpers.mjs';

async function setup() {
  const a = await register('RoomHost');
  const b = await register('RoomGuest');
  await befriend(a, b);
  const { host, guest } = await createMatch(a, b);
  return { a, b, host, guest };
}

test('room relay both directions with $room/$join/$leave', async () => {
  const { a, b, host, guest } = await setup();
  const rh = await Client.open(roomUrl(host.matchId, host.ticket));
  let rg;
  try {
    assert.deepEqual(await rh.next('room'), { $: 'room', you: a.user.id, peers: [] });
    rg = await Client.open(roomUrl(guest.matchId, guest.ticket));
    assert.deepEqual(await rg.next('room'), { $: 'room', you: b.user.id, peers: [a.user.id] });
    assert.deepEqual(await rh.next('join'), { $: 'join', id: b.user.id });

    // Host → guest e guest → host, verbatim (incluindo espaços e texto não JSON).
    const f1 = '{"t":"hit","x":1.25,  "y":[1,2,3]}';
    rh.send(f1);
    assert.equal(await rg.nextRaw((d) => d?.t === 'hit'), f1);
    const f2 = JSON.stringify({ t: 'sdp', type: 'offer', sdp: 'v=0\r\n' + 'a'.repeat(4000) });
    rg.send(f2);
    assert.equal(await rh.nextRaw((d) => d?.t === 'sdp'), f2);
    rg.send('plain text frame');
    assert.equal(await rh.nextRaw((d, raw) => raw === 'plain text frame'), 'plain text frame');
    // Ninguém recebe o próprio frame.
    await rh.none((d) => d?.t === 'hit', 200);

    // Frames de sistema forjados por um cliente não passam.
    rg.send({ $: 'leave', id: b.user.id });
    await rh.none('leave', 300);

    // Frames > 16 KB são descartados; os seguintes continuam a passar.
    rh.send(JSON.stringify({ t: 'big', pad: 'x'.repeat(17 * 1024) }));
    rh.send({ t: 'after' });
    await rg.next('after');
    assert.equal(rg.queue.find((e) => e.data?.t === 'big'), undefined);

    // Saída: o outro recebe $leave.
    await rg.close();
    assert.deepEqual(await rh.next('leave'), { $: 'leave', id: b.user.id });
  } finally {
    await rh.close();
    await rg?.close();
  }
});

test('room reconnect replaces the old socket', async () => {
  const { a, b, host, guest } = await setup();
  const rh = await Client.open(roomUrl(host.matchId, host.ticket));
  const rg = await Client.open(roomUrl(guest.matchId, guest.ticket));
  let rh2;
  try {
    await rh.next('room');
    await rg.next('room');
    await rh.next('join');

    rh2 = await Client.open(roomUrl(host.matchId, host.ticket));
    assert.deepEqual(await rh2.next('room'), { $: 'room', you: a.user.id, peers: [b.user.id] });
    const closed = await rh.closed;
    assert.equal(closed.code, 4000);
    assert.deepEqual(await rg.next('join'), { $: 'join', id: a.user.id });
    await rg.none('leave', 400); // substituir não é sair

    rg.send({ t: 'ball', n: 1 });
    assert.equal((await rh2.next('ball')).n, 1);
    rh2.send({ t: 'ball', n: 2 });
    assert.equal((await rg.next('ball')).n, 2);
  } finally {
    await rh.close();
    await rg.close();
    await rh2?.close();
  }
});

test('room drops frames over 80/s from one socket', async () => {
  const { host, guest } = await setup();
  const rh = await Client.open(roomUrl(host.matchId, host.ticket));
  const rg = await Client.open(roomUrl(guest.matchId, guest.ticket));
  try {
    await rh.next('room');
    await rg.next('room');
    for (let i = 0; i < 300; i++) rh.send({ t: 'spam', i });
    await sleep(1000);
    const got = rg.queue.filter((e) => e.data?.t === 'spam').length;
    assert.ok(got >= 80 && got <= 160, `relayed ${got} of 300`);
  } finally {
    await rh.close();
    await rg.close();
  }
});

test('room rejects bad or expired tickets (close 4003, never joins)', { timeout: 120_000 }, async () => {
  const { a, host } = await setup();
  const [body, sig] = host.ticket.split('.');
  const flipped = sig.slice(0, -2) + (sig.at(-2) === 'A' ? 'B' : 'A') + sig.at(-1);
  const secret = devSecret();
  const forged = (claims, key = secret) => forgeTicket(key, { m: host.matchId, u: a.user.id, ...claims });

  const cases = {
    'missing ticket': roomUrl(host.matchId, ''),
    garbage: roomUrl(host.matchId, 'garbage'),
    'bad signature': roomUrl(host.matchId, `${body}.${flipped}`),
    'ticket for another match': roomUrl('a'.repeat(16), host.ticket),
    'expired ticket': roomUrl(host.matchId, forged({ e: Date.now() - 1000 })),
    'wrong key': roomUrl(host.matchId, forged({ e: Date.now() + 60_000 }, 'not-the-secret-123456')),
    'bad user id': roomUrl(host.matchId, forged({ u: 'x', e: Date.now() + 60_000 })),
  };
  const results = await Promise.all(Object.values(cases).map((u) => Client.closeResult(u)));
  Object.keys(cases).forEach((name, i) => {
    assert.equal(results[i].code, 4003, name);
    assert.deepEqual(results[i].frames, [], `${name}: no frames`);
  });
  // matchId inválido nem chega à Room: o upgrade é recusado por HTTP.
  assert.equal(await Client.rejected(roomUrl('bad-id', host.ticket)), true, 'invalid matchId');

  // Controlo: um bilhete forjado com o SECRET local e validade futura entra.
  const ok = await Client.open(roomUrl(host.matchId, forged({ e: Date.now() + 60_000 })));
  assert.equal((await ok.next('room')).you, a.user.id);
  await ok.close();
});
