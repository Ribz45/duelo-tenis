// Modo online: perfil, amigos, lobby com presença, convites dentro do jogo, estatísticas e ligação ao adversário.
// Servidor próprio (Cloudflare Worker, ver server/ e docs/online-api.md).
// Ligação durante o jogo: começa SEMPRE pelo relé do servidor (WebSocket, funciona em qualquer rede) e passa para
// ligação direta (WebRTC) quando as duas redes o permitem — nunca fica sem ligação por causa do tipo de rede.
import { API_BASE } from './config.js?v=13';

export function createOnline(G) {
  const $ = id => document.getElementById(id);
  const esc = G.esc;
  const S = {
    token:G.store.get('token', null), me:G.store.get('me', null), linkKey:G.store.get('linkKey', null),
    friends:[], requests:{ incoming:[], outgoing:[] }, record:null,
    ws:null, hubState:'off', backoff:1000, pingT:null, reT:null,
    out:null,                 // convite que enviei { id, to, exp }
    inc:null,                 // convite recebido em destaque { id, from, cfg, exp }
    link:null,                // ligação ao adversário durante o jogo
    ice:null, iceAt:0, statsFor:null, pendingFriend:null,
  };
  const enabled = () => !!API_BASE;
  const wsBase = () => API_BASE.replace(/^http/, 'ws');
  const SURF = { hard:'Piso rápido', clay:'Terra batida', grass:'Relva' };
  const n = x => Number(x) || 0;                     // números vindos do servidor, sempre como números no HTML

  // ---------------------------------------------------------------- HTTP
  async function api(path, { method = 'GET', body, timeout = 9000 } = {}) {
    if (!enabled()) throw Object.assign(new Error('Modo online ainda não está disponível.'), { code:'disabled' });
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
    try {
      const headers = {};
      if (body) headers['Content-Type'] = 'application/json';
      if (S.token) headers.Authorization = 'Bearer ' + S.token;
      const r = await fetch(API_BASE + path, { method, headers, body:body ? JSON.stringify(body) : undefined, signal:ctl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.message || 'Erro do servidor (' + r.status + ')'), { code:j.error || r.status, status:r.status });
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error('O servidor não respondeu. Verifica a internet.'), { code:'timeout' });
      if (e instanceof TypeError) throw Object.assign(new Error('Sem ligação ao servidor. Verifica a internet.'), { code:'network' });
      throw e;
    } finally { clearTimeout(t); }
  }
  const saveAccount = () => { G.store.set('token', S.token); G.store.set('me', S.me); G.store.set('linkKey', S.linkKey); };
  function signOut() {
    S.token = S.me = S.linkKey = null; saveAccount();
    S.friends = []; S.requests = { incoming:[], outgoing:[] }; S.record = null;
    try { S.ws && S.ws.close(); } catch (e) {}
    S.ws = null; clearTimeout(S.reT); refreshMenu();
  }

  // ---------------------------------------------------------------- conta
  async function register(name, look) {
    const r = await api('/api/register', { method:'POST', body:{ name, look } });
    S.token = r.token; S.me = r.user; S.linkKey = r.linkKey; saveAccount();
    G.setName(r.user.name);
    connectHub(); await loadMe().catch(() => {});
    flushReports();
  }
  async function loadMe() {
    try {
      const r = await api('/api/me');
      S.me = r.user; S.linkKey = r.linkKey; S.record = r.record; S.friends = r.friends || []; S.requests = r.requests || { incoming:[], outgoing:[] };
      saveAccount(); renderLobby(); refreshMenu();
      return r;
    } catch (e) {
      if (e.status === 401) { signOut(); G.toast('Sessão terminada', 'info', 'Cria o perfil outra vez ou entra com o código da conta', 2400); }
      throw e;
    }
  }
  async function updateMe(patch) {
    const r = await api('/api/me', { method:'PATCH', body:patch });
    S.me = r.user; saveAccount(); renderLobby(); refreshMenu();
  }

  // ---------------------------------------------------------------- lobby em tempo real (presença e convites)
  function connectHub() {
    if (!enabled() || !S.token || S.ws || !navigator.onLine) return;
    let ws;
    try { ws = new WebSocket(wsBase() + '/ws?token=' + encodeURIComponent(S.token)); } catch (e) { scheduleReconnect(); return; }
    S.ws = ws; setHub('connecting');
    ws.onopen = () => {
      S.backoff = 1000; setHub('on');
      clearInterval(S.pingT); S.pingT = setInterval(() => hubSend({ t:'ping' }), 25000);
      if (S.link) hubSend({ t:'status', s:'match' });
    };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onHub(m); };
    ws.onclose = ev => {
      clearInterval(S.pingT);
      if (S.ws === ws) S.ws = null;
      setHub('off');
      if (ev.code === 4001) return;                                     // demasiadas ligações abertas (outros separadores)
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }
  function scheduleReconnect() {
    if (!S.token) return;
    clearTimeout(S.reT);
    const d = Math.min(15000, S.backoff) * (0.7 + Math.random() * 0.6);
    S.backoff = Math.min(30000, S.backoff * 2);
    S.reT = setTimeout(connectHub, d);
  }
  const hubSend = m => { try { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(m)); return true; } } catch (e) {} return false; };
  function setHub(st) { S.hubState = st; renderHubState(); }
  addEventListener('online', () => { S.backoff = 1000; connectHub(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.token && !S.ws) { S.backoff = 1000; connectHub(); } });

  function friendById(id) { return S.friends.find(f => f.id === id); }
  function onHub(m) {
    switch (m.t) {
      case 'hello':
        if (m.me) { S.me = m.me; saveAccount(); }
        if (Array.isArray(m.friends)) S.friends = m.friends;
        renderLobby(); refreshMenu();
        break;
      case 'presence': {
        const f = friendById(m.id);
        if (f) { f.online = !!m.online; f.status = m.status || null; if (m.lastSeen) f.lastSeen = m.lastSeen; renderLobby(); refreshMenu(); }
        break;
      }
      case 'invite':
        if (G.inMatch() && (!S.link)) { /* a jogar contra o CPU: mostra na mesma, aceitar termina o jogo */ }
        showInvite(m);
        break;
      case 'invite-sent':
        if (!S.out) { hubSend({ t:'invite-cancel', id:m.id }); break; }      // cancelado antes de o servidor confirmar
        S.out = { id:m.id, to:m.to, exp:m.exp }; renderLobby(); break;
      case 'invite-failed': {
        S.out = null; renderLobby();
        const f = friendById(m.to), who = f ? f.name : 'O teu amigo';
        G.toast('Convite não enviado', 'info', m.reason === 'offline' ? who + ' não está online' : m.reason === 'busy' ? who + ' está a jogar' : 'Ainda não são amigos', 2000);
        break;
      }
      case 'invite-cancelled': if (S.inc && S.inc.id === m.id) hideInvite(); break;
      case 'invite-declined': {
        const f = S.out && friendById(S.out.to);
        S.out = null; renderLobby();
        G.toast('Desafio recusado', 'info', (f ? f.name : 'O teu amigo') + ' não pode jogar agora', 2000);
        break;
      }
      case 'invite-expired':
        if (S.inc && S.inc.id === m.id) hideInvite();
        if (S.out && S.out.id === m.id) { S.out = null; renderLobby(); }
        G.toast('Convite expirado', 'info', '', 1500);
        break;
      case 'match': hideInvite(); S.out = null; openRoom(m); break;
      case 'friend-request': G.toast('Pedido de amizade', 'good', (m.from && m.from.name || 'Alguém') + ' quer ser teu amigo', 2200); loadMe().catch(() => {}); break;
      case 'friend-added': G.toast('Novo amigo', 'good', (m.friend && m.friend.name || '') + ' já está na tua lista', 2000); loadMe().catch(() => {}); break;
      case 'friend-removed': loadMe().catch(() => {}); break;
    }
  }

  // ---------------------------------------------------------------- convites
  function invite(friendId) {
    if (!S.ws || S.ws.readyState !== 1) { G.toast('Sem ligação ao lobby', 'bad', 'A tentar outra vez…', 1600); connectHub(); return; }
    if (S.out) return;
    hubSend({ t:'invite', to:friendId, cfg:{ surface:G.surface() } });
    S.out = { id:null, to:friendId, exp:Date.now() + 30000 }; renderLobby();
  }
  function cancelInvite() { if (S.out && S.out.id) hubSend({ t:'invite-cancel', id:S.out.id }); S.out = null; renderLobby(); }
  let incTimer = null;
  function showInvite(m) {
    S.inc = m;
    const el = $('inviteBar'), f = m.from || {};
    el.querySelector('.av').replaceWith(avatar(f));
    el.querySelector('.iv-t').textContent = (f.name || 'Um amigo') + ' desafia-te';
    el.querySelector('.iv-s').textContent = (SURF[m.cfg && m.cfg.surface] || 'Piso rápido') + ' · tie-break a 10';
    el.classList.remove('hidden'); void el.offsetWidth; el.classList.add('show');
    G.sfx.ui('start'); G.buzz([40, 60, 40]);
    clearInterval(incTimer);
    const bar = el.querySelector('.iv-time i');
    const tick = () => {
      const left = (m.exp || Date.now()) - Date.now();
      bar.style.transform = `scaleX(${Math.max(0, left / 30000)})`;
      if (left <= 0) hideInvite();
    };
    tick(); incTimer = setInterval(tick, 250);
  }
  function hideInvite() {
    clearInterval(incTimer); S.inc = null;
    const el = $('inviteBar'); el.classList.remove('show'); setTimeout(() => { if (!S.inc) el.classList.add('hidden'); }, 250);
  }
  function replyInvite(accept) {
    if (!S.inc) return;
    const id = S.inc.id;
    if (!hubSend({ t:'invite-reply', id, accept })) { G.toast('Sem ligação ao lobby', 'bad', '', 1400); return; }
    if (!accept) hideInvite();
    else { $('inviteBar').querySelector('.iv-t').textContent = 'A entrar…'; }
  }

  // ---------------------------------------------------------------- ligação ao adversário (sala do jogo)
  function openRoom(m) {
    closeRoom(true);
    const L = S.link = { m, ws:null, pc:null, dc:null, useP2P:false, peer:false, started:false, closed:false, tries:0, pendingIce:[], leaveT:null, games:0 };
    hubSend({ t:'status', s:'match' });
    G.leaveForMatch();                                  // sai de um jogo contra o CPU, se estiver a decorrer
    $('connTitle').textContent = 'A ligar a ' + m.opp.name;
    $('connSub').textContent = 'A preparar o campo…';
    G.show('connScr');
    connectRoom(L);
    // se o adversário não aparecer, não fica preso para sempre
    L.joinT = setTimeout(() => { if (S.link === L && !L.started) lost('O teu amigo não entrou', 'O jogo não começou. Tenta desafiar outra vez.'); }, 20000);
  }
  function connectRoom(L) {
    let ws;
    try { ws = new WebSocket(wsBase() + '/ws/room/' + encodeURIComponent(L.m.matchId) + '?ticket=' + encodeURIComponent(L.m.ticket)); }
    catch (e) { return lost('Erro de ligação', 'Não foi possível abrir a sala do jogo.'); }
    L.ws = ws;
    ws.onopen = () => { L.tries = 0; };
    ws.onmessage = e => onFrame(L, e.data);
    ws.onclose = ev => {
      if (L.closed || S.link !== L || L.ws !== ws) return;      // socket antigo (já substituído por uma religação)
      L.ws = null;
      if (ev.code === 4003 || ev.code === 1008) return lost('Sala fechada', 'O convite já não é válido. Desafia outra vez.');
      if (L.tries++ < 5) { if (L.started) G.toast('A religar…', 'info', '', 1200); setTimeout(() => { if (!L.closed && S.link === L) connectRoom(L); }, 500 * L.tries); }
      else if (!(L.dc && L.dc.readyState === 'open')) lost('Ligação perdida', 'Perdeste a ligação ao teu amigo.');
    };
    ws.onerror = () => {};
  }
  function onFrame(L, data) {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m.$) {
      if (m.$ === 'room') { if (Array.isArray(m.peers) && m.peers.length) peerHere(L); }
      else if (m.$ === 'join') peerHere(L);
      else if (m.$ === 'leave') {
        L.peer = false; clearTimeout(L.leaveT);
        // dá uns segundos para o amigo voltar (rede do telemóvel a mudar, ecrã bloqueado…)
        L.leaveT = setTimeout(() => { if (S.link === L && !L.peer && !(L.dc && L.dc.readyState === 'open')) lost('Ligação terminada', 'O teu amigo saiu do jogo.'); }, 9000);
      }
      return;
    }
    if (m.t === 'rtc') { onRtc(L, m); return; }
    G.onNet(m);
  }
  function peerHere(L) {
    L.peer = true; clearTimeout(L.leaveT);
    sendWs(L, { t:'char', id:G.myChar ? G.myChar() : 'tudo' });               // o outro telemóvel fica a saber com que tenista jogo
    if (L.started) return;
    $('connSub').textContent = 'Os dois no campo · a afinar a ligação…';
    if (L.m.role === 'host') {
      startP2P(L);
      // espera um pouco pela ligação direta (mais rápida); se não abrir, joga pelo relé, que funciona sempre
      const t0 = Date.now();
      const go = () => {
        if (S.link !== L || L.started) return;
        if ((L.dc && L.dc.readyState === 'open') || Date.now() - t0 > 2500) { L.started = true; clearTimeout(L.joinT); G.hostStart(L.m); }
        else setTimeout(go, 100);
      };
      go();
    }
  }
  // chamada pelo jogo quando o convidado recebe 'start'
  function guestStarted() { const L = S.link; if (L) { L.started = true; clearTimeout(L.joinT); } }

  async function iceServers() {
    if (S.ice && Date.now() - S.iceAt < 30 * 60e3) return S.ice;
    try { const r = await api('/api/ice', { timeout:4000 }); if (Array.isArray(r.iceServers) && r.iceServers.length) { S.ice = r.iceServers; S.iceAt = Date.now(); return S.ice; } } catch (e) {}
    return [{ urls:'stun:stun.cloudflare.com:3478' }, { urls:'stun:stun.l.google.com:19302' }];
  }
  const sendWs = (L, obj) => { try { if (L.ws && L.ws.readyState === 1) { L.ws.send(JSON.stringify(obj)); return true; } } catch (e) {} return false; };
  async function makePc(L) {
    if (L.pc || !('RTCPeerConnection' in window)) return L.pc;
    const pc = L.pc = new RTCPeerConnection({ iceServers:await iceServers() });
    pc.onicecandidate = e => { if (e.candidate) sendWs(L, { t:'rtc', k:'ice', c:e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropP2P(L, pc); };
    pc.ondatachannel = e => wireDc(L, e.channel);
    return pc;
  }
  async function startP2P(L) {
    try {
      const pc = await makePc(L); if (!pc || L.closed) return;
      wireDc(L, pc.createDataChannel('game', { ordered:true }));
      await pc.setLocalDescription(await pc.createOffer());
      sendWs(L, { t:'rtc', k:'offer', d:pc.localDescription });
    } catch (e) { console.warn('P2P indisponível, a jogar pelo relé', e); }
  }
  async function onRtc(L, m) {
    try {
      if (m.k === 'offer') {
        const pc = await makePc(L); if (!pc) return;
        await pc.setRemoteDescription(m.d);
        await pc.setLocalDescription(await pc.createAnswer());
        sendWs(L, { t:'rtc', k:'answer', d:pc.localDescription });
        for (const c of L.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (m.k === 'answer') {
        if (L.pc) { await L.pc.setRemoteDescription(m.d); for (const c of L.pendingIce.splice(0)) await L.pc.addIceCandidate(c).catch(() => {}); }
      } else if (m.k === 'ice') {
        if (L.pc && L.pc.remoteDescription) await L.pc.addIceCandidate(m.c).catch(() => {});
        else L.pendingIce.push(m.c);
      }
    } catch (e) { console.warn('sinalização P2P', e); }
  }
  function wireDc(L, dc) {
    L.dc = dc;
    dc.onopen = () => { if (S.link === L) L.p2pReady = true; };
    dc.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.t !== 'rtc') G.onNet(m); };
    dc.onclose = () => { if (L.dc === dc) { L.dc = null; L.useP2P = false; } };
  }
  function dropP2P(L, pc) { if (L.pc === pc) { try { pc.close(); } catch (e) {} L.pc = null; L.dc = null; L.useP2P = false; } }
  // envio: direto quando já está aberto (só se troca entre pontos, para nunca trocar a ordem das mensagens a meio de um ponto)
  function send(obj) {
    const L = S.link; if (!L) return;
    const dcOpen = L.dc && L.dc.readyState === 'open';
    if (dcOpen && !L.useP2P && G.betweenPoints()) L.useP2P = true;
    if (!dcOpen) L.useP2P = false;
    const s = JSON.stringify(obj);
    if (L.useP2P) { try { L.dc.send(s); return; } catch (e) { L.useP2P = false; } }
    try { if (L.ws && L.ws.readyState === 1) L.ws.send(s); } catch (e) {}
  }
  const via = () => (S.link && S.link.useP2P ? 'direta' : 'servidor');
  function lost(title, text) { closeRoom(); G.netError(title, text); }
  function closeRoom(silent) {
    const L = S.link; if (!L) return;
    L.closed = true; S.link = null;
    clearTimeout(L.leaveT); clearTimeout(L.joinT);
    if (!silent) try { sendWs(L, { t:'bye' }); } catch (e) {}
    try { L.dc && L.dc.close(); } catch (e) {}
    try { L.pc && L.pc.close(); } catch (e) {}
    try { L.ws && L.ws.close(1000); } catch (e) {}
    hubSend({ t:'status', s:'lobby' });
  }

  // ---------------------------------------------------------------- resultados e estatísticas
  const pendingKey = 'pendingReports';
  function queueReport(r) { const q = G.store.get(pendingKey, []); q.push(r); G.store.set(pendingKey, q.slice(-40)); }
  async function flushReports() {
    if (!S.token || !navigator.onLine) return;
    const q = G.store.get(pendingKey, []); if (!q.length) return;
    const keep = [];
    for (const r of q) {
      try { await api('/api/matches', { method:'POST', body:r }); }
      catch (e) { if (!(e.status >= 400 && e.status < 500)) keep.push(r); }   // erros de validação não voltam a tentar
    }
    G.store.set(pendingKey, keep);
    if (q.length !== keep.length) loadMe().catch(() => {});
  }
  function reportMatch(r) { if (!S.token) return; queueReport(r); flushReports(); }

  // ---------------------------------------------------------------- gravações no perfil, desafio do dia, liga de amigos
  async function saveGet(key) { try { return await api('/api/save/' + key); } catch (e) { if (e.status === 404) return null; throw e; } }
  const savePut = (key, data, summary, base, force) => api('/api/save/' + key, { method:'PUT', body:{ base:base || 0, data, ...(summary ? { summary } : {}), ...(force ? { force:true } : {}) } });
  const dailyPost = (day, score, detail) => api('/api/daily', { method:'POST', body:{ day, score, detail } });
  const dailyGet = day => api('/api/daily?day=' + encodeURIComponent(day));
  async function renderLadder() {
    const el = $('lobbyLadder'); if (!el || !S.token) return;
    try {
      const r = await api('/api/ladder', { timeout:6000 });
      const rows = (r.players || []).slice(0, 12);
      el.classList.toggle('hidden', rows.length < 2);
      $('ladderList').innerHTML = rows.map((p, i) => `<li class="${p.me ? 'me' : ''}"><span class="lr">${i + 1}</span>${avHtml(p.user)}<span class="ln">${esc(p.user.name)}</span>
        <span class="lw">${n(p.w)}V–${n(p.l)}D</span><b>${n(p.elo)}</b></li>`).join('');
    } catch (e) { /* sem liga: fica escondida */ }
  }

  // ---------------------------------------------------------------- amigos
  async function addFriend(tag, key) {
    tag = String(tag || '').trim().toUpperCase().replace(/^#/, '');
    if (!/^[A-Z0-9]{5}$/.test(tag)) { G.toast('Código inválido', 'bad', 'O código de amigo tem 5 letras/números', 1800); return; }
    try {
      const r = await api('/api/friends', { method:'POST', body:key ? { tag, key } : { tag } });
      const who = r.user ? r.user.name : 'O teu amigo';
      if (r.status === 'friends') G.toast('Novo amigo', 'good', who + ' já está na tua lista', 2000);
      else if (r.status === 'requested') G.toast('Pedido enviado', 'info', who + ' tem de aceitar', 2000);
      else G.toast('Já são amigos', 'info', who, 1500);
      $('addTag').value = '';
      await loadMe();
    } catch (e) { G.toast(e.code === 'not_found' ? 'Código não encontrado' : e.code === 'self' ? 'Esse é o teu código' : 'Não foi possível adicionar', 'bad', e.code === 'not_found' ? 'Confirma as 5 letras com o teu amigo' : e.message, 2000); }
  }
  async function acceptFriend(id) { try { await api('/api/friends/' + encodeURIComponent(id) + '/accept', { method:'POST' }); await loadMe(); } catch (e) { G.toast('Erro', 'bad', e.message, 1600); } }
  async function removeFriend(id) { try { await api('/api/friends/' + encodeURIComponent(id), { method:'DELETE' }); await loadMe(); } catch (e) { G.toast('Erro', 'bad', e.message, 1600); } }
  const friendLink = () => S.me && S.linkKey ? location.origin + location.pathname + '#f=' + S.me.tag + '.' + S.linkKey : '';
  async function shareLink() {
    const url = friendLink(); if (!url) return;
    const text = 'Joga ténis comigo no Duelo Ténis! Abre o link e ficamos amigos no jogo:';
    if (navigator.share) { try { await navigator.share({ title:'Duelo Ténis', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(url); G.toast('Link copiado', 'good', 'Envia-o ao teu amigo (só é preciso uma vez)', 1800); }
    catch (e) { window.prompt('Copia o teu link de amigo:', url); }
  }
  // link de amigo aberto (#f=TAG.KEY): guarda-o até haver perfil
  function takeFriendHash() {
    const m = location.hash.match(/f=([A-Za-z0-9]{5})(?:\.([A-Za-z0-9_-]{4,16}))?/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    S.pendingFriend = { tag:m[1].toUpperCase(), key:m[2] || null };
    return true;
  }
  async function usePendingFriend() {
    const p = S.pendingFriend; if (!p || !S.token) return;
    S.pendingFriend = null;
    if (S.me && p.tag === S.me.tag) { G.toast('Este é o teu link', 'info', 'Envia-o a um amigo para ele te adicionar', 2200); return; }
    await addFriend(p.tag, p.key);
  }

  // ---------------------------------------------------------------- interface
  const lookColor = i => '#' + (G.looks[i] ?? G.looks[0]).toString(16).padStart(6, '0');
  function avatar(u, cls = '') {
    const s = document.createElement('span'); s.className = 'av ' + cls;
    s.style.setProperty('--c', lookColor(u && u.look || 0));
    s.textContent = ((u && u.name) || '?').trim().charAt(0).toUpperCase();
    return s;
  }
  const avHtml = (u, cls = '') => avatar(u, cls).outerHTML;
  function ago(ms) {
    if (!ms) return 'offline';
    const s = (Date.now() - ms) / 1000;
    if (s < 90) return 'visto agora';
    if (s < 3600) return 'visto há ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'visto há ' + Math.round(s / 3600) + ' h';
    const d = Math.round(s / 86400); return 'visto há ' + d + (d === 1 ? ' dia' : ' dias');
  }
  function renderHubState() {
    const el = $('lobbyConn'); if (!el) return;
    const st = S.hubState;
    el.className = 'conn ' + st;
    el.lastElementChild.textContent = st === 'on' ? 'Online' : st === 'connecting' ? 'A ligar…' : navigator.onLine ? 'A religar…' : 'Sem internet';
  }
  function renderLobby() {
    if (!S.me) return;
    const me = S.me, rec = S.record;
    $('lobbyMe').innerHTML = `${avHtml(me, 'lg')}<span class="mi"><b>${esc(me.name)}</b><small>Código de amigo <span class="tagc">${esc(me.tag)}</span></small>
      ${rec ? `<small>Online ${n(rec.online.w)}V – ${n(rec.online.l)}D · CPU ${n(rec.cpu.w)}V – ${n(rec.cpu.l)}D</small>` : ''}</span>`;
    renderHubState();
    // pedidos de amizade
    const inc = S.requests.incoming || [], outR = S.requests.outgoing || [];
    $('lobbyReq').classList.toggle('hidden', !inc.length && !outR.length);
    $('lobbyReqList').innerHTML = inc.map(u => `<li class="fr">${avHtml(u)}<span class="fi"><b>${esc(u.name)}</b><small>quer ser teu amigo</small></span>
        <button class="sm" data-decline="${esc(u.id)}" aria-label="Recusar">✕</button><button class="sm primary" data-accept="${esc(u.id)}">Aceitar</button></li>`).join('')
      + outR.map(u => `<li class="fr dim">${avHtml(u)}<span class="fi"><b>${esc(u.name)}</b><small>pedido enviado · à espera</small></span>
        <button class="sm" data-decline="${esc(u.id)}">Cancelar</button></li>`).join('');
    // amigos: online primeiro
    const fr = S.friends.slice().sort((a, b) => (b.online - a.online) || ((b.status === 'lobby') - (a.status === 'lobby')) || a.name.localeCompare(b.name));
    const online = fr.filter(f => f.online).length;
    $('lobbyCount').textContent = fr.length ? online + ' online · ' + fr.length + (fr.length === 1 ? ' amigo' : ' amigos') : '';
    $('lobbyEmpty').classList.toggle('hidden', fr.length > 0);
    $('lobbyFriends').innerHTML = fr.map(f => {
      const waiting = S.out && S.out.to === f.id;
      const busy = f.online && f.status === 'match';
      const st = f.online ? (busy ? 'A jogar' : 'No lobby') : ago(f.lastSeen);
      const h2h = (f.h2h && (f.h2h.w || f.h2h.l) ? ` · ${n(f.h2h.w)}–${n(f.h2h.l)}` : '') + (f.career && f.career.rank ? ` · carreira #${n(f.career.rank)}` : '');
      const btn = waiting ? `<button class="sm wait" data-cancel="1">À espera… ✕</button>`
        : f.online && !busy ? `<button class="sm primary" data-invite="${esc(f.id)}">Desafiar</button>`
        : `<button class="sm" disabled>${busy ? 'A jogar' : 'Offline'}</button>`;
      return `<li class="fr${f.online ? '' : ' dim'}" data-profile="${esc(f.id)}">${avHtml(f)}<span class="fi"><b>${esc(f.name)}</b>
        <small><i class="st ${f.online ? (busy ? 'busy' : 'on') : 'off'}"></i>${st}${h2h}</small></span>${btn}</li>`;
    }).join('');
    $('myTag').textContent = me.tag;
  }
  function refreshMenu() {
    const has = !!S.me;
    $('menuMe').classList.toggle('hidden', !has);
    $('nameIn').classList.toggle('hidden', has);
    if (has) {
      $('menuMe').innerHTML = `${avHtml(S.me)}<span class="mi"><b>${esc(S.me.name)}</b><small>${S.record ? n(S.record.online.w) + 'V – ' + n(S.record.online.l) + 'D online' : 'O meu perfil'}</small></span><svg class="i"><use href="#i-chev"/></svg>`;
    }
    const nOn = S.friends.filter(f => f.online).length;
    const b = $('friendsOnline'); b.textContent = nOn ? nOn + ' online' : ''; b.classList.toggle('hidden', !nOn);
  }

  // perfil: criar
  let pickedLook = 0;
  function renderLooks() {
    $('profLooks').innerHTML = G.looks.map((c, i) => `<button type="button" class="lk${i === pickedLook ? ' on' : ''}" data-look="${i}" style="--c:${lookColor(i)}" aria-label="Equipamento ${i + 1}"></button>`).join('');
  }
  function openProfileSetup() {
    if (!enabled()) { G.netError('Modo online em preparação', 'O servidor do modo online ainda não está ligado. Podes jogar contra o CPU ou o torneio.'); return; }
    $('profName').value = G.myName() === 'Jogador' ? '' : G.myName();
    $('profMsg').textContent = '';
    renderLooks(); G.show('profScr');
  }
  async function createProfile() {
    const name = $('profName').value.trim();
    if (!name) { $('profMsg').textContent = 'Escreve o teu nome.'; $('profName').focus(); return; }
    const b = $('bProfCreate'); b.disabled = true; $('profMsg').textContent = 'A criar…';
    try { await register(name, pickedLook); $('profMsg').textContent = ''; await usePendingFriend(); openLobby(); }
    catch (e) { $('profMsg').textContent = e.code === 'rate_limited' ? 'Muitas contas criadas nesta rede. Tenta mais tarde.' : e.message; }
    finally { b.disabled = false; }
  }
  // entrar noutro telemóvel com o código da conta
  async function login() {
    const code = $('loginCode').value.replace(/[\s-]/g, '').toUpperCase();
    if (code.length < 20) { $('loginMsg').textContent = 'O código da conta tem 26 letras e números.'; return; }
    const old = S.token; S.token = code; $('loginMsg').textContent = 'A entrar…';
    try { await loadMe(); G.setName(S.me.name); connectHub(); flushReports(); await usePendingFriend(); openLobby(); }
    catch (e) { S.token = old; saveAccount(); $('loginMsg').textContent = e.status === 401 ? 'Código errado. Confirma no outro telemóvel (Perfil → Código da conta).' : e.message; }
  }
  function openLobby() {
    if (!enabled()) { G.netError('Modo online em preparação', 'O servidor do modo online ainda não está ligado. Podes jogar contra o CPU ou o torneio.'); return; }
    if (!S.token) { openProfileSetup(); return; }
    renderLobby(); G.show('lobbyScr'); renderLadder();
    connectHub(); loadMe().catch(e => { if (e.code !== 'network' && e.code !== 'timeout') return; G.toast('Sem ligação', 'bad', 'A mostrar a última lista guardada', 1600); });
  }

  // estatísticas (minhas ou de um amigo, com o frente-a-frente)
  async function openStats(id) {
    S.statsFor = id || null;
    const mine = !id || (S.me && id === S.me.id);
    $('statsHead').innerHTML = '<p class="muted">A carregar…</p>'; $('statsBody').innerHTML = ''; $('statsRecent').innerHTML = '';
    $('statsAccount').classList.toggle('hidden', !mine); $('bRemoveFriend').classList.toggle('hidden', mine);
    $('acctCode').textContent = '•••• •••• •••• ••••'; $('acctCode').dataset.shown = '';
    G.show('statsScr');
    try {
      let user, rec, h2h = null, recent = [];
      if (mine) { const r = await loadMe(); user = r.user; rec = r.record; recent = (await api('/api/matches?limit=10')).matches || []; }
      else { const r = await api('/api/users/' + encodeURIComponent(id)); user = r.user; rec = r.record; h2h = r.h2h; recent = r.recent || []; }
      if (S.statsFor !== (id || null)) return;
      renderStats(user, rec, h2h, recent, mine);
    } catch (e) { $('statsHead').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  }
  function renderStats(user, rec, h2h, recent, mine) {
    const T = rec.totals || {}, pct = (n, d) => d ? Math.round(100 * n / d) + '%' : '–';
    const games = n(rec.online.w) + n(rec.online.l) + n(rec.cpu.w) + n(rec.cpu.l);
    $('statsHead').innerHTML = `<div class="ph">${avHtml(user, 'xl')}<h2>${esc(user.name)}</h2><span class="tagc">${esc(user.tag)}</span></div>`
      + (h2h ? `<div class="h2h"><div><b>${n(h2h.w)}</b><small>Tu</small></div><span>Frente a frente</span><div><b>${n(h2h.l)}</b><small>${esc(user.name)}</small></div></div>` : '');
    const rows = [
      ['Vitórias online', `${n(rec.online.w)}V – ${n(rec.online.l)}D`],
      ['Contra o CPU', `${n(rec.cpu.w)}V – ${n(rec.cpu.l)}D`],
      ['Jogos', games],
      ['Pontos ganhos', pct(T.pointsWon, T.pointsPlayed)],
      ['1.º serviço', pct(T.firstIn, T.firstTotal)],
      ['Ganhos com o 1.º serviço', pct(T.firstWon, T.firstIn)],
      ['Ganhos com o 2.º serviço', pct(T.secondWon, T.secondTotal)],
      ['Ases', n(T.aces)], ['Duplas faltas', n(T.doubleFaults)],
      ['Serviço mais rápido', T.fastestServe ? n(T.fastestServe) + ' km/h' : '–'],
      ['Vencedores', n(T.winners)], ['Erros', n(T.errors)],
      ['Troca mais longa', T.longestRally ? n(T.longestRally) + ' pancadas' : '–'],
    ];
    $('statsBody').innerHTML = rows.map(([l, v]) => `<div class="kv"><span>${l}</span><b>${v}</b></div>`).join('');
    $('statsRecent').innerHTML = recent.length ? '<div class="field-l">Últimos jogos</div><ul class="recent">' + recent.map(m => {
      const opp = m.opp ? esc(m.opp.name) : 'CPU · ' + (['Fácil', 'Médio', 'Difícil'][n(m.level)] || '');
      const d = new Date(m.at); const when = d.toLocaleDateString('pt-PT', { day:'numeric', month:'short' });
      return `<li><span class="res ${m.won ? 'w' : 'l'}">${m.won ? 'V' : 'D'}</span><span class="ro">${opp}</span><span class="rs">${n(m.score && m.score[0])}–${n(m.score && m.score[1])}</span><small>${when}</small></li>`;
    }).join('') + '</ul>' : '';
  }

  // ---------------------------------------------------------------- eventos dos botões
  $('profLooks').addEventListener('click', e => { const b = e.target.closest('[data-look]'); if (!b) return; pickedLook = +b.dataset.look; renderLooks(); });
  $('bProfCreate').addEventListener('click', createProfile);
  $('profName').addEventListener('keydown', e => { if (e.key === 'Enter') createProfile(); });
  $('bProfLogin').addEventListener('click', () => { $('loginMsg').textContent = ''; $('loginCode').value = ''; G.show('loginScr'); });
  $('bLogin').addEventListener('click', login);
  $('bLoginBack').addEventListener('click', openProfileSetup);
  $('lobbyFriends').addEventListener('click', e => {
    const inv = e.target.closest('[data-invite]'); if (inv) { invite(inv.dataset.invite); return; }
    if (e.target.closest('[data-cancel]')) { cancelInvite(); return; }
    if (e.target.closest('button')) return;
    const li = e.target.closest('[data-profile]'); if (li) openStats(li.dataset.profile);
  });
  $('lobbyReqList').addEventListener('click', e => {
    const a = e.target.closest('[data-accept]'); if (a) { acceptFriend(a.dataset.accept); return; }
    const d = e.target.closest('[data-decline]'); if (d) removeFriend(d.dataset.decline);
  });
  $('bAddTag').addEventListener('click', () => addFriend($('addTag').value));
  $('addTag').addEventListener('keydown', e => { if (e.key === 'Enter') addFriend($('addTag').value); });
  $('bShareLink').addEventListener('click', shareLink);
  $('lobbyMe').addEventListener('click', () => { S.fromMenu = false; openStats(null); });
  $('menuMe').addEventListener('click', () => { S.fromMenu = true; openStats(null); });
  $('bStatsBack').addEventListener('click', () => (!S.statsFor && S.fromMenu ? G.goMenu() : openLobby()));
  $('bRemoveFriend').addEventListener('click', async () => {
    const f = friendById(S.statsFor); if (!f || !confirm('Remover ' + f.name + ' dos teus amigos?')) return;
    await removeFriend(f.id); openLobby();
  });
  $('bAcctShow').addEventListener('click', () => {
    const el = $('acctCode');
    if (el.dataset.shown) { navigator.clipboard?.writeText(S.token).then(() => G.toast('Código copiado', 'good', 'Guarda-o num sítio seguro', 1600)).catch(() => {}); return; }
    el.textContent = (S.token || '').match(/.{1,4}/g).join(' '); el.dataset.shown = '1'; $('bAcctShow').textContent = 'Copiar';
  });
  $('bEditName').addEventListener('click', async () => {
    const nm = (prompt('O teu nome no jogo:', S.me ? S.me.name : '') || '').trim(); if (!nm) return;
    try { await updateMe({ name:nm }); G.setName(S.me.name); openStats(null); } catch (e) { G.toast('Nome não alterado', 'bad', e.message, 1800); }
  });
  $('bSignOut').addEventListener('click', () => {
    if (!confirm('Sair desta conta neste telemóvel? Para voltar a entrar vais precisar do código da conta.')) return;
    signOut(); G.goMenu();
  });
  $('ivNo').addEventListener('click', () => replyInvite(false));
  $('ivYes').addEventListener('click', () => replyInvite(true));
  $('bConnCancel').addEventListener('click', () => { closeRoom(); openLobby(); });

  // arranque: liga ao lobby em segundo plano para receber convites mesmo no menu
  function init() {
    const hadFriendLink = takeFriendHash();
    refreshMenu();
    if (S.token) { connectHub(); loadMe().then(() => { flushReports(); if (hadFriendLink) usePendingFriend().then(openLobby); }).catch(() => {}); }
    return hadFriendLink;
  }

  return {
    screens:['profScr', 'loginScr', 'lobbyScr', 'statsScr', 'connScr'],
    init, openLobby, openProfileSetup,
    send, close:closeRoom, guestStarted, via, reportMatch, enabled,
    me:() => S.me, link:() => S.link, hasAccount:() => !!S.token,
    saveGet, savePut, dailyPost, dailyGet, friends:() => S.friends,
    setStatus:s => hubSend({ t:'status', s }),
  };
}
