// Modo carreira: ecrãs e ligação ao jogo. A lógica (ranking, calendário, torneios, evolução) está em career-engine.js.
// Um só ecrã (#careerScr) cujo conteúdo muda conforme a vista; guarda no telemóvel após cada jogo e copia para o perfil.
import * as E from './career-engine.js?v=13';

const KEY = 'dt_career';
const SURF = { hard:'Piso rápido', clay:'Terra batida', grass:'Relva' };

export function createCareer(G) {
  const $ = id => document.getElementById(id), esc = G.esc;
  const n = x => Number(x) || 0;
  const eur = x => n(x).toLocaleString('pt-PT') + ' €';
  let st = null, view = 'home', train = null, lastRewards = null, weekSummary = null, saving = false;
  let rev = Number(localStorage.getItem(KEY + '_rev') || 0);

  // ---------------------------------------------------------------- gravar
  function load() {
    try { const raw = localStorage.getItem(KEY); st = raw ? E.deserialize(raw) : null; } catch (e) { console.warn('carreira estragada', e); st = null; }
    return st;
  }
  function save(cloud) {
    if (!st) return;
    try { localStorage.setItem(KEY, E.serialize(st)); } catch (e) { G.toast('Sem espaço', 'bad', 'Não foi possível guardar a carreira', 2000); }
    if (cloud) pushCloud(false);
  }
  async function pushCloud(force) {
    if (!G.online.hasAccount() || saving || !st) return;
    saving = true;
    try {
      const r = await G.online.savePut('career', JSON.parse(E.serialize(st)), E.summary(st), rev, force);
      rev = r.rev; localStorage.setItem(KEY + '_rev', String(rev));
    } catch (e) {
      if (e.status === 409) {                                     // outro telemóvel guardou depois: fica a mais avançada
        const remote = await G.online.saveGet('career').catch(() => null);
        if (remote && progress(remote.data) > progress(st)) {
          if (confirm('Há uma carreira mais avançada noutro telemóvel. Usar essa?')) { st = E.deserialize(JSON.stringify(remote.data)); rev = remote.rev; localStorage.setItem(KEY + '_rev', String(rev)); save(false); render(); }
        } else if (remote) { rev = remote.rev; saving = false; return pushCloud(true); }
      }
    }
    saving = false;
  }
  const progress = s => s ? n(s.season) * 100 + n(s.week) : -1;

  // ---------------------------------------------------------------- abrir
  async function open() {
    load();
    if (!st && G.online.hasAccount()) {
      const remote = await G.online.saveGet('career').catch(() => null);
      if (remote && remote.data) { try { st = E.deserialize(JSON.stringify(remote.data)); rev = remote.rev; localStorage.setItem(KEY + '_rev', String(rev)); save(false); G.toast('Carreira recuperada', 'good', 'Do teu perfil online', 1800); } catch (e) {} }
    }
    if (!st) return renderNew();
    view = st.event ? 'event' : 'home'; render();
  }

  // ---------------------------------------------------------------- vistas
  const P = () => st.player;
  const eff = () => E.effectiveStats(st);
  const charFor = style => (style && G.charById(style).id === style ? style : 'tudo');
  function bars(stats) {
    return `<div class="ch-bars">${E.STATS.map(k => `<span class="bar"><em>${E.STAT_LABELS[k]}</em><i style="--v:${n(stats[k]) / 10}"></i><b>${n(stats[k])}</b></span>`).join('')}</div>`;
  }
  function header() {
    const p = P(), s = E.summary(st), xpNeed = n(E.levelInfo(st).need) || 1;
    return `<div class="me-card cr-head" data-act="grow">${G.avatar(p, 'lg')}<span class="mi"><b>${esc(p.name)}</b>
      <small>Nível ${n(p.level)} · ${eur(p.money)} · ranking <b class="tagc">#${n(s.rank)}</b></small>
      <span class="xpbar"><i style="--v:${Math.min(1, n(p.xp) / xpNeed)}"></i></span></span>
      ${n(p.attr) ? `<span class="badge">+${n(p.attr)}</span>` : ''}</div>`;
  }
  function render() {
    if (!st) return renderNew();
    const body = $('careerBody');
    if (view === 'home') body.innerHTML = renderHome();
    else if (view === 'event') body.innerHTML = renderEvent();
    else if (view === 'reward') body.innerHTML = renderReward();
    else if (view === 'week') body.innerHTML = renderWeek();
    else if (view === 'train') body.innerHTML = renderTrain();
    else if (view === 'grow') body.innerHTML = renderGrow();
    else if (view === 'rank') body.innerHTML = renderRank();
    else if (view === 'case') body.innerHTML = renderCase();
    G.show('careerScr'); body.scrollTop = 0; $('careerScr').scrollTop = 0;
  }
  function renderHome() {
    const opts = E.weekOptions(st), s = E.summary(st), rv = rivalInfo();
    return header() + `
      <div class="lob-h"><h2 style="text-align:left">Época ${n(st.season)}</h2><small>${n(st.week) >= 13 ? 'Finais da época' : 'Semana ' + n(st.week) + ' de 12'}</small></div>
      ${rv ? `<p class="muted cr-rival">Rival: <b>${esc(rv.name)}</b> · #${n(rv.rank)}${rv.h2h && (rv.h2h[0] || rv.h2h[1]) ? ` · frente a frente ${n(rv.h2h[0])}–${n(rv.h2h[1])}` : ''}</p>` : ''}
      ${st.weekDone && !st.event ? `<button class="primary" data-act="finishweek">Avançar para a semana seguinte</button>` : `<div class="field-l">Esta semana</div>
      <div class="cr-opts">${opts.map(o => optCard(o)).join('')}</div>`}
      <div class="row2"><button data-act="grow">Evolução${n(P().attr) ? ` <span class="badge">+${n(P().attr)}</span>` : ''}</button><button data-act="rank">Ranking</button></div>
      <div class="row2"><button data-act="case">Vitrine</button><button class="ghost" data-act="menu">Menu</button></div>`;
  }
  function optCard(o) {
    const train = o.kind === 'training', tier = E.TIERS[o.tier] || {};
    const sub = train ? 'Três desafios curtos · muita experiência' : `${esc(tier.label || o.tier)} · ${SURF[o.surface] || ''}${o.night ? ' · noite' : ''} · ${n(o.rounds)} rondas`;
    return `<button class="cr-opt${o.eligible ? '' : ' locked'}${o.tier === 'major' ? ' major' : ''}" data-act="enter" data-id="${esc(o.id)}" ${o.eligible ? '' : 'disabled'}>
      <span class="mi"><b>${esc(train ? 'Semana de treino' : o.name)}</b><small>${sub}</small>
      ${!o.eligible && o.reason ? `<small class="why">${esc(o.reason)}</small>` : ''}</span>
      ${o.wildcard ? '<span class="pill next">Convite</span>' : !train && o.eligible ? `<span class="pill ok">${n(tier.winnerPoints)} pts</span>` : ''}</button>`;
  }
  function rivalInfo() { try { return E.rivalInfo(st); } catch (e) { return null; } }
  function renderEvent() {
    const ev = st.event; if (!ev) { view = 'home'; return renderHome(); }
    const m = E.nextMatch(st), o = m.opp, tier = E.TIERS[ev.tier] || {};
    return header() + `
      <div class="cr-event${ev.tier === 'major' ? ' major' : ''}"><small>${esc(tier.label || '')} · ${SURF[ev.surface] || ''}${ev.night ? ' · noite' : ''}</small><h2>${esc(ev.name)}</h2>
      <p class="muted">${esc(m.roundName)}${m.bestOf === 3 ? ' · melhor de 3 tie-breaks' : ''}</p></div>
      ${m.lines ? `<div class="panel cr-lines">${m.lines.map(l => `<p>${esc(l)}</p>`).join('')}</div>` : ''}
      <div class="field-l">${m.isRival ? 'O teu rival' : 'Adversário'}</div>
      <div class="panel cr-opp${m.isRival ? ' rival' : ''}"><div class="ch-h">${G.avatar({ name:o.name, look:oppLook(o) }, '')}<span class="mi"><b>${esc(o.name)}</b>
        <small>${esc(o.country || '')} · #${n(o.rank)} · ${esc((E.STYLES[o.style] || {}).label || '')} · força ${n(o.total)}</small></span></div>${bars(o.stats)}
        <p class="muted" style="text-align:left;font-size:13px">Tu: força ${E.STATS.reduce((a, k) => a + n(eff()[k]), 0)}</p></div>
      <button class="primary" data-act="play">Jogar ${esc(m.roundName.toLowerCase())}</button>
      ${m.canSimulate ? '<button data-act="sim">Simular (metade da experiência)</button>' : ''}
      <button class="ghost" data-act="menu">Sair (a carreira fica guardada)</button>`;
  }
  function renderReward() {
    const r = lastRewards || {}, ms = r.milestones || [];
    const title = r.training ? 'Treino concluído' : r.champion ? 'Campeão!' : r.eliminated ? (r.won ? 'Vitória' : 'Eliminado') : r.won ? 'Vitória' : 'Derrota';
    return `<div class="result-icon">${G.icon(r.champion ? 'trophy' : r.won ? 'trophy' : 'ball')}</div><h2>${title}</h2>
      ${r.score ? `<div class="bigscore">${n(r.score[0])}<em>–</em>${n(r.score[1])}</div>` : ''}
      <div class="panel cr-gains">
        <div class="kv"><span>Experiência</span><b>+${n(r.xp)}</b></div>
        ${r.levelUps ? `<div class="kv"><span>Subiste de nível</span><b>+${n(r.attrGained)} pontos de atributo</b></div>` : ''}
        ${r.money ? `<div class="kv"><span>Prémio</span><b>+${eur(r.money)}</b></div>` : ''}
        ${r.points ? `<div class="kv"><span>Pontos de ranking</span><b>+${n(r.points)}</b></div>` : ''}
      </div>
      ${ms.map(m => `<div class="cr-ms">${G.icon('trophy')}<span class="mi"><b>${esc(m.title)}</b><small>${esc(m.text)}</small></span></div>`).join('')}
      <button class="primary" data-act="${st.event ? 'event' : 'finishweek'}">Continuar</button>`;
  }
  function renderWeek() {
    const w = weekSummary || {}, up = n(w.prevRank) - n(w.rank);
    return header() + `<h2>Ranking</h2>
      <div class="bigscore">#${n(w.rank)}</div>
      <p class="muted">${up > 0 ? `Subiste ${up} ${up === 1 ? 'lugar' : 'lugares'}` : up < 0 ? `Desceste ${-up} ${up === -1 ? 'lugar' : 'lugares'}` : 'Mantiveste o lugar'} · melhor de sempre #${n(w.bestRank)}</p>
      ${(w.milestones || []).map(m => `<div class="cr-ms">${G.icon('trophy')}<span class="mi"><b>${esc(m.title)}</b><small>${esc(m.text)}</small></span></div>`).join('')}
      ${(w.news || []).length ? `<div class="panel cr-news">${w.news.map(t => `<p>${esc(t)}</p>`).join('')}</div>` : ''}
      ${w.seasonEnded ? `<div class="cr-ms">${G.icon('trophy')}<span class="mi"><b>Fim da época ${n(st.season) - 1}</b><small>Começa a época ${n(st.season)}. Os pontos de há mais de 12 semanas caem.</small></span></div>` : ''}
      <button class="primary" data-act="home">Continuar</button>`;
  }
  function renderTrain() {
    const t = train;
    return header() + `<h2>Semana de treino</h2><p class="muted">Faz os três desafios (podes repetir). A experiência conta no fim.</p>
      ${t.list.map((c, i) => { const r = t.results[i]; return `<div class="panel cr-ch"><span class="mi"><b>${esc(c.label || G.objLabel(c))}</b><small>${esc(c.text || '')}</small>
        ${r ? `<small class="${r.passed ? 'ok' : 'why'}">${r.passed ? 'Cumprido' : 'Por cumprir'} · ${n(r.score)}/${n(r.goal)}</small>` : ''}</span>
        <button class="sm${r && r.passed ? '' : ' primary'}" data-act="trainplay" data-i="${i}">${r ? 'Repetir' : 'Jogar'}</button></div>`; }).join('')}
      <button class="primary" data-act="trainend">Terminar a semana</button>`;
  }
  function renderGrow() {
    const p = P(), e = eff(), C = E.COACHES, Gr = E.GEAR, canCoach = !E.canChangeCoach || E.canChangeCoach(st);
    return header() + `<h2>Evolução</h2>
      <div class="field-l">Atributos ${n(p.attr) ? `· ${n(p.attr)} ${n(p.attr) === 1 ? 'ponto' : 'pontos'} para gastar` : ''}</div>
      <div class="panel">${E.STATS.map(k => `<div class="cr-stat"><span>${E.STAT_LABELS[k]}</span><span class="bar"><i style="--v:${n(e[k]) / 10}"></i></span><b>${n(e[k])}</b>
        <button class="sm${n(p.attr) && n(p.stats[k]) < 10 ? ' primary' : ''}" data-act="spend" data-k="${k}" ${n(p.attr) && n(p.stats[k]) < 10 ? '' : 'disabled'}>+</button></div>`).join('')}</div>
      <div class="field-l">Treinador</div>
      <div class="cr-list">${Object.entries(C).map(([id, c]) => { const mine = p.coach === id, locked = c.unlockRank && E.summary(st).bestRank > c.unlockRank;
        return `<div class="panel cr-row${mine ? ' on' : ''}"><span class="mi"><b>${esc(c.label)}</b><small>+1 ${E.STAT_LABELS[c.stat] || ''} · ${esc(c.perk && c.perk.text || '')}</small>
        ${locked ? `<small class="why">Desbloqueia no top ${n(c.unlockRank)}</small>` : ''}${c.cost ? `<small>${eur(c.cost)}</small>` : ''}</span>
        <button class="sm${mine ? '' : ' primary'}" data-act="coach" data-id="${esc(id)}" ${mine || locked || !canCoach ? 'disabled' : ''}>${mine ? 'Contratado' : 'Contratar'}</button></div>`; }).join('')}</div>
      ${!canCoach ? '<p class="muted" style="font-size:13px">Só podes trocar de treinador na primeira semana de uma época.</p>' : ''}
      <div class="field-l">Material</div>
      <div class="cr-list">${Object.entries(Gr).map(([slot, gd]) => { const lv = n(p.gear && p.gear[slot]), max = lv >= (gd.max || 2);
        return `<div class="panel cr-row"><span class="mi"><b>${esc(gd.label || slot)} · nível ${lv}</b><small>+1 ${E.STAT_LABELS[gd.stat] || ''} por nível${gd.prices && !max ? ` · próximo ${eur(gd.prices[lv])}` : ''}</small></span>
        <button class="sm primary" data-act="gear" data-id="${esc(slot)}" ${max ? 'disabled' : ''}>${max ? 'Máximo' : 'Comprar'}</button></div>`; }).join('')}</div>
      <button class="ghost" data-act="${st.event ? 'event' : 'home'}">Voltar</button>`;
  }
  function renderRank() {
    const top = E.ranking(st, { limit:10 }), around = E.ranking(st, { around:true, limit:7 });
    const row = r => `<li class="${r.me ? 'me' : ''}${r.rival ? ' rv' : ''}"><span class="lr">${n(r.rank)}</span><span class="ln">${esc(r.name)}${r.rival ? ' · rival' : ''}</span><span class="lw">${esc(r.country || '')}</span><b>${n(r.points)}</b></li>`;
    const seen = new Set(top.map(r => r.id));
    return header() + `<h2>Ranking mundial</h2><ol class="ladder cr-rank">${top.map(row).join('')}${around.some(r => !seen.has(r.id)) ? '<li class="gap">…</li>' + around.filter(r => !seen.has(r.id)).map(row).join('') : ''}</ol>
      <button class="ghost" data-act="${st.event ? 'event' : 'home'}">Voltar</button>`;
  }
  function renderCase() {
    const p = P(), tr = st.trophies || p.trophies || [], s = E.summary(st), can = E.canRetire && E.canRetire(st);
    return header() + `<h2>Vitrine</h2>
      <div class="panel"><div class="kv"><span>Títulos</span><b>${n(s.titles)}</b></div><div class="kv"><span>Grand Slams</span><b>${n(s.majors)}</b></div>
        <div class="kv"><span>Melhor ranking</span><b>#${n(s.bestRank)}</b></div><div class="kv"><span>Épocas</span><b>${n(s.season)}</b></div></div>
      ${tr.length ? `<ul class="achs">${tr.slice().reverse().map(t => `<li class="got"><span class="ai">${G.icon('trophy')}</span><span class="mi"><b>${esc(t.name || t.title || '')}</b>
        <small>${esc(((E.TIERS[t.tier] || {}).label) || '')}${t.season ? ' · época ' + n(t.season) : ''}</small></span></li>`).join('')}</ul>` : '<p class="empty">Ainda sem troféus. O primeiro está à espera!</p>'}
      ${can ? '<button data-act="retire">Retirar e entrar no Hall da Fama</button>' : ''}
      <button class="ghost" data-act="${st.event ? 'event' : 'home'}">Voltar</button>`;
  }

  // criar o jogador
  let pick = { look:0, style:'tudo' };
  function renderNew() {
    const body = $('careerBody');
    const hof = G.store.get('hallOfFame', []);
    body.innerHTML = `<h2>Nova carreira</h2>
      <p class="muted">Começas em #200, num torneio de clube. Joga, ganha experiência e sobe até aos Grand Slams.</p>
      <input id="crName" maxlength="16" placeholder="O teu nome" value="${esc(G.myName() === 'Jogador' ? '' : G.myName())}" autocomplete="off">
      <div class="field-l" style="text-align:center">Equipamento</div>
      <div class="looks">${G.lookColors.map((c, i) => `<button type="button" class="lk${i === pick.look ? ' on' : ''}" data-act="look" data-i="${i}" style="--c:${c}"></button>`).join('')}</div>
      <div class="field-l">Estilo de jogo (começas fraco em tudo; o estilo diz para onde vais crescer)</div>
      <div class="chars">${Object.entries(E.STYLES).map(([id, s]) => `<button type="button" class="ch${id === pick.style ? ' on' : ''}" data-act="style" data-id="${id}">
        <span class="ch-h"><span class="mi"><b>${esc(s.label)}</b></span><i class="ch-ok">✓</i></span>${bars(E.statsFor(id, 15))}</button>`).join('')}</div>
      <button class="primary" data-act="create">Começar carreira</button>
      ${hof.length ? `<div class="field-l">Hall da Fama</div><ul class="achs">${hof.map(h => `<li class="got"><span class="ai">${G.icon('trophy')}</span><span class="mi"><b>${esc(h.name)}</b><small>${n(h.titles)} títulos · ${n(h.majors)} Grand Slams · melhor #${n(h.bestRank)} · ${n(h.legacyScore)} pts</small></span></li>`).join('')}</ul>` : ''}
      <button class="ghost" data-act="menu">Menu</button>`;
    G.show('careerScr');
  }

  // ---------------------------------------------------------------- jogar
  function oppLook(o) {
    let h = 0; for (const c of String(o.id || o.name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const mine = n(P().look), k = G.lookColors.length; let l = h % k; if (l === mine) l = (l + 1) % k; return l;
  }
  function playMatch() {
    const m = E.nextMatch(st), o = m.opp, ev = st.event, p = P();
    const coach = p.coach && E.COACHES[p.coach], perks = coach && coach.perk ? [coach.perk.id] : [];
    G.careerHooks.onMain = () => { view = st.event ? 'reward' : 'reward'; render(); };
    G.careerHooks.onExit = () => { view = 'reward'; render(); };
    G.startMatch({ mode:'career', me:0, names:[p.name, o.name], surface:ev.surface, level:1, cpuTotal:n(o.total), first:Math.random() < 0.5 ? 0 : 1,
      chars:[charFor(p.style), charFor(o.style)], stats:[eff(), o.stats], perks:[perks, []], looks:[n(p.look), oppLook(o)],
      bestOf:m.bestOf || 1, night:!!ev.night, career:{ tag:(ev.name + ' · ' + m.roundName).toUpperCase() } });
  }
  // fim de um jogo da carreira (chamado pelo jogo)
  function matchEnded({ won, score, sets, me, maxDeficit }) {
    if (!st || !st.event) return;
    const matchStats = { aces:n(me && me.aces), longestRally:n(me && me.longestRallyWon), winners:n(me && me.winners), comeback:n(maxDeficit) >= 5 };
    lastRewards = { ...E.recordMatch(st, { won, score, sets, matchStats }), won, score };
    G.ach.career(lastRewards.milestones);
    save(true);
    $('bEndMain').textContent = 'Continuar'; $('bEndMenu').textContent = 'Ver prémios';
  }
  function simulate() {
    const r = E.simulateMatch(st);
    lastRewards = { ...E.recordMatch(st, { won:r.won, score:r.score, sets:r.sets, simulated:true }), won:r.won, score:r.score };
    G.ach.career(lastRewards.milestones);
    save(true); view = 'reward'; render();
  }
  function finishWeek() {
    weekSummary = E.finishWeek(st);
    G.ach.career(weekSummary.milestones);
    save(true); view = 'week'; render();
  }
  function startTraining() {
    train = { list:E.trainingChallenges(st), results:[] };
    view = 'train'; render();
  }
  function playTraining(i) {
    const c = train.list[i], p = P();
    const coach = p.coach && E.COACHES[p.coach], perks = coach && coach.perk ? [coach.perk.id] : [];
    G.startChallenge({ id:c.id, kind:c.kind, goal:n(c.goal), zone:c.zone || (c.kind === 'serveTarget' ? 'T' : undefined), label:c.label, cpuTotal:Math.max(15, E.STATS.reduce((a, k) => a + n(eff()[k]), 0)),
      retryLabel:'Tentar outra vez', doneLabel:'Voltar ao treino',
      onDone:res => { const prev = train.results[i]; if (!prev || res.score > prev.score) train.results[i] = { id:c.id, score:res.score, goal:res.goal, passed:res.passed }; },
      onRetry:() => playTraining(i), onExit:() => { view = 'train'; render(); } },
      { char:charFor(p.style), stats:eff(), perks, looks:[n(p.look), (n(p.look) + 2) % G.lookColors.length] });
  }
  function endTraining() {
    const results = train.list.map((c, i) => train.results[i] || { id:c.id, score:0, goal:n(c.goal), passed:false });
    lastRewards = { ...E.recordTraining(st, { results }), won:results.some(r => r.passed), training:true };
    train = null; save(true); view = 'reward'; render();
  }

  // ---------------------------------------------------------------- toques
  document.addEventListener('click', e => {
    const b = e.target.closest('#careerScr [data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'menu') return G.goMenu();
    if (a === 'look') { pick.look = +b.dataset.i; const nm = $('crName').value; renderNew(); $('crName').value = nm; return; }
    if (a === 'style') { pick.style = b.dataset.id; const nm = $('crName').value; renderNew(); $('crName').value = nm; return; }
    if (a === 'create') {
      const name = ($('crName').value || '').trim() || G.myName();
      st = E.newCareer({ name, look:pick.look, style:pick.style, seed:(Math.random() * 2 ** 31) | 0 });
      rev = 0; localStorage.setItem(KEY + '_rev', '0'); save(true); view = 'home'; return render();
    }
    if (!st) return;
    if (a === 'home') { view = 'home'; return render(); }
    if (a === 'event') { view = st.event ? 'event' : 'home'; return render(); }
    if (a === 'grow') { view = 'grow'; return render(); }
    if (a === 'rank') { view = 'rank'; return render(); }
    if (a === 'case') { view = 'case'; return render(); }
    if (a === 'enter') {
      const id = b.dataset.id, opt = E.weekOptions(st).find(o => o.id === id); if (!opt || !opt.eligible) return;
      if (opt.kind === 'training') return startTraining();
      E.enterEvent(st, id); save(false); view = 'event'; return render();
    }
    if (a === 'play') return playMatch();
    if (a === 'sim') return simulate();
    if (a === 'finishweek') return finishWeek();
    if (a === 'trainplay') return playTraining(+b.dataset.i);
    if (a === 'trainend') return endTraining();
    if (a === 'spend') { E.spendAttr(st, b.dataset.k); save(false); return render(); }
    if (a === 'coach') { const r = E.hireCoach(st, b.dataset.id); if (r && !r.ok) G.toast('Não foi possível', 'bad', r.error || '', 1800); save(true); return render(); }
    if (a === 'gear') { const r = E.buyGear(st, b.dataset.id); if (r && !r.ok) G.toast('Não foi possível', 'bad', r.error || '', 1800); save(true); return render(); }
    if (a === 'retire') {
      if (!confirm('Retirar este jogador? A carreira termina e entra no Hall da Fama.')) return;
      const r = E.retire(st), hof = G.store.get('hallOfFame', []);
      hof.unshift({ name:P().name, ...E.summary(st), legacyScore:n(r && r.legacyScore) }); G.store.set('hallOfFame', hof.slice(0, 10));
      localStorage.removeItem(KEY); st = null; return renderNew();
    }
  });

  return { open, matchEnded, has:() => !!load(), summary:() => (load() ? E.summary(st) : null) };
}
