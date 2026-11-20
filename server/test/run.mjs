// `npm test`: arranca `wrangler dev` na porta 8787 (ou reutiliza um já a correr), espera por /api/health,
// corre os testes node:test e pára o servidor que arrancou.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const STARTUP_TIMEOUT_MS = 120_000;
// Estado local dos testes numa pasta temporária de caminho curto: no Windows, caminhos > 260 caracteres
// (repositório muito fundo + .wrangler/state/v3/do/…/<hash>.sqlite) dão SQLITE_CANTOPEN.
const persist = path.join(os.tmpdir(), 'duelo-tenis-api-test');

// Valores só para testes (servidor arrancado aqui): limite de registos baixo e convites curtos.
const TEST_VARS = { REGISTER_LIMIT: '5', INVITE_TTL_MS: '1500' };

async function healthy(base = BASE) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let output = '';

function stopServer() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // No Windows, matar só o node deixava o workerd órfão: mata a árvore inteira.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

async function startServer() {
  const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(wrangler)) throw new Error('wrangler not installed: run `npm install` in server/');
  rmSync(persist, { recursive: true, force: true }); // estado limpo em cada execução
  const args = [wrangler, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist];
  args.push('--show-interactive-dev-session=false', '--log-level', 'log');
  for (const [k, v] of Object.entries(TEST_VARS)) args.push('--var', `${k}:${v}`);

  child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early (code ${child.exitCode})`);
    if (await healthy()) return;
    await sleep(500);
  }
  throw new Error('wrangler dev did not become healthy in time');
}

// Ctrl+C durante os testes: não deixar o wrangler dev a correr.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopServer();
    process.exit(130);
  });
}

let code = 1;
let base = BASE;
try {
  // Um `npx wrangler dev --port 8787` já aberto pode estar só em localhost (IPv6).
  const LOCALHOST = `http://localhost:${PORT}`;
  const reuse = (await healthy(BASE)) || ((await healthy(LOCALHOST)) && (base = LOCALHOST));
  if (reuse) {
    console.log(`# A reutilizar o servidor já a correr em ${base} (limites normais: o teste de expiração demora ~30 s).`);
  } else {
    console.log('# A arrancar wrangler dev…');
    await startServer();
    console.log(`# wrangler dev pronto em ${BASE}`);
  }

  const files = readdirSync(path.join(root, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join('test', f));
  const tests = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DT_BASE: base, DT_SPAWNED: reuse ? '' : '1', ...(reuse ? {} : prefixed(TEST_VARS)) },
  });
  code = await new Promise((resolve) => tests.on('exit', (c) => resolve(c ?? 1)));
  // DT_SHOW_LOGS=1 mostra o fim do log do wrangler dev quando algum teste falha.
  if (code !== 0 && output && process.env.DT_SHOW_LOGS) console.error(output.slice(-8000));
} catch (err) {
  console.error(`# ${err.message}`);
  if (output) console.error(output.slice(-4000));
  code = 1;
} finally {
  stopServer();
}
if (child) {
  await sleep(500); // deixa o workerd libertar os ficheiros antes de apagar
  try {
    rmSync(persist, { recursive: true, force: true });
  } catch {
    /* fica para a próxima execução */
  }
}
process.exit(code);

function prefixed(vars) {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [`DT_${k}`, v]));
}
