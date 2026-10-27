// F-20 / R30 de ponta a ponta no servidor real com sonda falsa: o vigia propõe sozinho, NADA acontece
// até o clique, e a aprovação executa de verdade.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type LogEntry, type MemoryState, type Suggestion } from '../types.ts';

const PORT = 19000 + Math.floor(Math.random() * 1000);
const dataDir = mkdtempSync(join(tmpdir(), 'folga-vigia-'));
const root = join(import.meta.dirname, '..', '..');
// Auto Care DESLIGADO: nada pode fechar sozinho. A linha do vigia fica em 85 % e a sonda sobe em ~91 %.
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, autoCareEnabled: false }));

const server = spawn(process.execPath, ['--no-warnings', join(root, 'src', 'server.ts')], {
  env: {
    ...process.env, FOLGA_NOTIFY: '0', FOLGA_PORT: String(PORT), FOLGA_DATA_DIR: dataDir,
    FOLGA_FAKE_PROBE: join(root, 'src', 'tests', 'fake-probe.mjs'),
    FAKE_AVAIL_GB: '1.5', FAKE_NOTEPAD_MB: '800',   // 16 GB no total: memLoad ~91 %, com 800 MB parados
    FOLGA_CLOSE_WAIT_MS: '300', FOLGA_MEASURE_WAIT_MS: '300', FOLGA_WATCH_MS: '400',
    FOLGA_STARTED_AT: String(Date.now() - 2 * 3_600_000),   // há 2 h: o notepad nunca focado já está parado
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;
const get = async <T>(p: string): Promise<T> => (await fetch(url(p))).json() as Promise<T>;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

try {
  let pend: Suggestion[] = [];
  for (let i = 0; i < 60 && pend.length === 0; i++) {
    await sleep(200);
    try { pend = (await get<Suggestion[]>('/api/suggestions')).filter(s => s.status === 'pendente' && s.kind === 'liberar_memoria'); } catch { /* subindo */ }
  }
  assert.equal(pend.length, 1, 'o vigia deveria ter proposto sozinho');
  const s = pend[0]!;
  assert.equal(s.source, 'vigia');
  assert.equal(s.kind, 'liberar_memoria');
  assert.deepEqual(s.items.map(i => i.id), ['notepad']);
  assert.match(s.title, /Memória em 9\d %/);
  console.log('ok  R30: propôs sozinho, sem ninguém pedir');

  // R20: proposta não é ação. O app continua aberto e o registro está vazio.
  const antes = await get<MemoryState>('/api/state');
  assert.ok(antes.apps.some(a => a.key === 'notepad'), 'o notepad não pode ter sido fechado sem o clique');
  assert.deepEqual(await get<LogEntry[]>('/api/log?limit=5'), []);
  await sleep(1_200);   // vários ciclos do vigia
  assert.equal((await get<Suggestion[]>('/api/suggestions')).filter(s => s.kind === 'liberar_memoria').length, 1, 'não repete o cartão a cada ciclo');
  assert.ok((await get<MemoryState>('/api/state')).apps.some(a => a.key === 'notepad'));
  console.log('ok  R20: nada foi executado e o cartão não se repete');

  // o clique do usuário: aí sim executa
  const { token } = await get<{ token: string }>('/api/token');
  const r = await fetch(url(`/api/suggestions/${s.id}/approve`), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-folga-token': token }, body: '{}',
  });
  const done = await r.json() as Suggestion;
  assert.equal(done.status, 'feita', JSON.stringify(done));
  assert.match(done.result ?? '', /fechou/);
  const log = await get<LogEntry[]>('/api/log?limit=5');
  assert.equal(log.length, 1);
  assert.equal(log[0]!.origin, 'manual', 'foi o usuário que mandou, não o Auto Care');
  assert.deepEqual(log[0]!.results.map(x => [x.key, x.outcome]), [['notepad', 'fechou']]);
  assert.ok(!(await get<MemoryState>('/api/state')).apps.some(a => a.key === 'notepad'), 'o notepad fechou depois do OK');
  console.log('ok  com o OK do usuário, executou e entrou no Registro');
  console.log('watch-server: 3 casos ok');
} finally {
  server.kill();
  await sleep(300);
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
}
