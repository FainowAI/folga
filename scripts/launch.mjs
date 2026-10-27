// npm run app: sobe o servidor escondido (se ainda não estiver no ar) e abre a janela.
//   --no-window   só garante o servidor (usado pelo atalho da pasta Inicializar)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir as platformDataDir } from '../src/platform.ts';

const root = join(import.meta.dirname, '..');
const port = Number(process.env.FOLGA_PORT ?? 4780);
const dataDir = platformDataDir();
const noWindow = process.argv.includes('--no-window');

function call(method, path, body) {
  return new Promise(resolve => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}` };
    if (data !== undefined) {
      headers['content-type'] = 'application/json';
      try { headers['x-folga-token'] = readFileSync(join(dataDir, 'ui-token'), 'utf8').trim(); } catch {}
    }
    const req = request({ host: '127.0.0.1', port, method, path, headers, timeout: 2000 }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// server.log em modo acréscimo, zerado se passar de 1 MB. Um fd só, usado para stdout e stderr.
let fd;
function logFd() {
  if (fd !== undefined) return fd;
  const file = join(dataDir, 'server.log');
  try {
    mkdirSync(dataDir, { recursive: true });
    if (statSync(file, { throwIfNoEntry: false })?.size > 1_000_000) truncateSync(file, 0);
    fd = openSync(file, 'a');
  } catch {
    fd = 'ignore';   // sem log é melhor que não subir
  }
  return fd;
}

// no Mac o servidor mora dentro do Folga.app instalado (ADR 0007): aqui só abrimos o app
if (process.platform === 'darwin') {
  const app = join(process.env.FOLGA_INSTALL_DIR ?? join(homedir(), 'Applications'), 'Folga.app');
  if (!existsSync(app)) { console.error('Folga.app não está instalado: rode node scripts/mac-app.mjs install'); process.exit(1); }
  spawn('/usr/bin/open', [app], { stdio: 'ignore' }).unref();
  process.exit(0);
}

if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('interface não compilada: rode npm run build');
  process.exit(1);
}

// /api/settings responde mesmo antes da primeira leitura da sonda
let up = (await call('GET', '/api/settings')) === 200;
if (!up) {
  // R32: a saída vai para um arquivo. Com 'ignore', um erro no logon não deixava rastro nenhum.
  const server = spawn(process.execPath, ['--no-warnings', join(root, 'src', 'server.ts')], {
    cwd: root, detached: true, stdio: ['ignore', logFd(), logFd()], windowsHide: true, shell: false,
    env: { ...process.env, FOLGA_OPEN_WINDOW: noWindow ? '0' : '1' },
  });
  server.unref();
  for (let i = 0; i < 50 && !up; i++) { await sleep(200); up = (await call('GET', '/api/settings')) === 200; }
  if (!up) { console.error('o servidor não subiu (porta ocupada?)'); process.exitCode = 1; }
  else console.log(`Folga no ar em http://127.0.0.1:${port}`);
} else if (!noWindow) {
  // já estava no ar: só reabre a janela
  const status = await call('POST', '/api/window', {});
  if (status !== 200) { console.error('não deu para abrir a janela'); process.exitCode = 1; }
}
