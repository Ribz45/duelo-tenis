// Endereço do servidor online (Cloudflare Worker em server/).
// - Em localhost usa o servidor de desenvolvimento (cd server && npx wrangler dev --port 8787).
// - Em produção: o endereço que o `npx wrangler deploy` mostra (https://duelo-tenis-api.<conta>.workers.dev).
// - Para testes: ?api=https://outro-servidor no endereço da página.
const PROD = 'https://duelo-tenis-api.duelo-tenis-api.workers.dev';
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const override = new URLSearchParams(location.search).get('api');
export const API_BASE = (override || (LOCAL ? `http://${location.hostname}:8787` : PROD)).replace(/\/+$/, '');
