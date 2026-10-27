// Auto Care de ponta a ponta no servidor real com sonda falsa (R10–R14): dispara sozinho, fecha só o parado,
// grava origin 'auto' e liga o freio.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type LogEntry, type MemoryState, type Settings } from '../types.ts';

const { autoCareTrigger: _t, autoCarePressure: _p, ...legado } = DEFAULT_SETTINGS;   // arquivo de antes do Mac: sem os campos novos
const PORT = 19000 + Math.floor(Math.random() * 1000);
const dataDir = mkdtempSync(join(tmpdir(), 'folga-ac-'));
const root = join(import.meta.dirname, '..', '..');
// a sonda falsa sobe em 63 % de memória; a linha em 50 % faz o Auto Care disparar.
// O ﻿ na frente é de propósito: arquivo com BOM (editor, PowerShell 5.1) tem que continuar valendo,
// senão os ajustes do usuário voltam aos padrões em silêncio e o Auto Care não dispara.
writeFileSync(join(dataDir, 'settings.json'), '﻿' + JSON.stringify({ ...legado, autoCareEnabled: true, autoCareThreshold: 50 }));

const start = (port: number, dir: string, extra: Record<string, string> = {}) => spawn(process.execPath, ['--no-warnings', join(root, 'src', 'server.ts')], {
  env: {
    ...process.env, FOLGA_NOTIFY: '0', FOLGA_PORT: String(port), FOLGA_DATA_DIR: dir,
    FOLGA_FAKE_PROBE: join(root, 'src', 'tests', 'fake-probe.mjs'),
    FOLGA_CLOSE_WAIT_MS: '300', FOLGA_MEASURE_WAIT_MS: '300',
    FOLGA_STARTED_AT: String(Date.now() - 2 * 3_600_000),   // há 2 h: o notepad nunca focado já está parado
    ...extra,
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const server = start(PORT, dataDir);
const PORT2 = PORT + 1000;
const dataDir2 = mkdtempSync(join(tmpdir(), 'folga-ac2-'));
writeFileSync(join(dataDir2, 'settings.json'), JSON.stringify({
  ...DEFAULT_SETTINGS, autoCareEnabled: true, autoCareTrigger: 'pressure', autoCarePressure: 'warn', autoCareThreshold: 99,
  neverClose: ['com.apple.terminal', 'com.apple.preview'],   // o Mac falso tem 4 apps parados; só Chrome e TextEdit entram na conta
}));
const server2 = start(PORT2, dataDir2, { FAKE_MAC: '1', FAKE_PRESSURE: 'warn' });

const getAt = async <T>(port: number, path: string): Promise<T> => (await fetch(`http://127.0.0.1:${port}${path}`)).json() as Promise<T>;
const get = <T>(path: string) => getAt<T>(PORT, path);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

try {
  let log: LogEntry[] = [];
  for (let i = 0; i < 60 && log.length === 0; i++) {
    await sleep(200);
    try { log = await get<LogEntry[]>('/api/log?limit=5'); } catch { /* subindo */ }
  }
  assert.equal(log.length, 1, 'o Auto Care deveria ter rodado sozinho uma vez');
  assert.equal(log[0]!.origin, 'auto');
  assert.deepEqual(log[0]!.results.map(r => [r.key, r.outcome]), [['notepad', 'fechou']]);
  console.log('ok  R10/R11: disparou sozinho e fechou só o app parado (notepad), origin auto');

  await sleep(1_500);
  const st = await get<MemoryState>('/api/state');
  assert.ok(st.apps.some(a => a.key === 'explorer'), 'explorer (protegido) continua vivo');
  assert.ok(st.autoCare.lastRunAt !== null);
  assert.ok(st.autoCare.nextEligibleAt !== null && st.autoCare.nextEligibleAt > Date.now() + 9 * 60_000, 'freio de ~10 min');
  assert.equal((await get<LogEntry[]>('/api/log?limit=5')).length, 1, 'o freio impede a segunda execução');
  console.log('ok  R12: lastRunAt e freio expostos no estado; não rodou de novo');

  assert.equal((await get<Settings>('/api/settings')).autoCareTrigger, 'percent');
  console.log('ok  arquivo sem autoCareTrigger = percentual (sem migração)');

  let log2: LogEntry[] = [];
  for (let i = 0; i < 60 && log2.length === 0; i++) {
    await sleep(200);
    try { log2 = await getAt<LogEntry[]>(PORT2, '/api/log?limit=5'); } catch { /* subindo */ }
  }
  assert.equal(log2.length, 1, 'a pressão amarela deveria disparar o Auto Care sozinho uma vez');
  assert.equal(log2[0]!.origin, 'auto');
  assert.deepEqual(log2[0]!.results.map(r => [r.key, r.outcome]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    [['com.apple.textedit', 'fechou'], ['com.google.chrome', 'fechou']]);
  assert.equal((await getAt<MemoryState>(PORT2, '/api/state')).memPressure, 'warn');
  console.log('ok  gatilho por pressão: disparou sozinho no Mac falso, memLoad abaixo do limite');
  console.log('autocare-server: 4 casos ok');
} finally {
  server.kill(); server2.kill();
  await sleep(300);
  for (const d of [dataDir, dataDir2]) await rm(d, { recursive: true, force: true, maxRetries: 5 });
}
