// Regras e pontuação do Tie-break a 10 (funções puras, testadas em tests/rules.test.mjs).
// Medidas oficiais de um campo de singulares, em metros, até à aresta exterior das linhas.
export const HL = 11.885;      // meio comprimento (rede → linha de fundo)
export const HW = 4.115;       // meia largura de singulares
export const SVC = 6.40;       // rede → linha de serviço
export const BR = 0.035;       // raio da bola
export const POINTS_TO_WIN = 10;

const other = i => 1 - i;

// Quem serve: o primeiro serve 1 ponto, depois cada um serve 2 seguidos.
export function serverFor(score, first) {
  const n = score[0] + score[1];
  if (n === 0) return first;
  return Math.floor((n - 1) / 2) % 2 === 0 ? other(first) : first;
}

// Lado do serviço: total de pontos par → lado direito do servidor (iguais), ímpar → esquerdo (vantagem).
export const serveSide = score => ((score[0] + score[1]) % 2 === 0 ? 'deuce' : 'ad');

// Ganha quem chega a 10 com 2 pontos de vantagem.
export function winner(score) {
  const [a, b] = score;
  if (a >= POINTS_TO_WIN && a - b >= 2) return 0;
  if (b >= POINTS_TO_WIN && b - a >= 2) return 1;
  return -1;
}
export const isMatchOver = score => winner(score) !== -1;

// Jogador com match point (ganha se fizer o próximo ponto), ou -1.
export function matchPointFor(score) {
  for (const i of [0, 1]) { const s = score.slice(); s[i]++; if (winner(s) === i) return i; }
  return -1;
}

// Posições de serviço. O jogador 0 está no lado z > 0 (side = +1), o 1 no lado z < 0 (side = -1).
// O lado direito de um jogador virado para a rede é x * side > 0.
export function servePositions(score, first) {
  const sv = serverFor(score, first), rc = other(sv), ss = sv === 0 ? 1 : -1, rs = -ss;
  const sx = (serveSide(score) === 'deuce' ? 1 : -1) * ss * 0.9, boxSign = -Math.sign(sx);
  return { sv, rc, boxSign, svPos:{ x:sx, z:ss * (HL + 0.25) }, rcPos:{ x:boxSign * 2.5, z:rs * (HL + 0.5) } };
}

// Primeiro ressalto depois de uma pancada. A bola que toca na linha conta como dentro.
// receiverSide: +1/-1 (metade do campo de quem recebe) · boxSign: lado da caixa de serviço em x.
export function judgeFirstBounce({ x, z, isServe, receiverSide, boxSign }) {
  const onReceiverSide = Math.sign(z) === receiverSide;
  if (isServe) {
    const inBox = onReceiverSide && Math.abs(z) <= SVC + BR && Math.abs(x) <= HW + BR && x * boxSign >= -BR;
    if (inBox) return 'in';
    return onReceiverSide && Math.abs(z) > SVC + BR ? 'fault-long' : 'fault';
  }
  return onReceiverSide && Math.abs(z) <= HL + BR && Math.abs(x) <= HW + BR ? 'in' : 'out';
}

// Quanto é que uma bola fora falhou a linha (para o "uuuh" do público nas bolas por pouco).
export const outBy = (x, z) => Math.max(Math.abs(x) - HW - BR, Math.abs(z) - HL - BR);
