// Servidores ICE para WebRTC: STUN fixo + TURN opcional (Cloudflare Realtime TURN ou TURN estático).
// Falhar a obter TURN nunca falha o pedido: devolve só STUN (o jogo tem o relay da Room como recurso).

const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const CACHE_MS = 60 * 60 * 1000; // ~1 h (as credenciais pedidas valem 24 h)

let cache = null; // { at, servers } — por isolate; perder a cache só custa um pedido extra

const asList = (urls) => (Array.isArray(urls) ? urls : typeof urls === 'string' ? [urls] : []);

// Os browsers bloqueiam a porta 53; esses URLs só atrasam a recolha de candidatos.
const usableUrl = (u) => typeof u === 'string' && /^(stun|turns?):/.test(u) && !/:53(\?|$)/.test(u);

function cleanServer(s) {
  if (!s || typeof s !== 'object') return null;
  const urls = asList(s.urls).filter(usableUrl);
  if (!urls.length) return null;
  const out = { urls };
  if (typeof s.username === 'string') out.username = s.username;
  if (typeof s.credential === 'string') out.credential = s.credential;
  return out;
}

async function cloudflareTurn(env) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.servers;
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
      signal: AbortSignal.timeout(4000),
    },
  );
  if (!res.ok) throw new Error(`turn_http_${res.status}`);
  const data = await res.json();
  // Formato novo: { iceServers: [ … ] }; formato antigo (/credentials/generate): { iceServers: { urls, username, credential } }
  const raw = Array.isArray(data?.iceServers) ? data.iceServers : data?.iceServers ? [data.iceServers] : [];
  const servers = raw.map(cleanServer).filter(Boolean);
  if (!servers.length) throw new Error('turn_empty');
  cache = { at: now, servers };
  return servers;
}

function staticTurn(env) {
  const urls = String(env.TURN_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(usableUrl);
  if (!urls.length || !env.TURN_USERNAME || !env.TURN_CREDENTIAL) return [];
  return [{ urls, username: String(env.TURN_USERNAME), credential: String(env.TURN_CREDENTIAL) }];
}

let failedAt = 0; // depois de uma falha, espera 60 s antes de voltar a tentar

export async function iceServers(env) {
  let turn = [];
  if (env.TURN_KEY_ID && env.TURN_KEY_TOKEN) {
    const now = Date.now();
    try {
      if (now - failedAt < 60_000) throw new Error('turn_backoff');
      turn = await cloudflareTurn(env);
    } catch (err) {
      if (err?.message !== 'turn_backoff') {
        failedAt = now;
        console.warn('ice_turn_failed', err?.message); // nunca as credenciais
      }
      // Credenciais antigas ainda válidas (pedidas com ttl de 24 h) são melhores do que nada.
      turn = cache && now - cache.at < 20 * CACHE_MS ? cache.servers : staticTurn(env);
    }
  } else {
    turn = staticTurn(env);
  }
  return [...STUN, ...turn];
}
