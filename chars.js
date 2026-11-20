// Tenistas selecionáveis: cinco atributos (1–10) que mudam a física do jogo. 6 = o jogo base.
// Todos os tenistas somam 30 pontos (justos no online); o jogador da carreira cresce para lá disso.
export const STATS = ['spd', 'rch', 'pow', 'srv', 'ctl'];
export const STAT_LABELS = { spd:'Velocidade', rch:'Alcance', pow:'Potência', srv:'Serviço', ctl:'Controlo' };

export const CHARACTERS = [
  { id:'tudo', name:'Tomás', nick:'Tudo-o-Terreno', style:'Equilibrado', look:0,
    stats:{ spd:6, rch:6, pow:6, srv:6, ctl:6 }, blurb:'Bom em tudo, sem pontos fracos. O melhor para aprender.' },
  { id:'canhao', name:'Inês', nick:'Canhão', style:'Grande serviço', look:1,
    stats:{ spd:4, rch:5, pow:7, srv:9, ctl:5 }, blurb:'Pontos de borla no serviço. Nas trocas longas sofre.' },
  { id:'muralha', name:'Duarte', nick:'Muralha', style:'Defensor', look:2,
    stats:{ spd:7, rch:9, pow:3, srv:4, ctl:7 }, blurb:'Devolve tudo. Ganha por cansar o adversário, não por força.' },
  { id:'relampago', name:'Mia', nick:'Relâmpago', style:'Velocidade', look:5,
    stats:{ spd:9, rch:6, pow:4, srv:5, ctl:6 }, blurb:'Chega a bolas impossíveis. Precisa de ângulos para acabar o ponto.' },
  { id:'artista', name:'Rafa', nick:'Artista', style:'Toque', look:4,
    stats:{ spd:5, rch:6, pow:4, srv:6, ctl:9 }, blurb:'Janela perfeita enorme, amortis e balões certeiros. Pouca velocidade de bola.' },
  { id:'martelo', name:'Leo', nick:'Martelo', style:'Potência', look:3,
    stats:{ spd:5, rch:5, pow:9, srv:6, ctl:5 }, blurb:'Cada pancada perfeita é um vencedor em potência. Erra mais.' },
  { id:'rede', name:'Sofia', nick:'Rede', style:'Ataque à rede', look:6, trait:'volley',
    stats:{ spd:6, rch:7, pow:5, srv:7, ctl:5 }, blurb:'Vólei seguro e com mais alcance. Sobe à rede e fecha o ponto.' },
];
export const charById = id => CHARACTERS.find(c => c.id === id) || CHARACTERS[0];

// atributos → multiplicadores da física (cada ponto acima/abaixo de 6 vale uns poucos %)
export function mods(stats = {}, perks = []) {
  const d = k => clamp((stats[k] ?? 6), 1, 12) - 6;
  const m = {
    speed:1 + 0.035 * d('spd'),          // corrida (6,2 m/s no 6)
    reach:0.07 * d('rch'),                // metros a mais/menos de alcance
    power:1 + 0.022 * d('pow'),           // velocidade das pancadas (±2,2 % por ponto: a potência já faz o CPU errar mais)
    serve:1 + 0.035 * d('srv'),           // velocidade do 1.º serviço
    serveAcc:1 - 0.04 * d('srv'),         // dispersão do serviço
    scatter:1 - 0.06 * d('ctl'),          // dispersão das pancadas
    window:1 + 0.04 * d('ctl'),           // janela de tempo "perfeito"
    serveWindow:1, clutch:1, drop:1, perfectBoost:0.22, volley:1, volleyReach:0,
  };
  for (const p of perks) {
    if (p === 'perfectServeWindow') m.serveWindow = 1.12;
    if (p === 'recovery') m.speed *= 1.03;
    if (p === 'clutchWindow') m.clutch = 1.15;
    if (p === 'dropControl') m.drop = 0.7;
    if (p === 'powerWinner') m.perfectBoost = 0.3;
    if (p === 'volley') { m.volley = 0.7; m.volleyReach = 0.18; }
  }
  return m;
}
export const total = stats => STATS.reduce((s, k) => s + (stats[k] || 0), 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
