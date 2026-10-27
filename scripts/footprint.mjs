// Mede a pegada do próprio Folga (R18): working set privado e CPU do grupo "__self" (Node + sonda).
//   node scripts/footprint.mjs [--minutes 10]   (o servidor precisa estar no ar)
import { availableParallelism } from 'node:os';
import { execFileSync } from 'node:child_process';

const port = Number(process.env.FOLGA_PORT ?? 4780);
const i = process.argv.indexOf('--minutes');
const minutes = i > 0 ? Number(process.argv[i + 1]) : 10;
const withWindow = process.argv.includes('--window');
const limit = withWindow ? 150 : 120; // R18: 150 MB com a janela aberta, 120 MB sem
const MB = 1024 ** 2;
const cores = availableParallelism();

const samples = [];
let lastPids = [];
const end = Date.now() + minutes * 60_000;
while (Date.now() < end) {
  try {
    const s = await fetch(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
    const self = s.apps.find(a => a.key === '__self');
    if (self) { samples.push({ mb: self.privateWorkingSet / MB, cpu: self.cpuPercent, pids: self.pids.length }); lastPids = self.pids; }
  } catch { /* servidor reiniciando */ }
  await new Promise(r => setTimeout(r, 5_000));
}

if (!samples.length) { console.error('nenhuma leitura: o servidor está no ar?'); process.exitCode = 1; }
else {
  const avg = k => samples.reduce((a, s) => a + s[k], 0) / samples.length;
  const max = k => Math.max(...samples.map(s => s[k]));
  const okMem = max('mb') <= limit, okCpu = avg('cpu') / cores < 1;
  console.log(`${samples.length} leituras em ${minutes} min · ${samples.at(-1).pids} processos do Folga`);
  console.log(`memória privada: média ${avg('mb').toFixed(1)} MB · pico ${max('mb').toFixed(1)} MB  ${okMem ? 'ok' : `ACIMA de ${limit} MB`}`);
  console.log(`CPU: média ${avg('cpu').toFixed(2)} % de um núcleo = ${(avg('cpu') / cores).toFixed(2)} % do total (${cores} núcleos)  ${okCpu ? 'ok' : 'ACIMA de 1 %'}`);
  if (process.platform === 'darwin' && lastPids.length) { // RSS, só para ver quem pesa (a soma acima é phys_footprint)
    console.log('RSS, só para ver quem pesa:');
    try { console.log(execFileSync('/bin/ps', ['-o', 'pid=,rss=,comm=', '-p', lastPids.join(',')], { encoding: 'utf8' }).trimEnd()); } catch { /* processo saiu */ }
  }
  process.exitCode = okMem && okCpu ? 0 : 1;
}
