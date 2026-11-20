// Conquistas: objetivos de longo prazo em todos os modos. Guardadas no telemóvel e copiadas para o perfil online.
export const ACH = [
  { id:'first_win',     title:'Primeira vitória',     text:'Ganha um jogo.' },
  { id:'first_ace',     title:'Ás!',                  text:'Faz o teu primeiro ás.' },
  { id:'aces5',         title:'Canhão',               text:'5 ases no mesmo jogo.' },
  { id:'fast_serve',    title:'Foguete',              text:'Serve a 170 km/h ou mais.' },
  { id:'rally20',       title:'Maratona',             text:'Ganha uma troca de 20 ou mais pancadas.' },
  { id:'rally40',       title:'Interminável',         text:'Uma troca de 40 pancadas.' },
  { id:'winners5',      title:'Mão pesada',           text:'5 vencedores no mesmo jogo.' },
  { id:'no_errors',     title:'Muralha',              text:'Ganha um jogo sem erros não forçados.' },
  { id:'shutout',       title:'Pneu',                 text:'Ganha um jogo 10–0.' },
  { id:'comeback',      title:'Reviravolta',          text:'Ganha depois de estar a perder por 5 pontos.' },
  { id:'beat_hard',     title:'Sem medo',             text:'Vence o CPU no Difícil.' },
  { id:'beat_hard_pro', title:'Sem rodinhas',         text:'Vence o Difícil com as ajudas em Pro.' },
  { id:'all_chars',     title:'Versátil',             text:'Ganha um jogo com cada um dos 7 tenistas.' },
  { id:'night_win',     title:'Debaixo dos projetores', text:'Ganha um jogo à noite.' },
  { id:'tour_champ',    title:'Campeão do Atlântico', text:'Ganha o Torneio Atlântico.' },
  { id:'online_win',    title:'Lição dada',           text:'Ganha um duelo online.' },
  { id:'online_10',     title:'Rei do grupo',         text:'10 vitórias online.' },
  { id:'challenge',     title:'Aplicado',             text:'Cumpre um desafio de treino.' },
  { id:'daily',         title:'Todos os dias',        text:'Faz o desafio do dia.' },
  { id:'daily7',        title:'Semana perfeita',      text:'Faz o desafio do dia 7 dias diferentes.' },
  { id:'career_title',  title:'Primeiro troféu',      text:'Ganha um torneio na carreira.' },
  { id:'career_top100', title:'Top 100',              text:'Entra no top 100 na carreira.' },
  { id:'career_top10',  title:'Top 10',               text:'Entra no top 10 na carreira.' },
  { id:'career_major',  title:'Grand Slam',           text:'Ganha um Grand Slam na carreira.' },
  { id:'career_no1',    title:'Número 1',             text:'Chega a número 1 do mundo.' },
];

export function createAchievements({ store, toast, sfx, online }) {
  let got = store.get('ach', {});                                   // id → data em que foi desbloqueada
  const listeners = [];
  const save = () => store.set('ach', got);
  function unlock(id) {
    if (got[id] || !ACH.find(a => a.id === id)) return false;
    got[id] = Date.now(); save();
    const a = ACH.find(x => x.id === id);
    setTimeout(() => { toast('Conquista: ' + a.title, 'gold', a.text, 2200); sfx.ui('win'); }, 700);
    listeners.forEach(f => f(id));
    sync();
    return true;
  }
  // contadores que precisam de memória (desafios do dia, tenistas com vitória)
  function bump(key, value) {
    const c = store.get('achc', {});
    if (value !== undefined) { const set = new Set(c[key] || []); set.add(value); c[key] = [...set]; } else c[key] = (c[key] || 0) + 1;
    store.set('achc', c);
    return Array.isArray(c[key]) ? c[key].length : c[key];
  }
  // fim de um jogo: ctx = { mode, won, level, help, me, opp, score:[mine,theirs], maxDeficit, char, night, onlineWins }
  function afterMatch(ctx) {
    const s = ctx.me || {};
    if (s.aces >= 1) unlock('first_ace');
    if (s.aces >= 5) unlock('aces5');
    if (s.fastestServe >= 170) unlock('fast_serve');
    if (s.winners >= 5) unlock('winners5');
    if (s.longestRallyWon >= 20) unlock('rally20');
    if (s.longestRally >= 40) unlock('rally40');
    if (!ctx.won) return;
    unlock('first_win');
    if (ctx.score[1] === 0) unlock('shutout');
    if (ctx.maxDeficit >= 5) unlock('comeback');
    if (s.errors === 0) unlock('no_errors');
    if (ctx.night) unlock('night_win');
    if ((ctx.mode === 'cpu' || ctx.mode === 'tour') && ctx.level >= 2) { unlock('beat_hard'); if (ctx.help === 'pro') unlock('beat_hard_pro'); }
    if (ctx.mode === 'online') { unlock('online_win'); if (bump('onlineWins') >= 10) unlock('online_10'); }
    if (ctx.char && bump('charWins', ctx.char) >= 7) unlock('all_chars');
  }
  function afterDaily(day) { unlock('daily'); if (bump('dailyDays', day) >= 7) unlock('daily7'); }
  // carreira: os marcos do motor da carreira
  function career(ms) {
    for (const m of ms || []) {
      if (m.id === 'firstTitle') unlock('career_title');
      if (m.id === 'top100') unlock('career_top100');
      if (m.id === 'top10') unlock('career_top10');
      if (m.id === 'firstMajor') unlock('career_major');
      if (m.id === 'no1') unlock('career_no1');
    }
  }
  // cópia no perfil online: junta as conquistas dos dois lados (nunca se perde nenhuma)
  let syncing = false, again = false;
  async function sync() {
    if (!online || !online.hasAccount()) return;
    if (syncing) { again = true; return; }
    syncing = true;
    try {
      const remote = await online.saveGet('achievements').catch(() => null);
      const merged = { ...((remote && remote.data) || {}), ...got };
      const changedLocal = Object.keys(merged).length !== Object.keys(got).length;
      got = merged; save();
      const changedRemote = !remote || Object.keys(merged).length !== Object.keys(remote.data || {}).length;
      if (changedRemote) await online.savePut('achievements', merged, null, remote ? remote.rev : 0, true);
      if (changedLocal) listeners.forEach(f => f(null));
    } catch (e) { /* sem rede: tenta na próxima */ }
    syncing = false;
    if (again) { again = false; sync(); }
  }
  return { unlock, afterMatch, afterDaily, career, sync, has:id => !!got[id], all:() => ACH.map(a => ({ ...a, at:got[a.id] || null })),
    count:() => Object.keys(got).filter(id => ACH.find(a => a.id === id)).length, onChange:f => listeners.push(f) };
}
