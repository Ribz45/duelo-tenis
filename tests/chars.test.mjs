import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTERS, STATS, mods, total, charById } from '../chars.js';

test('todos os tenistas somam 30 e têm atributos de 1 a 10', () => {
  for (const c of CHARACTERS) {
    assert.equal(total(c.stats), 30, c.id);
    for (const k of STATS) assert.ok(c.stats[k] >= 1 && c.stats[k] <= 10, c.id + ' ' + k);
  }
});
test('ids únicos e equipamentos diferentes', () => {
  assert.equal(new Set(CHARACTERS.map(c => c.id)).size, CHARACTERS.length);
  assert.equal(new Set(CHARACTERS.map(c => c.look)).size, CHARACTERS.length);
  assert.equal(charById('nao-existe').id, 'tudo');
});
test('6 em tudo = o jogo base (multiplicadores neutros)', () => {
  const m = mods(charById('tudo').stats);
  for (const k of ['speed', 'power', 'serve', 'serveAcc', 'scatter', 'window']) assert.equal(m[k], 1, k);
  assert.equal(m.reach, 0);
});
test('os extremos ficam em intervalos razoáveis', () => {
  const lo = mods({ spd:1, rch:1, pow:1, srv:1, ctl:1 }), hi = mods({ spd:10, rch:10, pow:10, srv:10, ctl:10 });
  assert.ok(lo.speed > 0.8 && hi.speed < 1.2);
  assert.ok(lo.reach > -0.4 && hi.reach < 0.35);
  assert.ok(lo.scatter < 1.35 && hi.scatter > 0.7);
  assert.ok(hi.power < 1.1);
});
test('perks e traço de vólei', () => {
  const m = mods(charById('rede').stats, ['volley', 'perfectServeWindow', 'clutchWindow']);
  assert.ok(m.volley < 1 && m.volleyReach > 0);
  assert.ok(m.serveWindow > 1 && m.clutch > 1);
});
