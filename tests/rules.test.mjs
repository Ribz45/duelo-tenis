import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HL, HW, SVC, BR, serverFor, serveSide, winner, isMatchOver, matchPointFor, servePositions, judgeFirstBounce, outBy } from '../rules.js';

const score = n => [Math.ceil(n / 2), Math.floor(n / 2)];

test('o primeiro serve 1 ponto e depois alternam de 2 em 2', () => {
  const seq = [];
  for (let n = 0; n < 11; n++) seq.push(serverFor(score(n), 0));
  assert.deepEqual(seq, [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1]);
  assert.equal(serverFor([0, 0], 1), 1);
  assert.equal(serverFor([1, 0], 1), 0);
});

test('o lado do serviço alterna a cada ponto, a começar pelo lado direito', () => {
  assert.equal(serveSide([0, 0]), 'deuce');
  assert.equal(serveSide([1, 0]), 'ad');
  assert.equal(serveSide([3, 3]), 'deuce');
});

test('ganha-se a 10 com 2 de vantagem', () => {
  assert.equal(winner([10, 8]), 0);
  assert.equal(winner([10, 9]), -1);
  assert.equal(winner([11, 9]), 0);
  assert.equal(winner([9, 11]), 1);
  assert.equal(winner([10, 10]), -1);
  assert.equal(winner([14, 12]), 0);
  assert.equal(isMatchOver([9, 7]), false);
  assert.equal(isMatchOver([10, 0]), true);
});

test('match point só quando o próximo ponto decide', () => {
  assert.equal(matchPointFor([9, 8]), 0);
  assert.equal(matchPointFor([8, 9]), 1);
  assert.equal(matchPointFor([9, 9]), -1);
  assert.equal(matchPointFor([10, 9]), 0);
  assert.equal(matchPointFor([3, 9]), 1);
  assert.equal(matchPointFor([8, 7]), -1);
});

test('posições de serviço: diagonal correta para os dois lados', () => {
  // ponto 0: serve o jogador 0 (lado +z) do seu lado direito (x > 0) para a caixa x < 0
  let p = servePositions([0, 0], 0);
  assert.equal(p.sv, 0); assert.ok(p.svPos.x > 0); assert.ok(p.svPos.z > HL); assert.equal(p.boxSign, -1); assert.ok(p.rcPos.z < -HL);
  // ponto 1: serve o jogador 1 (lado -z), lado esquerdo (vantagem). O lado direito dele é x < 0, logo o esquerdo é x > 0
  p = servePositions([1, 0], 0);
  assert.equal(p.sv, 1); assert.ok(p.svPos.x > 0); assert.equal(p.boxSign, -1); assert.ok(p.rcPos.z > HL);
  // ponto 2: o mesmo servidor muda para o lado direito (x < 0) e serve para x > 0
  p = servePositions([1, 1], 0);
  assert.equal(p.sv, 1); assert.ok(p.svPos.x < 0); assert.equal(p.boxSign, 1);
});

test('bola na linha conta como dentro; um milímetro fora é fora', () => {
  const r = { isServe:false, receiverSide:-1, boxSign:1 };
  assert.equal(judgeFirstBounce({ ...r, x:HW + BR - 0.001, z:-5 }), 'in');
  assert.equal(judgeFirstBounce({ ...r, x:HW + BR + 0.001, z:-5 }), 'out');
  assert.equal(judgeFirstBounce({ ...r, x:0, z:-(HL + BR - 0.001) }), 'in');
  assert.equal(judgeFirstBounce({ ...r, x:0, z:-(HL + 0.2) }), 'out');
  assert.equal(judgeFirstBounce({ ...r, x:0, z:3 }), 'out');   // ressalto do próprio lado
});

test('serviço: caixa certa, caixa errada, longo e linha do meio', () => {
  const s = { isServe:true, receiverSide:-1, boxSign:-1 };
  assert.equal(judgeFirstBounce({ ...s, x:-2, z:-5 }), 'in');
  assert.equal(judgeFirstBounce({ ...s, x:2, z:-5 }), 'fault');                // caixa errada
  assert.equal(judgeFirstBounce({ ...s, x:-2, z:-(SVC + 0.3) }), 'fault-long');
  assert.equal(judgeFirstBounce({ ...s, x:0, z:-3 }), 'in');                    // na linha do meio
  assert.equal(judgeFirstBounce({ ...s, x:-2, z:-(SVC + BR - 0.001) }), 'in');  // na linha de serviço
  assert.equal(judgeFirstBounce({ ...s, x:-2, z:1 }), 'fault');                 // não passou a rede
});

test('distância de uma bola fora à linha', () => {
  assert.ok(Math.abs(outBy(HW + BR + 0.1, 0) - 0.1) < 1e-9);
  assert.ok(Math.abs(outBy(0, HL + BR + 0.25) - 0.25) < 1e-9);
});
