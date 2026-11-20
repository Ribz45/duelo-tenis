// Motor do modo Carreira (funções puras, testadas em tests/career.test.mjs). Desenho: docs/design-carreira-personagens.md §2–4.
// Sem DOM, sem localStorage, sem Date.now e sem Math.random: todo o acaso vem de um PRNG com semente (mulberry32)
// cujo estado vive em state.rng, por isso gravar e carregar a meio dá exatamente os mesmos resultados.
// O estado é JSON simples e fica abaixo de 64 KB mesmo ao fim de muitas épocas.
//
// Ciclo de uma semana:  weekOptions → enterEvent → (nextMatch → [jogar | simulateMatch] → recordMatch)* → finishWeek
//                  ou:  weekOptions → trainingChallenges → recordTraining → finishWeek

export const VERSION = 1;

/* ───────────── acaso com semente ───────────── */

// mulberry32 com o estado guardado num objeto ({ rng }) — normalmente o próprio estado da carreira.
function rnd(box) {
  const a = (box.rng + 0x6D2B79F5) >>> 0;
  box.rng = a;
  let t = Math.imul(a ^ (a >>> 15), a | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
// Gerador independente (função () → [0, 1)), por exemplo para statsFor(style, total, makeRng(7)).
export function makeRng(seed) { const box = { rng:seed >>> 0 }; return () => rnd(box); }
// Hash FNV-1a de vários valores (escolhas que não devem gastar o PRNG, p. ex. desafios de treino da semana).
function hash(...xs) {
  let h = 0x811C9DC5;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= 0x2F; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const rint = (box, n) => Math.floor(rnd(box) * n);
function shuffle(box, a) { for (let i = a.length - 1; i > 0; i--) { const j = rint(box, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sum = a => { let s = 0; for (const v of a) s += v; return s; };

/* ───────────── atributos e estilos ───────────── */

export const STATS = ['spd', 'rch', 'pow', 'srv', 'ctl'];
export const STAT_LABELS = { spd:'Velocidade', rch:'Alcance', pow:'Potência', srv:'Serviço', ctl:'Controlo' };
const shape = (spd, rch, pow, srv, ctl) => ({ spd, rch, pow, srv, ctl });
export const STYLES = {
  tudo:      { label:'Tudo-o-Terreno', shape:shape(6, 6, 6, 6, 6) },
  canhao:    { label:'Canhão',         shape:shape(4, 5, 7, 9, 5) },
  muralha:   { label:'Muralha',        shape:shape(7, 9, 3, 4, 7) },
  relampago: { label:'Relâmpago',      shape:shape(9, 6, 4, 5, 6) },
  artista:   { label:'Artista',        shape:shape(5, 6, 4, 6, 9) },
  martelo:   { label:'Martelo',        shape:shape(5, 5, 9, 6, 5) },
};
const STYLE_IDS = Object.keys(STYLES);
const OPPOSITE = { canhao:'muralha', muralha:'canhao', martelo:'artista', artista:'martelo', relampago:'tudo', tudo:'relampago' };
const shapeArr = style => STATS.map(k => (STYLES[style] || STYLES.tudo).shape[k]);
const toObj = a => ({ spd:a[0], rch:a[1], pow:a[2], srv:a[3], ctl:a[4] });

// Acerta os atributos s (array, alterado no sítio) para somarem `total`, mexendo um ponto de cada vez
// no atributo mais longe da forma do estilo (cada um entre 1 e 10).
function fitStats(s, style, total, jit) {
  const sh = shapeArr(style);
  const t = clamp(Math.round(total), 5, 50);
  const want = sh.map((v, i) => v * t / 30 + v * 1e-3 + (jit ? jit[i] : 0));
  let n = sum(s);
  while (n < t) {
    let b = -1;
    for (let i = 0; i < 5; i++) if (s[i] < 10 && (b < 0 || want[i] - s[i] > want[b] - s[b])) b = i;
    if (b < 0) break;
    s[b]++; n++;
  }
  while (n > t) {
    let b = -1;
    for (let i = 0; i < 5; i++) if (s[i] > 1 && (b < 0 || want[i] - s[i] < want[b] - s[b])) b = i;
    if (b < 0) break;
    s[b]--; n--;
  }
  return s;
}
function statsArr(style, total, rng) {
  const sh = shapeArr(style);
  const t = clamp(Math.round(total), 5, 50);
  const s = sh.map(v => clamp(Math.floor(v * t / 30), 1, 10));
  fitStats(s, style, t, rng ? sh.map(() => (rng() - 0.5) * 0.6) : null);
  if (rng && rng() < 0.4) { // pequena variação individual, mantendo a soma
    const i = Math.floor(rng() * 5), j = Math.floor(rng() * 5);
    if (i !== j && s[i] > 1 && s[j] < 10) { s[i]--; s[j]++; }
  }
  return s;
}
// Forma do estilo escalada para um total (cada atributo 1–10; a soma dá o total sempre que 5 ≤ total ≤ 50).
// rng opcional (função () → [0, 1)) dá pequenas variações individuais, como nos jogadores do circuito.
export function statsFor(style, total, rng) { return toObj(statsArr(style, total, rng)); }

/* ───────────── circuito ───────────── */

export const TIER_ORDER = ['futures', 'challenger', 't250', 't500', 'masters', 'major'];
// xp = fator de XP do escalão; bestOfFrom = ronda (índice) a partir da qual se joga à melhor de 3 tie-breaks.
export const TIERS = {
  futures:    { label:'Futuros',      draw:8,  rounds:3, minRank:null, winnerPoints:25,   prize:2000,   strength:[13, 20], bestOfFrom:null, xp:1 },
  challenger: { label:'Challenger',   draw:16, rounds:4, minRank:180,  winnerPoints:80,   prize:6000,   strength:[18, 25], bestOfFrom:null, xp:1.5 },
  t250:       { label:'Circuito 250', draw:16, rounds:4, minRank:100,  winnerPoints:250,  prize:20000,  strength:[23, 30], bestOfFrom:null, xp:2 },
  t500:       { label:'Circuito 500', draw:16, rounds:4, minRank:60,   winnerPoints:500,  prize:45000,  strength:[27, 34], bestOfFrom:null, xp:2.5 },
  masters:    { label:'Masters',      draw:32, rounds:5, minRank:30,   winnerPoints:1000, prize:100000, strength:[31, 38], bestOfFrom:null, xp:3 },
  major:      { label:'Grand Slam',   draw:32, rounds:5, minRank:20,   winnerPoints:2000, prize:250000, strength:[34, 42], bestOfFrom:3,    xp:4 },
  finals:     { label:'Finais',       draw:8,  rounds:3, minRank:8,    winnerPoints:1500, prize:200000, strength:[38, 44], bestOfFrom:2,    xp:5 },
};
// Fração dos pontos / prémio do vencedor conforme a ronda em que se perde, a contar do fim (final, meias, quartos, …).
const PTS_FRAC = [0.6, 0.36, 0.18, 0.09, 0.05, 0.02];
const PRIZE_FRAC = [0.6, 0.36, 0.2, 0.11, 0.06, 0.03];
const fracFor = (tab, rounds, won) => (won >= rounds ? 1 : tab[Math.min(rounds - 1 - won, tab.length - 1)]);
// Pontos de ranking / prémio (€) de quem ganhou `roundsWon` encontros num torneio do escalão (roundsWon = rounds → campeão).
export const eventPoints = (tier, roundsWon) => Math.max(1, Math.round(TIERS[tier].winnerPoints * fracFor(PTS_FRAC, TIERS[tier].rounds, roundsWon)));
export const eventPrize = (tier, roundsWon) => Math.round(TIERS[tier].prize * fracFor(PRIZE_FRAC, TIERS[tier].rounds, roundsWon) / 10) * 10;

export function roundName(rounds, r) {
  const fromEnd = rounds - 1 - r;
  if (fromEnd <= 0) return 'Final';
  if (fromEnd === 1) return 'Meias-finais';
  if (fromEnd === 2) return 'Quartos-de-final';
  if (r === 0) return 'Primeira ronda';
  return fromEnd === 3 ? 'Oitavos-de-final' : 'Segunda ronda';
}
const ROUND_IN = { 'Final':'na final', 'Meias-finais':'nas meias-finais', 'Quartos-de-final':'nos quartos-de-final',
  'Oitavos-de-final':'nos oitavos-de-final', 'Primeira ronda':'na primeira ronda', 'Segunda ronda':'na segunda ronda' };

export const SEASON_WEEKS = 12;
const MAJORS = {
  3:  { key:'atlantico', name:'Open do Atlântico', surface:'hard',  night:false },
  6:  { key:'terra',     name:'Taça da Terra',     surface:'clay',  night:false },
  9:  { key:'relva',     name:'Relva Real',        surface:'grass', night:false },
  12: { key:'cidade',    name:'Open da Cidade',    surface:'hard',  night:true },
};
const FINALS_EVENT = { tier:'finals', name:'Finais da Época', surface:'hard', night:true };
// Calendário fixo (repete-se todas as épocas, como no circuito a sério). [escalão, nome, piso, sessão noturna]
const WEEKS = {
  1:  [['futures', 'Futuros de Vila Alta', 'hard'], ['challenger', 'Challenger de Porto Claro', 'hard'], ['t250', 'Open de Valmonte', 'hard']],
  2:  [['futures', 'Futuros da Ribeira', 'hard'], ['t500', 'Open de Belcastro', 'hard', 1], ['masters', 'Masters de Solvane', 'hard']],
  3:  [['futures', 'Futuros do Mondego', 'clay'], ['challenger', 'Challenger de Nova Aurora', 'hard']],
  4:  [['futures', 'Futuros da Serra Fria', 'clay'], ['challenger', 'Challenger de Marisol', 'clay'], ['t500', 'Troféu de Rosenthal', 'clay']],
  5:  [['futures', 'Futuros das Dunas', 'clay'], ['t250', 'Taça de San Arcelo', 'clay'], ['masters', 'Masters de Altamar', 'clay']],
  6:  [['futures', 'Futuros do Vale Verde', 'hard'], ['t250', 'Open de Nordhaven', 'clay']],
  7:  [['futures', 'Futuros de Monte Azul', 'grass'], ['challenger', 'Challenger de Valbruma', 'grass'], ['masters', 'Masters de Vientos', 'hard']],
  8:  [['futures', 'Futuros de Santa Brisa', 'grass'], ['t250', 'Open de Port Lomond', 'grass'], ['t500', 'Open de Kaimana', 'grass']],
  9:  [['futures', 'Futuros do Pinhal', 'clay'], ['challenger', 'Challenger de Castelmar', 'grass']],
  10: [['futures', 'Futuros da Foz', 'hard'], ['t250', 'Troféu de Belavista', 'hard', 1], ['masters', 'Masters de Lunária', 'hard', 1]],
  11: [['futures', 'Futuros de Alvorada', 'clay'], ['challenger', 'Challenger de Mirabel', 'hard'], ['t500', 'Taça de Aurélia', 'hard', 1]],
  12: [['futures', 'Futuros de Pedra Alta', 'hard'], ['t250', 'Open de Kestrel Bay', 'hard']],
};
// Torneios de uma semana (1–12, ou 13 = Finais da Época).
export function weekEvents(week) {
  if (week === 13) return [{ ...FINALS_EVENT }];
  const list = (WEEKS[week] || []).map(([tier, name, surface, night]) => ({ tier, name, surface, night:!!night }));
  const mj = MAJORS[week];
  if (mj) list.push({ tier:'major', name:mj.name, surface:mj.surface, night:mj.night, major:mj.key });
  return list;
}
export const seasonCalendar = () => Array.from({ length:SEASON_WEEKS }, (_, i) => ({ week:i + 1, events:weekEvents(i + 1) }));

/* ───────────── material, treinadores, níveis ───────────── */

export const GEAR = {
  racket:  { label:'Raquete',    stat:'pow', max:2, prices:[6000, 30000], names:['Raquete de grafite', 'Raquete de competição'] },
  strings: { label:'Cordas',     stat:'ctl', max:2, prices:[4000, 20000], names:['Cordas multifilamento', 'Cordas de competição'] },
  shoes:   { label:'Sapatilhas', stat:'spd', max:2, prices:[5000, 25000], names:['Sapatilhas leves', 'Sapatilhas de competição'] },
};
// unlockRank: melhor ranking de sempre necessário. cost: contratação (paga uma vez).
export const COACHES = {
  fitness: { label:'Preparador físico',     stat:'spd', bonus:1, unlockRank:180, cost:8000,
    perk:{ id:'recovery', text:'Recuperas mais depressa para o centro depois de cada pancada.' } },
  serve:   { label:'Treinador de serviço',  stat:'srv', bonus:1, unlockRank:150, cost:15000,
    perk:{ id:'perfectServeWindow', text:'A janela do serviço perfeito fica 10 % maior.' } },
  touch:   { label:'Treinador de toque',    stat:'ctl', bonus:1, unlockRank:100, cost:30000,
    perk:{ id:'dropControl', text:'Os amortis caem mais curtos e mais certeiros.' } },
  power:   { label:'Treinador de potência', stat:'pow', bonus:1, unlockRank:60,  cost:60000,
    perk:{ id:'powerWinner', text:'As pancadas perfeitas saem ainda mais rápidas: mais winners.' } },
  mental:  { label:'Treinador mental',      stat:'rch', bonus:1, unlockRank:30,  cost:120000,
    perk:{ id:'clutchWindow', text:'Lês melhor o jogo e, nos pontos decisivos, a tua janela de tempo cresce.' } },
};
export const MAX_LEVEL = 60;
// XP para passar do nível `level` ao seguinte: ~1 nível por torneio no início, mais lento depois.
export const xpToNext = level => Math.round(100 + 40 * Math.pow(Math.max(0, level - 1), 1.5) * (1 + Math.max(0, level - 8) / 7));
const attrForLevel = level => (level % 5 === 0 ? 2 : 1);

export const MILESTONES = {
  firstWin:        { title:'Primeira vitória',       text:'Ganhaste o teu primeiro encontro no circuito. O primeiro de muitos!' },
  firstTitle:      { title:'Primeiro título',        text:'Levantaste o teu primeiro troféu. Já tens lugar na Vitrine!' },
  top100:          { title:'Top 100',                text:'Entraste no top 100 mundial. O Circuito 250 abre-te as portas.' },
  top50:           { title:'Top 50',                 text:'Já és um dos 50 melhores tenistas do mundo.' },
  top20:           { title:'Top 20',                 text:'Entraste no top 20: os Grand Slams esperam por ti.' },
  top10:           { title:'Top 10',                 text:'Estás entre os dez melhores tenistas do mundo.' },
  firstMajor:      { title:'Campeão de Grand Slam',  text:'Ganhaste o teu primeiro Grand Slam. Um sonho tornado realidade!' },
  no1:             { title:'Número 1 do mundo',      text:'Chegaste ao topo do ranking mundial. Ninguém está acima de ti.' },
  finalsQualified: { title:'Apurado para as Finais', text:'Acabaste a época no top 8: vais jogar as Finais da Época.' },
  careerSlam:      { title:'Grand Slam de carreira', text:'Ganhaste os quatro Grand Slams: Atlântico, Terra, Relva e Cidade.' },
};
function unlock(st, id, out, text) {
  if (st.milestones.includes(id)) return;
  st.milestones.push(id);
  out.push({ id, title:MILESTONES[id].title, text:text || MILESTONES[id].text });
}

/* ───────────── nomes inventados ───────────── */

const NAMES = {
  PT: [['Tiago', 'Hugo', 'Duarte', 'Rui', 'Nuno', 'Gonçalo', 'Vasco', 'Afonso', 'Rodrigo', 'Martim', 'Salvador', 'Lourenço', 'Bernardo', 'Simão', 'Henrique', 'Tomé'],
       ['Valente', 'Macedo', 'Quintela', 'Barroso', 'Seabra', 'Brandão', 'Amaral', 'Tavares', 'Morais', 'Lobato', 'Pimentel', 'Carvalhal', 'Teles', 'Meireles', 'Sampaio', 'Vilela', 'Gouveia', 'Peixoto', 'Antunes', 'Bettencourt']],
  BR: [['Caio', 'Murilo', 'Enzo', 'Davi', 'Heitor', 'Igor', 'Otávio', 'Renan', 'Breno', 'Vinícius'],
       ['Albuquerque', 'Bezerra', 'Cavalcanti', 'Damasceno', 'Figueiredo', 'Guimarães', 'Lacerda', 'Nogueira', 'Prado', 'Siqueira']],
  ES: [['Álvaro', 'Iker', 'Unai', 'Marcos', 'Sergio', 'Adrián', 'Jaime', 'Gonzalo', 'Rubén', 'Íñigo'],
       ['Arteaga', 'Belmonte', 'Cifuentes', 'Galarza', 'Iturbe', 'Lasarte', 'Montoya', 'Olmedo', 'Quiroga', 'Sarmiento', 'Urrutia', 'Villaverde']],
  FR: [['Théo', 'Mathis', 'Clément', 'Bastien', 'Maxime', 'Julien', 'Rémi', 'Baptiste', 'Loïc', 'Florian'],
       ['Fournier', 'Garnier', 'Lemaire', 'Marchand', 'Perrin', 'Rousseau', 'Vasseur', 'Morel', 'Chevalier', 'Lefèvre', 'Delorme', 'Barbier']],
  IT: [['Davide', 'Edoardo', 'Riccardo', 'Tommaso', 'Alessio', 'Gabriele', 'Niccolò', 'Pietro', 'Emanuele', 'Giacomo'],
       ['Bellandi', 'Ferraris', 'Gallo', 'Lombardi', 'Marchetti', 'Rinaldi', 'Testa', 'Vitale', 'Zanetti', 'Benedetti', 'Donati', 'Ferrante']],
  DE: [['Lukas', 'Jonas', 'Felix', 'Moritz', 'Leon', 'Finn', 'Niklas', 'Tobias', 'Malte', 'Henrik'],
       ['Brandt', 'Hartmann', 'Keller', 'Lindner', 'Neumann', 'Richter', 'Schäfer', 'Vogel', 'Winkler', 'Zimmermann', 'Kessler', 'Lorenz']],
  GB: [['Oliver', 'Harry', 'George', 'Charlie', 'Alfie', 'Freddie', 'Archie', 'Toby', 'Callum', 'Rory'],
       ['Ashworth', 'Bramley', 'Carrington', 'Fairclough', 'Hargreaves', 'Pemberton', 'Whitaker', 'Thornton', 'Lockwood', 'Kingsley']],
  US: [['Tyler', 'Cole', 'Brady', 'Hunter', 'Mason', 'Logan', 'Garrett', 'Chase', 'Wyatt', 'Dylan'],
       ['Caldwell', 'Donovan', 'Fletcher', 'Merritt', 'Prescott', 'Whitfield', 'Bradford', 'Calloway', 'Harrington', 'Sutton']],
  AR: [['Facundo', 'Joaquín', 'Valentín', 'Lautaro', 'Ignacio', 'Santino', 'Agustín', 'Bruno', 'Franco', 'Mateo'],
       ['Aranguren', 'Beltrán', 'Cabrera', 'Domínguez', 'Echagüe', 'Ferreyra', 'Gorostiaga', 'Ledesma', 'Maldonado', 'Rivarola', 'Villalba']],
  AU: [['Lachlan', 'Riley', 'Mitchell', 'Cooper', 'Hayden', 'Bailey', 'Flynn', 'Zac', 'Jarrah', 'Harvey'],
       ['Brennan', 'Callaghan', 'Dempsey', 'Ferris', 'Gallagher', 'McAllister', 'Rourke', 'Sheridan', 'Whitlock', 'Halloran']],
  JP: [['Haruto', 'Ren', 'Sora', 'Yuto', 'Kaito', 'Riku', 'Hiroki', 'Takumi', 'Kenta', 'Daiki'],
       ['Arakawa', 'Fujimoto', 'Hayashi', 'Ishida', 'Kobayashi', 'Matsuda', 'Nakagawa', 'Okada', 'Takeda', 'Yamaguchi']],
  SE: [['Elias', 'Isak', 'Viktor', 'Oskar', 'Linus', 'Albin', 'Hampus', 'Axel'],
       ['Lindqvist', 'Bergström', 'Holmberg', 'Sandberg', 'Ekström', 'Nyberg', 'Åkesson', 'Lundgren']],
  NL: [['Daan', 'Sem', 'Jesse', 'Thijs', 'Bram', 'Niels', 'Ruben', 'Stijn'],
       ['Bakker', 'de Groot', 'Hendriks', 'Kuipers', 'Mulder', 'Smit', 'Visser', 'Vermeulen', 'Dekker']],
  RS: [['Luka', 'Nikola', 'Stefan', 'Marko', 'Filip', 'Lazar', 'Vuk', 'Ognjen'],
       ['Jovanović', 'Marković', 'Pavlović', 'Stamenković', 'Milosavljević', 'Radić', 'Vasić', 'Đurić']],
  CZ: [['Jakub', 'Vojtěch', 'Ondřej', 'Matěj', 'Adam', 'Lukáš', 'Šimon'],
       ['Horák', 'Kučera', 'Procházka', 'Svoboda', 'Šimek', 'Krejčí', 'Bartoš', 'Holub', 'Pokorný', 'Růžička']],
  CL: [['Matías', 'Benjamín', 'Vicente', 'Cristóbal', 'Maximiliano'], ['Araya', 'Bustos', 'Cárdenas', 'Saavedra', 'Contreras', 'Riquelme']],
  CA: [['Liam', 'Noah', 'Ethan', 'Xavier', 'Olivier'], ['Beaulieu', 'Gagnon', 'Lavoie', 'Ouellet', 'Pelletier', 'Tremblay']],
  CH: [['Andri', 'Nico', 'Luca', 'Severin', 'Jonas'], ['Ammann', 'Brunner', 'Baumann', 'Steiner', 'Wyss']],
  NO: [['Magnus', 'Sander', 'Eirik', 'Håkon'], ['Haugen', 'Solberg', 'Dahl', 'Berge']],
};
const COUNTRY_POOL = ['PT', 'PT', 'PT', 'BR', 'BR', 'ES', 'ES', 'FR', 'FR', 'IT', 'IT', 'DE', 'GB', 'US', 'AR', 'AU', 'JP', 'SE', 'NL', 'RS', 'CZ', 'CL', 'CA', 'CH', 'NO'];
function genName(st, used) {
  for (let t = 0; t < 60; t++) {
    const c = COUNTRY_POOL[rint(st, COUNTRY_POOL.length)], [F, L] = NAMES[c];
    const n = F[rint(st, F.length)] + ' ' + L[rint(st, L.length)];
    if (!used.has(n)) { used.add(n); return { n, c }; }
  }
  const n = 'Jogador ' + st.nextId; used.add(n); return { n, c:'PT' };
}

/* ───────────── o circuito de 199 adversários ───────────── */

// Força (soma dos atributos) por posição no circuito: topo ~44, top 20 ~37, top 100 ~26, fundo ~13.
const CURVE = [[0, 44.5], [8, 40.5], [20, 37.5], [30, 35.5], [60, 31], [100, 26], [140, 22], [180, 17.5], [197, 13]];
function curveAt(i) {
  for (let k = 1; k < CURVE.length; k++) {
    const [x1, y1] = CURVE[k];
    if (i <= x1) { const [x0, y0] = CURVE[k - 1]; return y0 + (y1 - y0) * (i - x0) / (x1 - x0); }
  }
  return CURVE[CURVE.length - 1][1];
}
const FIELD = 199;
const zeros = () => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
// Registo compacto de um adversário: i id, n nome, c país, y estilo, s atributos [spd,rch,pow,srv,ctl], p pontos das últimas 12 semanas, a idade.
function newAI(st, used, style, total, age) {
  const { n, c } = genName(st, used);
  return { i:'p' + st.nextId++, n, c, y:style, s:statsArr(style, total, () => rnd(st)), p:zeros(), a:age };
}
const recOf = (st, id) => st.players.find(p => p.i === id) || null;
const aiTotal = p => sum(p.s);

export function effectiveStats(st) {
  const P = st.player, o = { ...P.stats };
  for (const slot in GEAR) o[GEAR[slot].stat] += P.gear[slot] || 0;
  if (P.coach && COACHES[P.coach]) o[COACHES[P.coach].stat] += COACHES[P.coach].bonus;
  for (const k of STATS) o[k] = clamp(o[k], 1, 10);
  return o;
}
const effTotal = st => { const e = effectiveStats(st); return e.spd + e.rch + e.pow + e.srv + e.ctl; };

// Ranking: pontos (soma das últimas 12 semanas); em caso de empate o jogador fica atrás, depois pela força.
function table(st) {
  const rows = st.players.map(p => ({ id:p.i, rec:p, pts:sum(p.p), total:aiTotal(p) }));
  rows.push({ id:'me', rec:null, pts:sum(st.player.pts), total:effTotal(st) });
  rows.sort((a, b) => b.pts - a.pts || (a.id === 'me') - (b.id === 'me') || b.total - a.total || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}
const myRank = st => table(st).findIndex(r => r.id === 'me') + 1;
const gateIndex = rank => { let g = 0; TIER_ORDER.forEach((t, i) => { const m = TIERS[t].minRank; if (m === null || rank <= m) g = i; }); return g; };

/* ───────────── encontros simulados ───────────── */

const ELO_D = 8;
// Probabilidade de ganhar um tie-break com `d` pontos de força a mais (estilo Elo).
export const winChance = d => 1 / (1 + Math.pow(10, -d / ELO_D));
const bestOf3 = p => p * p * (3 - 2 * p);
// Resultado realista de um tie-break a 10 (com 2 de vantagem) já sabendo quem ganha.
function tiebreak(st, won, d) {
  const q = 0.5 + 0.12 * Math.tanh(d / 6);
  for (let t = 0; t < 30; t++) {
    let a = 0, b = 0;
    while (!((a >= 10 || b >= 10) && Math.abs(a - b) >= 2) && a + b < 60) { if (rnd(st) < q) a++; else b++; }
    if ((a > b) === won) return [a, b];
  }
  return won ? [10, 7] : [7, 10];
}
function seedOrder(n) { let o = [1]; while (o.length < n) { const m = o.length * 2 + 1; o = o.flatMap(s => [s, m - s]); } return o; }

// Torneio só entre adversários (cabeças de série pela força). ents: [{ id|null (fantasma), total }].
function playField(st, ents, tier, name, pts, info) {
  const T = TIERS[tier];
  const [lo, hi] = T.strength;
  ents = ents.slice();
  while (ents.length < T.draw) ents.push({ id:null, total:lo + rnd(st) * (hi - lo) });
  const sorted = ents.slice().sort((a, b) => b.total - a.total);
  let list = seedOrder(T.draw).map(s => sorted[s - 1]);
  const won = new Map();
  for (let r = 0; r < T.rounds; r++) {
    const b3 = T.bestOfFrom !== null && r >= T.bestOfFrom, next = [];
    for (let i = 0; i < list.length; i += 2) {
      const a = list[i], b = list[i + 1];
      let p = winChance(a.total - b.total);
      if (b3) p = bestOf3(p);
      const w = rnd(st) < p ? a : b;
      if (w.id) won.set(w.id, r + 1);
      next.push(w);
    }
    list = next;
  }
  for (const e of ents) if (e.id) pts[e.id] = (pts[e.id] || 0) + eventPoints(tier, won.get(e.id) || 0);
  if (name && list[0].id && (tier === 'major' || tier === 'masters' || tier === 'finals')) info.champs.push({ id:list[0].id, event:name });
  if (ents.some(e => e.id === st.rival)) info.rival = { event:name, tier, won:won.get(st.rival) || 0, rounds:T.rounds };
}

// Semana do resto do circuito (barata): cada adversário joga um torneio da semana a que o ranking lhe dá
// acesso, ou descansa. Os grandes do calendário (Grand Slam, Masters, 500) ficam para os mais bem classificados;
// os restantes jogam o escalão mais alto da semana que podem (250 / Challenger / Futuros), em vários quadros
// paralelos pelo mundo fora. Segue o mesmo calendário que o jogador, por isso a corrida ao ranking é justa.
const REST = { t250:0.32, challenger:0.42, futures:0.5 };
const LOWER = ['t250', 'challenger', 'futures'];
function fieldWeek(st, week, myTier) {
  const pend = st.pending, pts = {}, info = { champs:[], rival:null };
  const rows = [];
  table(st).forEach((r, i) => { if (r.id !== 'me' && !(r.id in pend)) rows.push({ id:r.id, total:r.total, rank:i + 1 }); });
  if (week === 13) {
    if (myTier !== 'finals') playField(st, rows.slice(0, 8), 'finals', FINALS_EVENT.name, pts, info);
    return { pts, info };
  }
  const cal = weekEvents(week), has = t => cal.find(e => e.tier === t);
  const big = has('major') ? 'major' : has('masters') ? 'masters' : null;
  let pool = [];
  for (const r of rows) {
    const pr = r.rank <= 40 && big ? (big === 'major' ? 0.03 : 0.12) : r.rank <= 100 ? REST.t250 : r.rank <= 180 ? REST.challenger : REST.futures;
    if (rnd(st) >= pr) pool.push(r);
  }
  for (const t of ['major', 'masters', 't500']) {
    const e = has(t);
    if (!e || t === myTier) continue;
    playField(st, pool.slice(0, TIERS[t].draw), t, e.name, pts, info);
    pool = pool.slice(TIERS[t].draw);
  }
  const groups = { t250:[], challenger:[], futures:[] };
  for (const r of pool) {
    const g = gateIndex(r.rank);
    groups[LOWER.find(t => t === 'futures' || (TIER_ORDER.indexOf(t) <= g && has(t)))].push(r);
  }
  for (const t of LOWER) {
    const g = shuffle(st, groups[t]), n = TIERS[t].draw, e = has(t);
    for (let k = 0; k < g.length; k += n) playField(st, g.slice(k, k + n), t, k === 0 && e && t !== myTier ? e.name : null, pts, info);
  }
  return { pts, info };
}

/* ───────────── criar carreira ───────────── */

export function newCareer({ name, look = 0, style = 'tudo', seed = 1, country = 'PT' } = {}) {
  if (!STYLES[style]) style = 'tudo';
  name = String(name || 'Jogador').trim().slice(0, 24) || 'Jogador';
  const s0 = typeof seed === 'number' && Number.isFinite(seed) ? Math.floor(seed) >>> 0 : hash(seed);
  const st = {
    v:VERSION, seed:s0, rng:hash('carreira', s0),
    season:1, week:1,
    player:{ name, look, style, country, stats:statsFor(style, 15), level:1, xp:0, attr:0, money:0,
      gear:{ racket:0, strings:0, shoes:0 }, coach:null, pts:zeros() },
    players:[], nextId:1, rival:null, rivalEdge:1,
    rank:FIELD + 1, prevRank:FIELD + 1, bestRank:FIELD + 1,
    event:null, lastEvent:null, pending:{}, wkTier:null, wkNews:[], weekDone:null, weekWon:false, wildcard:false, finalsQ:false,
    titles:0, majors:0, finalsWon:0, weeksNo1:0, wins:0, losses:0, h2h:[0, 0],
    trophies:[], history:[], milestones:[], seasons:[], news:[],
    flags:{ final:false, major:false }, seasonStart:{ titles:0, majors:0 }, retired:false,
  };
  const used = new Set([name]);
  const styles = shuffle(st, Array.from({ length:FIELD - 1 }, (_, i) => STYLE_IDS[i % STYLE_IDS.length]));
  const recs = [];
  for (let i = 0; i < FIELD - 1; i++) recs.push(newAI(st, used, styles[i], clamp(Math.round(curveAt(i) + (rnd(st) - 0.5) * 2.4), 12, 45), 18 + rint(st, 15)));
  const rv = newAI(st, used, OPPOSITE[style], 16, 19);
  recs.push(rv);
  shuffle(st, recs);
  recs.forEach((p, k) => { p.i = 'p' + (k + 1); });
  st.players = recs;
  st.rival = rv.i;
  // uma época "anterior" só entre adversários, para o ranking já ter pontos a sério
  for (let w = 1; w <= 13; w++) {
    const { pts } = fieldWeek(st, w, null);
    for (const p of st.players) { if (w === 13) p.p[11] += pts[p.i] || 0; else p.p[w - 1] = pts[p.i] || 0; }
  }
  rv.p = rv.p.map((v, k) => (k >= 10 ? v : 0)); // o rival acabou de se tornar profissional, como tu
  st.rank = st.prevRank = st.bestRank = myRank(st);
  return st;
}

/* ───────────── semana: opções e inscrição ───────────── */

export function weekOptions(st) {
  if (st.retired) return [];
  const g = gateIndex(st.rank);
  const busy = st.event ? 'Estás a meio de um torneio.' : st.weekDone ? 'Já jogaste esta semana.' : null;
  const out = weekEvents(st.week).map(e => {
    const T = TIERS[e.tier];
    let eligible, reason = null, wildcard = false;
    if (e.tier === 'finals') {
      eligible = !!st.finalsQ;
      if (!eligible) reason = 'Só para o top 8 no fim da época.';
    } else {
      const ti = TIER_ORDER.indexOf(e.tier);
      if (ti <= g) eligible = true;
      else if (ti === g + 1 && st.wildcard) eligible = wildcard = true;
      else { eligible = false; reason = `Precisas de estar no top ${T.minRank} (estás em ${st.rank}.º).`; }
    }
    if (busy) { eligible = false; reason = busy; }
    return { id:`s${st.season}w${st.week}-${e.tier}`, kind:'event', tier:e.tier, label:T.label, name:e.name, surface:e.surface,
      night:e.night, rounds:T.rounds, draw:T.draw, eligible, reason, wildcard, points:T.winnerPoints, prize:T.prize };
  });
  out.push({ id:'training', kind:'training', tier:null, label:'Treino', name:'Semana de treino', surface:'hard', night:false,
    rounds:0, draw:0, eligible:!busy, reason:busy, wildcard:false, points:0, prize:0 });
  return out;
}

// Quadro "por força": o jogador fica numa posição ao acaso e os adversários mais fracos ficam no seu caminho
// das primeiras rondas, os mais fortes do outro lado (encontra-os mais tarde). pin = id a colocar no bloco `pinBlock`.
function pathDraw(st, picks, pin, pinBlock) {
  const n = picks.length + 1, m = rint(st, n);
  const keyed = picks.filter(p => p.id !== pin).map(p => ({ id:p.id, k:p.total + rnd(st) * 4 - 2 })).sort((a, b) => a.k - b.k);
  if (pin) keyed.splice(Math.min((1 << pinBlock) - 1, keyed.length), 0, { id:pin });
  const pos = new Array(n);
  pos[m] = 'me';
  for (let k = 0, idx = 0; (1 << k) < n; k++) {
    const size = 1 << k, start = ((m >> (k + 1)) << (k + 1)) + ((m >> k) & 1 ? 0 : size);
    shuffle(st, keyed.slice(idx, idx + size).map(o => o.id)).forEach((id, j) => { pos[start + j] = id; });
    idx += size;
  }
  return pos;
}

export function enterEvent(st, optionId) {
  const opt = weekOptions(st).find(o => o.id === optionId);
  if (!opt) throw new Error(`Opção desconhecida esta semana: ${optionId}`);
  if (opt.kind !== 'event') throw new Error('O treino faz-se com trainingChallenges() e recordTraining().');
  if (!opt.eligible) throw new Error(opt.reason || 'Não podes entrar neste torneio.');
  const T = TIERS[opt.tier], need = T.draw - 1;
  const tbl = table(st), ais = tbl.filter(r => r.id !== 'me');
  const rv = ais.find(r => r.id === st.rival);
  let picks, bracket;
  if (opt.tier === 'finals') {
    const ents = tbl.slice(0, T.draw); // os 8 primeiros do ranking, cabeças de série pela ordem
    if (!ents.some(r => r.id === 'me')) ents[T.draw - 1] = tbl.find(r => r.id === 'me');
    bracket = seedOrder(T.draw).map(s => ents[s - 1].id);
  } else {
    if (opt.tier === 'major' || opt.tier === 'masters') { // os melhores do ranking (quase todos jogam)
      const pr = opt.tier === 'major' ? 0.03 : 0.12;
      picks = [];
      for (const r of ais) { if (picks.length >= need) break; if (rnd(st) >= pr) picks.push(r); }
    } else { // adversários da força do escalão
      const [lo, hi] = T.strength;
      let cand = [];
      for (let w = 0; w <= 15; w++) { cand = ais.filter(r => r.id !== st.rival && r.total >= lo - w && r.total <= hi + w); if (cand.length >= need + 4) break; }
      picks = shuffle(st, cand).slice(0, need);
      if (rv && rv.total >= lo - 1 && rv.total <= hi + 1 && rnd(st) < 0.25) picks[rint(st, picks.length)] = rv;
    }
    let pin = null;
    if (opt.tier === 'major' && !st.flags.major && rv && rv.total >= T.strength[0] - 3) { // primeiro Grand Slam: o rival na tua metade
      if (!picks.includes(rv)) picks[picks.length - 1] = rv;
      pin = rv.id;
    }
    bracket = pathDraw(st, picks, pin, T.rounds - 2);
  }
  if (opt.tier === 'major') st.flags.major = true;
  st.event = { id:opt.id, tier:opt.tier, name:opt.name, surface:opt.surface, night:opt.night, round:0, rounds:T.rounds,
    draw:T.draw, bracket, adv:[], alive:true, results:[], wildcard:opt.wildcard };
  st.wkTier = opt.tier;
  if (opt.wildcard) st.wildcard = false;
  return st.event;
}

const roundList = ev => (ev.round === 0 ? ev.bracket : ev.adv[ev.round - 1]);
const RIVAL_LINES = [
  ['«Outra vez tu? Hoje não há surpresas.»', '«Vamos ver quem sai daqui a sorrir.»'],
  ['«Treinei a semana inteira para este encontro.»', '«Eu também. Que ganhe o melhor.»'],
  ['«A tua sorte acaba hoje.»', '«Não é sorte. É trabalho.»'],
  ['«O público veio ver-me a mim.»', '«Então vai ter um bom espetáculo.»'],
  ['«Lembras-te da última vez? Eu lembro-me.»', '«Desta vez vai ser diferente.»'],
];

export function nextMatch(st) {
  const ev = st.event;
  if (!ev || !ev.alive) return null;
  const list = roundList(ev), i = list.indexOf('me');
  if (i < 0) return null;
  const o = recOf(st, list[i ^ 1]), T = TIERS[ev.tier], total = aiTotal(o);
  const isRival = o.i === st.rival;
  const m = {
    opp:{ id:o.i, name:o.n, country:o.c, style:o.y, stats:toObj(o.s), total, rank:table(st).findIndex(r => r.id === o.i) + 1 },
    round:ev.round, rounds:ev.rounds, roundName:roundName(ev.rounds, ev.round),
    bestOf:T.bestOfFrom !== null && ev.round >= T.bestOfFrom ? 3 : 1,
    canSimulate:effTotal(st) - total >= 6, isRival,
    event:{ id:ev.id, tier:ev.tier, name:ev.name, surface:ev.surface, night:ev.night },
  };
  if (isRival) {
    const [a, b] = RIVAL_LINES[hash(st.seed, st.season, st.week, ev.round) % RIVAL_LINES.length];
    m.lines = [`${o.n}: ${a}`, `${st.player.name}: ${b}`];
  }
  return m;
}

// Simula o próximo encontro (não o regista: passa o resultado a recordMatch com simulated:true).
// bias = força extra do jogador (só para testes/equilíbrio). À melhor de 3, score = sets [meus, dele] e sets = tie-breaks.
export function simulateMatch(st, { bias = 0 } = {}) {
  const m = nextMatch(st);
  if (!m) throw new Error('Não há nenhum encontro por jogar.');
  const d = effTotal(st) + bias - m.opp.total, p = winChance(d);
  if (m.bestOf === 3) {
    const won = rnd(st) < bestOf3(p);
    let seq = [];
    for (let t = 0; t < 20; t++) {
      seq = [];
      let a = 0, b = 0;
      while (a < 2 && b < 2) { const w = rnd(st) < p; seq.push(w); if (w) a++; else b++; }
      if ((a > b) === won) break;
      seq = won ? [true, true] : [false, false];
    }
    const sets = seq.map(w => tiebreak(st, w, d));
    const a = seq.filter(Boolean).length;
    return { won, score:[a, seq.length - a], sets };
  }
  const won = rnd(st) < p;
  return { won, score:tiebreak(st, won, d) };
}

function playRound(st, ev, meWon) {
  const list = roundList(ev), T = TIERS[ev.tier], r = ev.adv.length;
  const b3 = T.bestOfFrom !== null && r >= T.bestOfFrom, next = [];
  for (let i = 0; i < list.length; i += 2) {
    const a = list[i], b = list[i + 1];
    if (a === 'me' || b === 'me') { next.push(meWon ? 'me' : a === 'me' ? b : a); continue; }
    let p = winChance(aiTotal(recOf(st, a)) - aiTotal(recOf(st, b)));
    if (b3) p = bestOf3(p);
    next.push(rnd(st) < p ? a : b);
  }
  ev.adv.push(next);
  ev.round = ev.adv.length;
}

// Primeira final da carreira: se for plausível, o adversário na final é o rival.
function reachFinal(st, ev) {
  if (st.flags.final) return;
  st.flags.final = true;
  const fin = ev.adv[ev.rounds - 2], other = fin[0] === 'me' ? fin[1] : fin[0];
  if (other === st.rival || ev.bracket.includes(st.rival)) return;
  const rv = recOf(st, st.rival);
  if (!rv || aiTotal(rv) < TIERS[ev.tier].strength[0] - 2) return;
  const swap = list => list.map(id => (id === other ? st.rival : id));
  ev.bracket = swap(ev.bracket);
  ev.adv = ev.adv.map(swap);
}

const nameOf = (st, id) => (id === 'me' ? st.player.name : (recOf(st, id) || { n:'?' }).n);
function rivalNews(st, r) {
  const rv = recOf(st, st.rival);
  if (!rv || !r) return null;
  const where = r.event ? ` (${r.event})` : ` num torneio ${TIERS[r.tier].label}`;
  return r.won >= r.rounds ? `O teu rival ${rv.n} foi campeão${where}.` : `O teu rival ${rv.n} perdeu ${ROUND_IN[roundName(r.rounds, r.won)]}${where}.`;
}
const HISTORY_MAX = 40;
function closeEvent(st, ev, champion, milestones) {
  const reach = new Map(ev.bracket.map(id => [id, 0]));
  ev.adv.forEach((list, r) => list.forEach(id => reach.set(id, r + 1)));
  for (const [id, k] of reach) st.pending[id] = eventPoints(ev.tier, k);
  const won = reach.get('me'), points = st.pending.me, money = eventPrize(ev.tier, won);
  st.player.money += money;
  st.history.push({ season:st.season, week:st.week, tier:ev.tier, name:ev.name, won, rounds:ev.rounds, points, champion });
  if (st.history.length > HISTORY_MAX) st.history.splice(0, st.history.length - HISTORY_MAX);
  if (champion) {
    st.titles++;
    st.weekWon = true;
    st.trophies.push({ season:st.season, week:st.week, tier:ev.tier, name:ev.name });
    unlock(st, 'firstTitle', milestones, `Campeão em ${ev.name}! O teu primeiro troféu já está na Vitrine.`);
    if (ev.tier === 'major') {
      st.majors++;
      unlock(st, 'firstMajor', milestones, `Ganhaste o ${ev.name}, o teu primeiro Grand Slam. Um sonho tornado realidade!`);
      const won4 = new Set(st.trophies.filter(t => t.tier === 'major').map(t => t.name));
      if (Object.values(MAJORS).every(mj => won4.has(mj.name))) unlock(st, 'careerSlam', milestones);
    }
    if (ev.tier === 'finals') st.finalsWon++;
  }
  const champId = ev.adv[ev.rounds - 1][0];
  if (!champion) st.wkNews.push(`${ev.name}: vitória de ${nameOf(st, champId)}.`);
  if (reach.has(st.rival)) st.wkNews.push(rivalNews(st, { event:ev.name, tier:ev.tier, won:reach.get(st.rival), rounds:ev.rounds }));
  // o último torneio fica guardado (quadro completo) para o ecrã de prémios
  st.lastEvent = { id:ev.id, tier:ev.tier, name:ev.name, surface:ev.surface, night:ev.night, rounds:ev.rounds, bracket:ev.bracket,
    adv:ev.adv, results:ev.results, won, champion, championId:champId, championName:nameOf(st, champId), points, money };
  st.event = null;
  st.weekDone = 'event';
  return { points, money };
}

function gainXP(st, xp) {
  const P = st.player;
  let levelUps = 0, attrGained = 0;
  P.xp += xp;
  while (P.level < MAX_LEVEL && P.xp >= xpToNext(P.level)) {
    P.xp -= xpToNext(P.level);
    P.level++;
    levelUps++;
    const g = attrForLevel(P.level);
    P.attr += g;
    attrGained += g;
  }
  return { levelUps, attrGained };
}

// Regista o encontro atual. res = { won, score, sets?, simulated?, matchStats?:{ aces, winners, longestRally, comeback, maxDeficit } }.
export function recordMatch(st, res = {}) {
  const ev = st.event;
  const m = nextMatch(st);
  if (!m) throw new Error('Não há nenhum encontro por jogar.');
  const won = !!res.won, sim = !!res.simulated, f = TIERS[ev.tier].xp, milestones = [];
  let xp = (won ? 100 : 40) * f * (m.bestOf === 3 ? 1.25 : 1) * (sim ? 0.5 : 1);
  const ms = res.matchStats;
  if (ms && !sim) {
    xp += Math.min(8, ms.aces | 0) * 5 * f + Math.min(10, ms.winners | 0) * 2 * f;
    if ((ms.longestRally | 0) >= 20) xp += 30 * f;
    if (won && (ms.comeback || (ms.maxDeficit | 0) >= 4)) xp += 40 * f;
  }
  const rec = { round:ev.round, roundName:m.roundName, opp:m.opp.id, name:m.opp.name, won, score:res.score || null, simulated:sim };
  if (res.sets) rec.sets = res.sets;
  ev.results.push(rec);
  if (won) st.wins++; else st.losses++;
  if (m.isRival) st.h2h[won ? 0 : 1]++;
  if (won) unlock(st, 'firstWin', milestones);
  playRound(st, ev, won);
  const champion = won && ev.round === ev.rounds, eliminated = !won;
  if (won && ev.round === ev.rounds - 1) reachFinal(st, ev);
  let money = 0, points = 0;
  if (eliminated || champion) {
    ev.alive = false;
    while (ev.adv.length < ev.rounds) playRound(st, ev, false);
    if (champion) xp += 100 * f;
    ({ money, points } = closeEvent(st, ev, champion, milestones));
  }
  xp = Math.round(xp);
  const lv = gainXP(st, xp);
  return { xp, levelUps:lv.levelUps, attrGained:lv.attrGained, level:st.player.level, money, points, eliminated, champion,
    milestones, round:m.round, roundName:m.roundName, isRival:m.isRival };
}

/* ───────────── treino ───────────── */

const TRAINING_KINDS = ['serveTarget', 'rally', 'winners', 'dropWinner', 'aces'];
export function trainingChallenges(st) {
  const t = clamp((st.player.level - 1) / 20, 0, 1), lerp = (a, b) => Math.round(a + (b - a) * t);
  const box = { rng:hash('treino', st.seed, st.season, st.week) };
  return shuffle(box, TRAINING_KINDS.slice()).slice(0, 3).map(kind => {
    if (kind === 'serveTarget') {
      const zone = rnd(box) < 0.5 ? 'T' : 'wide', goal = lerp(4, 8);
      return { id:kind, kind, zone, goal, attempts:10, label:zone === 'T' ? 'Serviço ao T' : 'Serviço aberto',
        text:`Coloca ${goal} de 10 primeiros serviços na zona ${zone === 'T' ? 'do T' : 'aberta, junto à linha lateral'}.` };
    }
    if (kind === 'rally') { const goal = lerp(10, 25); return { id:kind, kind, goal, label:'Troca de bolas', text:`Aguenta uma troca de ${goal} pancadas contra o treinador.` }; }
    if (kind === 'winners') { const goal = lerp(2, 6); return { id:kind, kind, goal, attempts:10, label:'Pancadas vencedoras', text:`Faz ${goal} pancadas vencedoras em 10 pontos.` }; }
    if (kind === 'dropWinner') return { id:kind, kind, goal:1, attempts:8, label:'Amorti', text:'Ganha um ponto com um amorti em 8 pontos.' };
    const goal = lerp(1, 5);
    return { id:kind, kind, goal, attempts:10, label:'Ases', text:`Serve ${goal} ${goal === 1 ? 'ás' : 'ases'} em 10 serviços.` };
  });
}

// XP de um título no escalão em que o jogador está (rondas × 100 × fator + bónus de campeão).
const titleXP = tier => (TIERS[tier].rounds + 1) * 100 * TIERS[tier].xp;
export function recordTraining(st, { results = [] } = {}) {
  if (st.event) throw new Error('Estás a meio de um torneio.');
  if (st.weekDone) throw new Error('Já jogaste esta semana.');
  let credit = 0;
  for (const r of results.slice(0, 3)) credit += r.passed ? 1 : 0.4 * clamp((Number(r.score) || 0) / (Number(r.goal) || 1), 0, 1);
  const xp = Math.round(titleXP(TIER_ORDER[gateIndex(st.rank)]) * (0.15 + 0.35 * credit / 3));
  st.weekDone = 'training';
  return { xp, ...gainXP(st, xp), level:st.player.level };
}

/* ───────────── fim de semana, épocas ───────────── */

function growRival(st, step) {
  const rv = recOf(st, st.rival);
  if (!rv) return;
  const t = aiTotal(rv), target = Math.min(44, effTotal(st) + st.rivalEdge);
  if (t < target) fitStats(rv.s, rv.y, Math.min(target, t + step));
}

// Entre épocas: todos fazem anos, os novos melhoram, os veteranos caem e alguns retiram-se (entram jovens).
// No fim a força volta a seguir a curva do circuito (pela nova ordem), para o topo continuar forte.
function ageField(st) {
  const used = new Set(st.players.map(p => p.n).concat(st.player.name));
  const scored = [];
  for (let k = 0; k < st.players.length; k++) {
    let p = st.players[k];
    if (p.i === st.rival) { p.a++; continue; }
    p.a++;
    let score;
    if (p.a >= 36 || (p.a >= 33 && rnd(st) < 0.35)) {
      used.delete(p.n);
      const y = STYLE_IDS[rint(st, STYLE_IDS.length)];
      p = st.players[k] = newAI(st, used, y, 14, 18 + rint(st, 2));
      score = 12 + rnd(st) * 6;
    } else {
      const t = aiTotal(p), r = rnd(st);
      score = t + (p.a <= 22 ? 0.5 + 2 * r : p.a <= 27 ? -0.3 + 1.4 * r : p.a <= 30 ? -1 + 1.2 * r : -0.5 - 1.8 * r) + rnd(st) - 0.5;
    }
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  scored.forEach(({ p }, i) => fitStats(p.s, p.y, clamp(Math.round(curveAt(i) + (rnd(st) - 0.5) * 2), 12, 45)));
}

function rollover(st) {
  st.seasons.push({ season:st.season, rank:st.rank, titles:st.titles - st.seasonStart.titles, majors:st.majors - st.seasonStart.majors });
  if (st.seasons.length > 30) st.seasons.shift();
  st.season++;
  st.week = 1;
  st.finalsQ = false;
  st.seasonStart = { titles:st.titles, majors:st.majors };
  ageField(st);
  st.rivalEdge = rint(st, 3);
  growRival(st, 2);
}

function writeWeek(st, week, pts) {
  const slot = week === 13 ? 11 : week - 1, pend = st.pending;
  const put = (arr, v) => { if (week === 13) arr[11] += v; else arr[slot] = v; };
  for (const p of st.players) put(p.p, (pts[p.i] || 0) + (pend[p.i] || 0));
  put(st.player.pts, pend.me || 0);
}

// Fecha a semana: resultados do resto do circuito, ranking, marcos, avanço de semana/época.
// Se ainda houver um torneio a meio, os encontros que faltam são simulados (meio XP).
export function finishWeek(st) {
  while (st.event) recordMatch(st, { ...simulateMatch(st), simulated:true });
  const week = st.week, prevRank = st.rank, milestones = [];
  const { pts, info } = fieldWeek(st, week, st.wkTier);
  writeWeek(st, week, pts);
  const news = st.wkNews.slice();
  for (const c of info.champs) news.push(`${c.event}: vitória de ${nameOf(st, c.id)}.`);
  if (info.rival) news.push(rivalNews(st, info.rival));
  st.pending = {};
  st.wkTier = null;
  st.wkNews = [];
  st.weekDone = null;
  st.wildcard = st.weekWon;
  st.weekWon = false;
  growRival(st, 1);
  let seasonEnded = false;
  st.rank = myRank(st);
  if (week === 12) {
    if (st.rank <= 8) {
      st.finalsQ = true;
      unlock(st, 'finalsQualified', milestones);
      st.week = 13;
    } else { // as Finais jogam-se sem ti
      const fin = fieldWeek(st, 13, null);
      writeWeek(st, 13, fin.pts);
      for (const c of fin.info.champs) news.push(`${c.event}: vitória de ${nameOf(st, c.id)}.`);
      st.rank = myRank(st);
      seasonEnded = true;
    }
  } else if (week === 13) seasonEnded = true;
  else st.week++;
  const rank = st.rank;
  if (rank < st.bestRank) st.bestRank = rank;
  if (rank === 1) st.weeksNo1++;
  for (const [id, lim] of [['top100', 100], ['top50', 50], ['top20', 20], ['top10', 10], ['no1', 1]]) if (rank <= lim) unlock(st, id, milestones);
  news.push(rank < prevRank ? `Estás em ${rank}.º lugar do ranking (subiste ${prevRank - rank}).`
    : rank > prevRank ? `Estás em ${rank}.º lugar do ranking (desceste ${rank - prevRank}).` : `Mantiveste o ${rank}.º lugar do ranking.`);
  if (seasonEnded) rollover(st);
  st.news = news.filter(Boolean).slice(-8);
  return { rank, prevRank, bestRank:st.bestRank, milestones, seasonEnded, news:st.news.slice(), season:st.season, week:st.week,
    points:sum(st.player.pts) };
}

/* ───────────── consultas ───────────── */

export function ranking(st, { limit = FIELD + 1, around = null } = {}) {
  const rows = table(st).map((r, i) => ({
    rank:i + 1, id:r.id, name:r.rec ? r.rec.n : st.player.name, country:r.rec ? r.rec.c : st.player.country,
    style:r.rec ? r.rec.y : st.player.style, points:r.pts, total:r.total, me:r.id === 'me', rival:r.id === st.rival,
  }));
  if (around) {
    const id = around === true ? 'me' : around, i = Math.max(0, rows.findIndex(r => r.id === id));
    const start = clamp(i - Math.floor(limit / 2), 0, Math.max(0, rows.length - limit));
    return rows.slice(start, start + limit);
  }
  return rows.slice(0, limit);
}

// Ficha de qualquer jogador do circuito (ou 'me').
export function getPlayer(st, id) {
  if (id === 'me') return { id, name:st.player.name, country:st.player.country, style:st.player.style, stats:effectiveStats(st), total:effTotal(st), points:sum(st.player.pts) };
  const p = recOf(st, id);
  return p && { id:p.i, name:p.n, country:p.c, style:p.y, stats:toObj(p.s), total:aiTotal(p), points:sum(p.p), age:p.a };
}
export function rivalInfo(st) {
  const p = getPlayer(st, st.rival);
  return p && { ...p, rank:table(st).findIndex(r => r.id === st.rival) + 1, h2h:st.h2h.slice() };
}
export const levelInfo = st => ({ level:st.player.level, xp:st.player.xp, need:xpToNext(st.player.level), attr:st.player.attr });
export const summary = st => ({ rank:st.rank, bestRank:st.bestRank, titles:st.titles, majors:st.majors, level:st.player.level, season:st.season, name:st.player.name });

/* ───────────── gastar: atributos, treinador, material ───────────── */

export function spendAttr(st, stat) {
  const P = st.player;
  if (!STATS.includes(stat)) return { ok:false, error:'Atributo desconhecido.' };
  if (P.attr <= 0) return { ok:false, error:'Não tens pontos para gastar.' };
  if (P.stats[stat] >= 10) return { ok:false, error:'Este atributo já está no máximo (10).' };
  P.stats[stat]++;
  P.attr--;
  return { ok:true };
}
export const canChangeCoach = st => !st.player.coach || (st.week === 1 && !st.event && !st.weekDone);
export function hireCoach(st, id) {
  const C = COACHES[id], P = st.player;
  if (!C) return { ok:false, error:'Treinador desconhecido.' };
  if (P.coach === id) return { ok:false, error:'Já trabalhas com este treinador.' };
  if (st.bestRank > C.unlockRank) return { ok:false, error:`Desbloqueias este treinador ao chegares ao top ${C.unlockRank}.` };
  if (!canChangeCoach(st)) return { ok:false, error:'Só podes trocar de treinador entre épocas (na 1.ª semana, antes de jogar).' };
  if (P.money < C.cost) return { ok:false, error:'Não tens dinheiro suficiente.' };
  P.money -= C.cost;
  P.coach = id;
  return { ok:true };
}
export const gearPrice = (st, slot) => (GEAR[slot] && st.player.gear[slot] < GEAR[slot].max ? GEAR[slot].prices[st.player.gear[slot]] : null);
export function buyGear(st, slot) {
  const G = GEAR[slot], P = st.player;
  if (!G) return { ok:false, error:'Material desconhecido.' };
  if (P.gear[slot] >= G.max) return { ok:false, error:'Já tens o melhor material deste tipo.' };
  const price = G.prices[P.gear[slot]];
  if (P.money < price) return { ok:false, error:'Não tens dinheiro suficiente.' };
  P.money -= price;
  P.gear[slot]++;
  return { ok:true };
}

/* ───────────── reforma, gravação ───────────── */

export const canRetire = st => !st.retired && st.season > 5;
export function retire(st) {
  if (!canRetire(st)) throw new Error('Só te podes retirar depois de 5 épocas completas.');
  const legacyScore = st.titles * 10 + st.majors * 50 + st.finalsWon * 30 + st.weeksNo1 * 5 + Math.max(0, 101 - st.bestRank) * 2;
  const entry = { name:st.player.name, look:st.player.look, style:st.player.style, country:st.player.country, seasons:st.season - 1,
    level:st.player.level, titles:st.titles, majors:st.majors, finalsWon:st.finalsWon, weeksNo1:st.weeksNo1, bestRank:st.bestRank,
    wins:st.wins, losses:st.losses, legacyScore };
  st.retired = true;
  return { legacyScore, entry, hallOfFame:entry };
}

export const serialize = st => JSON.stringify(st);
export function deserialize(str) {
  let st;
  try { st = JSON.parse(str); } catch { throw new Error('Gravação de carreira inválida.'); }
  if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error('Gravação de carreira inválida.');
  if (st.v !== VERSION) throw new Error(`Versão de gravação não suportada: ${st.v}.`);
  const ok = Number.isInteger(st.rng) && Number.isInteger(st.season) && Number.isInteger(st.week) && st.player && st.player.stats
    && Array.isArray(st.player.pts) && Array.isArray(st.players) && st.players.length === FIELD && typeof st.rival === 'string'
    && st.players.every(p => p && typeof p.i === 'string' && Array.isArray(p.s) && p.s.length === 5 && Array.isArray(p.p) && p.p.length === 12);
  if (!ok) throw new Error('Gravação de carreira inválida.');
  return st;
}
