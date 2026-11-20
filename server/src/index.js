// Worker de entrada: CORS, /api/health, e encaminhamento para os Durable Objects.
//   /api/*            → Hub (instância global 'global')
//   /ws               → Hub (WebSocket de presença/convites)
//   /ws/room/:matchId → Room (uma por partida; relay)
import { json, jsonError, isMatchId } from './util.js';

export { Hub } from './hub.js';
export { Room } from './room.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function withCors(res) {
  if (res.status === 101 || res.webSocket) return res; // respostas de upgrade não se mexem
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

const isUpgrade = (req) => (req.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  if (path === '/api/health') {
    if (request.method !== 'GET') return jsonError(405, 'method_not_allowed', 'Use GET');
    return json({ ok: true, time: Date.now() });
  }

  if (path.startsWith('/api/') || path === '/ws') {
    if (path === '/ws' && !isUpgrade(request)) return jsonError(426, 'upgrade_required', 'Expected a WebSocket upgrade');
    const hub = env.HUB.get(env.HUB.idFromName('global'));
    return hub.fetch(request);
  }

  const m = /^\/ws\/room\/([^/]+)$/.exec(path);
  if (m) {
    if (!isUpgrade(request)) return jsonError(426, 'upgrade_required', 'Expected a WebSocket upgrade');
    if (!isMatchId(m[1])) return jsonError(400, 'bad_match', 'Invalid matchId');
    const room = env.ROOM.get(env.ROOM.idFromName(m[1]));
    return room.fetch(request);
  }

  return jsonError(404, 'not_found', 'Unknown route');
}

export default {
  async fetch(request, env) {
    try {
      return withCors(await route(request, env));
    } catch (err) {
      // Nunca registar o URL (pode conter ?token= ou ?ticket=).
      console.error('worker_error', err?.name, err?.message);
      return withCors(jsonError(500, 'internal', 'Internal error'));
    }
  },
};
