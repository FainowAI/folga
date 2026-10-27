// M1: sonda pendurada (viva, sem leitura nova) não pode deixar o estado velho dizer "app fechado". Servidor real,
// sonda falsa que para de mandar leitura, dados dos apps numa pasta temporária (nunca o ~/Library real).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Suggestion } from '../types.ts';

const PORT = 17000 + Math.floor(Math.random() * 1000);
const dataDir = mkdtempSync(join(tmpdir(), 'folga-velha-'));
const appBase = mkdtempSync(join(tmpdir(), 'folga-appdata-'));
mkdirSync(join(appBase, 'Claude', 'Cache'), { recursive: true });
writeFileSync(join(appBase, 'Claude', 'Cache', 'f'), 'x'.repeat(4096));
const root = join(import.meta.dirname, '..', '..');
const server = spawn(process.execPath, ['--no-warnings', join(root, 'src', 'server.ts')], {
  env: {
    ...process.env, FOLGA_NOTIFY: '0', FOLGA_PORT: String(PORT), FOLGA_DATA_DIR: dataDir,
    FOLGA_FAKE_PROBE: join(root, 'src', 'tests', 'fake-probe.mjs'), FAKE_SILENT_AFTER_MS: '2500',
    FOLGA_FILES_ROOTS: appBase, FOLGA_APPDATA_BASES: JSON.stringify({ appSupport: appBase, roamingAppData: appBase }),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const get = async <T>(p: string): Promise<T> => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json() as Promise<T>;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { await sleep(100); try { up = (await fetch(`http://127.0.0.1:${PORT}/api/state`)).status === 200; } catch { /* subindo */ } }
  assert.ok(up, 'servidor não subiu');
  // com leitura nova: o cache do Claude (fechado) vira cartão
  const token = (await get<{ token: string }>('/api/token')).token;
  const post = async (p: string, body: unknown) => (await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-folga-token': token }, body: JSON.stringify(body),
  })).json() as Promise<Suggestion>;
  const card = await post('/api/suggestions', { kind: 'dados_apps', title: 'Cache do Claude', reason: '', items: ['claude:Cache'] });
  assert.equal(card.status, 'pendente', JSON.stringify(card));
  // a sonda trava; o clique chega com a última leitura nova velha de mais de 10 s
  await sleep(13_000);
  const done = await post(`/api/suggestions/${card.id}/approve`, {});
  assert.equal(done.status, 'falhou', 'leitura velha da sonda não prova que o Claude está fechado');
  assert.ok(existsSync(join(appBase, 'Claude', 'Cache', 'f')), 'nada apagado');
  console.log('ok  M1: sonda sem leitura nova há mais de 10 s → apps tratados como abertos (cache fica)');
} finally {
  server.kill();
  await sleep(300);
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  await rm(appBase, { recursive: true, force: true, maxRetries: 5 });
}
