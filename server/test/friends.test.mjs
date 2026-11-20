// Amigos: pedido → aceitar, link com chave, chave errada, pedidos cruzados, remoção e avisos no hub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, connectHub, register } from './helpers.mjs';

const post = (who, body) => api('POST', '/api/friends', { token: who.token, body });
const me = async (who) => (await api('GET', '/api/me', { token: who.token })).data;

test('friend request → accept', async () => {
  const a = await register('Alice');
  const b = await register('Bruno');

  const r = await post(a, { tag: b.user.tag });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'requested');
  assert.deepEqual(r.data.user, b.user);
  // Repetir o pedido não duplica.
  assert.equal((await post(a, { tag: b.user.tag })).data.status, 'requested');

  assert.deepEqual((await me(a)).requests, { incoming: [], outgoing: [b.user] });
  assert.deepEqual((await me(b)).requests, { incoming: [a.user], outgoing: [] });

  const acc = await api('POST', `/api/friends/${a.user.id}/accept`, { token: b.token });
  assert.equal(acc.status, 200);
  const f = acc.data.friend;
  assert.equal(f.id, a.user.id);
  assert.equal(f.name, 'Alice');
  assert.equal(f.tag, a.user.tag);
  assert.equal(f.online, false);
  assert.equal(f.status, null);
  assert.equal(typeof f.lastSeen, 'number');
  assert.deepEqual(f.h2h, { w: 0, l: 0 });

  const ma = await me(a);
  const mb = await me(b);
  assert.deepEqual(ma.friends.map((x) => x.id), [b.user.id]);
  assert.deepEqual(mb.friends.map((x) => x.id), [a.user.id]);
  assert.deepEqual(ma.requests, { incoming: [], outgoing: [] });
  assert.deepEqual(mb.requests, { incoming: [], outgoing: [] });

  assert.equal((await post(a, { tag: b.user.tag })).data.status, 'already');
  // Aceitar outra vez: já não há pedido pendente.
  assert.equal((await api('POST', `/api/friends/${a.user.id}/accept`, { token: b.token })).status, 404);
});

test('crossed requests become friends', async () => {
  const a = await register();
  const b = await register();
  assert.equal((await post(a, { tag: b.user.tag })).data.status, 'requested');
  const r = await post(b, { tag: a.user.tag });
  assert.equal(r.data.status, 'friends');
  assert.deepEqual(r.data.user, a.user);
  assert.equal((await me(a)).friends.length, 1);
});

test('friend link key → instant friends', async () => {
  const owner = await register('Dono');
  const visitor = await register('Visita');
  // O tag pode vir em minúsculas e com '#'.
  const r = await post(visitor, { tag: '#' + owner.user.tag.toLowerCase(), key: owner.linkKey });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'friends');
  assert.deepEqual(r.data.user, owner.user);
  assert.deepEqual((await me(owner)).friends.map((x) => x.id), [visitor.user.id]);
  assert.deepEqual((await me(visitor)).friends.map((x) => x.id), [owner.user.id]);
});

test('wrong link key → only a request', async () => {
  const owner = await register();
  const visitor = await register();
  const wrongKey = owner.linkKey.slice(0, 7) + (owner.linkKey[7] === 'A' ? 'B' : 'A');
  const r = await post(visitor, { tag: owner.user.tag, key: wrongKey });
  assert.equal(r.data.status, 'requested');
  // A chave de outro utilizador também não serve.
  const other = await register();
  assert.equal((await post(other, { tag: owner.user.tag, key: visitor.linkKey })).data.status, 'requested');
  const mo = await me(owner);
  assert.equal(mo.friends.length, 0);
  assert.deepEqual(mo.requests.incoming.map((u) => u.id).sort(), [visitor.user.id, other.user.id].sort());
});

test('friend errors: self, not_found', async () => {
  const a = await register();
  const self = await post(a, { tag: a.user.tag, key: a.linkKey });
  assert.equal(self.status, 400);
  assert.equal(self.data.error, 'self');
  for (const tag of ['ZZZZ1', '', 'toolongtag', 123, undefined]) {
    const r = await post(a, { tag });
    assert.equal(r.status, 404, `tag ${tag}`);
    assert.equal(r.data.error, 'not_found');
  }
  assert.equal((await api('POST', '/api/friends/aaaaaaaaaaaa/accept', { token: a.token })).status, 404);
});

test('DELETE removes friendship, declines and cancels requests', async () => {
  const a = await register();
  const b = await register();
  const c = await register();
  await post(a, { tag: b.user.tag, key: b.linkKey });
  const del = await api('DELETE', `/api/friends/${b.user.id}`, { token: a.token });
  assert.equal(del.status, 200);
  assert.deepEqual(del.data, { ok: true });
  assert.equal((await me(a)).friends.length, 0);
  assert.equal((await me(b)).friends.length, 0);

  // Recusar (pelo destinatário) e cancelar (pelo remetente).
  await post(c, { tag: a.user.tag });
  await api('DELETE', `/api/friends/${c.user.id}`, { token: a.token });
  assert.deepEqual((await me(a)).requests.incoming, []);
  assert.deepEqual((await me(c)).requests.outgoing, []);
  await post(c, { tag: b.user.tag });
  await api('DELETE', `/api/friends/${b.user.id}`, { token: c.token });
  assert.deepEqual((await me(b)).requests.incoming, []);
  // Sem nada para apagar continua a responder ok.
  assert.deepEqual((await api('DELETE', `/api/friends/${b.user.id}`, { token: c.token })).data, { ok: true });
});

test('hub pushes friend-request / friend-added / friend-removed', async () => {
  const a = await register('Pusher');
  const b = await register('Pushed');
  const hb = await connectHub(b);
  const ha = await connectHub(a);
  try {
    await post(a, { tag: b.user.tag });
    const req = await hb.next('friend-request');
    assert.deepEqual(req.from, a.user);

    await api('POST', `/api/friends/${a.user.id}/accept`, { token: b.token });
    const added = await ha.next('friend-added');
    assert.equal(added.friend.id, b.user.id);
    assert.equal(added.friend.online, true);
    assert.equal(added.friend.status, 'lobby');
    assert.deepEqual(added.friend.h2h, { w: 0, l: 0 });
    const addedB = await hb.next('friend-added');
    assert.equal(addedB.friend.id, a.user.id);

    await api('DELETE', `/api/friends/${a.user.id}`, { token: b.token });
    assert.deepEqual(await ha.next('friend-removed'), { t: 'friend-removed', id: b.user.id });
  } finally {
    await ha.close();
    await hb.close();
  }
});
