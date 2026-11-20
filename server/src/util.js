// Utilitários partilhados: respostas JSON, erros, ids aleatórios, cripto (SHA-256/HMAC), bilhetes e validação.

// ---------- Respostas e erros ----------

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function jsonError(status, code, message) {
  return json({ error: code, message: message || code }, status);
}

/** Lê o corpo JSON com limite de tamanho. Devolve sempre um objeto (corpo vazio → {}). */
export async function readJson(request, maxBytes = 16 * 1024) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'too_large', 'Request body too large');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request body too large');
  if (!text.trim()) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'Body must be valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'bad_request', 'Body must be a JSON object');
  }
  return data;
}

// ---------- Ids aleatórios ----------

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_LOWER = CROCKFORD.toLowerCase();
export const TAG_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Alfabeto de 32 símbolos: cada byte & 31 dá 5 bits uniformes. */
function randomString(len, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += alphabet[b & 31];
  return out;
}

export const newToken = () => randomString(26, CROCKFORD); // 130 bits
export const newId = (len = 12) => randomString(len, CROCKFORD_LOWER);
export const newTag = () => randomString(5, TAG_ALPHABET);

export const ID_RE = /^[0-9a-z]{12}$/;
export const MATCH_ID_RE = /^[0-9a-z]{16}$/;
const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TAG_RE = /^[A-HJ-NP-Z2-9]{5}$/;

/** Normaliza o "código da conta" (Crockford: aceita minúsculas, hífenes/espaços, I/L→1, O→0). */
export function normalizeToken(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const t = raw.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return TOKEN_RE.test(t) ? t : null;
}

export function normalizeTag(raw) {
  if (typeof raw !== 'string' || raw.length > 16) return null;
  const t = raw.trim().replace(/^#/, '').toUpperCase();
  return TAG_RE.test(t) ? t : null;
}

export const isId = (v) => typeof v === 'string' && ID_RE.test(v);
export const isMatchId = (v) => typeof v === 'string' && MATCH_ID_RE.test(v);

// ---------- Base64url ----------

export function b64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bytesFromB64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- Cripto ----------

export async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

const keyCache = new Map(); // segredo → CryptoKey (cache por isolate; perder a cache não tem problema)

async function hmacKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmacB64url(secret, message) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
  return b64urlFromBytes(new Uint8Array(sig));
}

/** Exige o segredo configurado (falha fechada se faltar ou for fraco). */
export function requireSecret(env) {
  const s = env.SECRET;
  if (typeof s !== 'string' || s.length < 16) {
    throw new HttpError(500, 'misconfigured', 'Server SECRET is not configured');
  }
  return s;
}

/** linkKey = primeiros 8 chars de base64url(HMAC-SHA256(SECRET, "link:" + tag)). */
export async function linkKeyFor(secret, tag) {
  return (await hmacB64url(secret, 'link:' + tag)).slice(0, 8);
}

/** Comparação de strings sem atalhos (evita fugas por tempo; o comprimento não é segredo). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- Bilhetes da Room ----------

export const TICKET_TTL_MS = 3 * 60 * 60 * 1000;

/** bilhete = base64url(JSON{m,u,e}) + "." + base64url(HMAC-SHA256(SECRET, primeiraParte)) */
export async function makeTicket(secret, matchId, userId, exp) {
  const body = b64urlFromBytes(enc.encode(JSON.stringify({ m: matchId, u: userId, e: exp })));
  return body + '.' + (await hmacB64url(secret, body));
}

/** Devolve o userId se o bilhete for válido para esta partida; senão null. */
export async function verifyTicket(secret, ticket, matchId, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 512) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2) return null;
  const sig = bytesFromB64url(parts[1]);
  const bodyBytes = bytesFromB64url(parts[0]);
  if (!sig || sig.length !== 32 || !bodyBytes) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(parts[0]));
  if (!ok) return null;
  let claims;
  try {
    claims = JSON.parse(dec.decode(bodyBytes));
  } catch {
    return null;
  }
  if (!claims || claims.m !== matchId || !isId(claims.u)) return null;
  if (typeof claims.e !== 'number' || !(claims.e > now)) return null;
  return claims.u;
}

// ---------- Validação ----------

/** Inteiro em [min, max]; valores não numéricos dão `def`. */
export function clampInt(v, min, max, def = min) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// Controlos C0/C1, marcas bidi e caracteres invisíveis (mantém o ZWJ U+200D, usado nos emojis).
const NAME_STRIP_RE = /[\p{Cc}​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

/** Texto visível a outros: NFC, sem caracteres de controlo/invisíveis, espaços colapsados, aparado. */
export const sanitizeText = (raw) => raw.normalize('NFC').replace(NAME_STRIP_RE, '').replace(/\s+/gu, ' ').trim();

/** Corta a `max` caracteres (pontos de código, como nos nomes) e volta a aparar. */
export const truncateChars = (s, max) => [...s].slice(0, max).join('').trim();

/** Nome: sem caracteres de controlo, espaços colapsados, aparado, 1–16 caracteres. */
export function cleanName(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'invalid_name', 'Name must be a string');
  if (raw.length > 200) throw new HttpError(400, 'invalid_name', 'Name must be 1–16 characters');
  const name = sanitizeText(raw);
  const len = [...name].length;
  if (len < 1 || len > 16) throw new HttpError(400, 'invalid_name', 'Name must be 1–16 characters');
  return name;
}

/** look: inteiro 0–9 (ausente → 0). */
export function cleanLook(raw) {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new HttpError(400, 'invalid_look', 'look must be an integer 0–9');
  }
  return clampInt(raw, 0, 9, 0);
}

/** Lê um inteiro de env com limites (para afinar limites nos testes locais). */
export function envInt(env, key, def, min, max) {
  const v = env?.[key];
  if (v === undefined || v === null || v === '') return def;
  return clampInt(Number(v), min, max, def);
}
