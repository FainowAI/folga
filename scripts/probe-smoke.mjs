// Teste de fumaca da sonda (Windows e Mac): 3 snapshots conferidos pelo contrato, filho de carga
// (CPU ~100 % e ~200 MB, pega unidade errada), resumo, comando close vazio, saida ao fechar o stdin.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { snapshotErrors, replyErrors } from './contract.mjs';
import { macHelper } from '../src/platform.ts';

const isMac = process.platform === 'darwin';
const textedit = isMac && process.argv.includes('--textedit');   // abre o TextEdit e exige foco + janela dele
const exe = join(dirname(fileURLToPath(import.meta.url)), '..', 'probe', 'bin', isMac ? 'probe-mac' : 'probe.exe');
const GB = 1024 ** 3, MB = 1024 ** 2;
let load;
const fail = (msg) => { load?.kill(); console.error('FALHOU:', msg); process.exit(1); };

// --textedit fecha o TextEdit pela sonda: nunca o do usuário
if (textedit && spawnSync('/usr/bin/pgrep', ['-x', 'TextEdit']).status === 0) fail('feche o TextEdit antes de rodar --textedit');

// Filho de carga: um núcleo a 100 % e ~200 MB residentes. Sobe antes da sonda.
load = spawn(process.execPath, ['-e', 'const b = Buffer.alloc(200e6, 1); for (;;) b[0]++'], { stdio: 'ignore' });

// Padrao igual ao servidor: probe.cs via Add-Type do PowerShell. FOLGA_PROBE_EXE=1 testa o .exe compilado.
const useExe = process.env.FOLGA_PROBE_EXE === '1';
if (useExe && !existsSync(exe)) fail(`${exe} nao existe; rode node scripts/build-probe.mjs (se sumiu logo apos compilar, o antivirus apagou o exe: ver ADR 0002)`);
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cs = join(dirname(fileURLToPath(import.meta.url)), '..', 'probe', 'probe.cs').replaceAll("'", "''");
const [cmd, args] = isMac ? [exe, ['--interval', '1']] : useExe
  ? [exe, ['--interval', '1']]
  : [ps, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -Path '${cs}'; [Probe]::Main(@('--interval','1'))`]];

let child;
try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: false }); }
catch (e) { fail(`${e.message} (spawn bloqueado: antivirus? ver ADR 0002)`); }
child.on('error', (e) => fail(`${e.message} (spawn bloqueado: antivirus? ver ADR 0002)`));
const exited = new Promise((res) => child.on('exit', (code) => res(code)));

const snaps = [];
let reply = null;
let wake = () => {};
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return fail(`linha nao e JSON: ${line.slice(0, 120)}`); }
  if (m.type === 'snapshot') snaps.push(m);
  else if (m.type === 'reply') reply = m;
  wake();
});
const until = (cond, ms, what) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout esperando ${what}`)), ms);
  wake = () => { if (cond()) { clearTimeout(t); res(); } };
  wake();
});

let te;   // processo principal do TextEdit (--textedit)
try {
  await until(() => snaps.length >= 3, 10000, '3 snapshots');
  const s = snaps[2];
  for (const [i, x] of snaps.entries()) { const e = snapshotErrors(x, { mac: isMac, prev: snaps[i - 1] }); if (e.length) fail(e.join('; ')); }
  const a = snaps[1].processes.find((p) => p.pid === load.pid), b = s.processes.find((p) => p.pid === load.pid);
  if (!a || !b) fail('o filho de carga nao aparece nos snapshots');
  const cpu = (b.cpuTimeMs - a.cpuTimeMs) / (s.t - snaps[1].t) * 100;
  console.log(`filho de carga: CPU ${cpu.toFixed(0)} %  ${(b.privateWorkingSet / MB).toFixed(1)} MB`);
  // faixa larga: máquina carregada rouba CPU do filho; ainda pega o erro de unidade (ticks 41×, páginas 4×)
  if (cpu < 40 || cpu > 160) fail(`CPU do filho de carga ${cpu.toFixed(0)} % (esperado ~100): unidade errada?`);
  if (b.privateWorkingSet < 190e6) fail(`memória do filho de carga ${b.privateWorkingSet} < 190 MB: unidade errada?`);
  if (isMac) { const h = s.processes.find((p) => / Helper \(/.test(p.name)); if (h) fail(`helper fora do bundle: ${h.name}`); }
  const gb = (n) => (n / GB).toFixed(2);
  console.log(`diskActive=${snaps.map((x) => x.diskActive).join(",")}`);
  console.log(`memLoad=${s.memLoad}%  total=${gb(s.totalPhys)} GB  disponivel=${gb(s.availPhys)} GB`);
  console.log(`foregroundPid=${s.foregroundPid}  processos=${s.processes.length}  acessiveis=${s.processes.filter((p) => p.accessible).length}  com janela=${s.processes.filter((p) => p.hasVisibleWindow).length}`);
  if (isMac) {
    console.log(`memPressure=${s.memPressure}  swapUsed=${gb(s.swapUsed)} GB`);
    console.log(`audioPids=${(s.audioPids ?? []).map((pid) => `${pid}:${s.processes.find((p) => p.pid === pid)?.name}`).join(' ')}`);
    const te = s.processes.find((p) => p.name.toLowerCase() === 'com.apple.textedit' && p.hasVisibleWindow);
    if (te) console.log(`textedit: pid=${te.pid} hasVisibleWindow=${te.hasVisibleWindow} windowCount=${te.windowCount}`);
    if (!textedit && !(snaps[0].diskActive === null && typeof s.diskActive === 'number')) fail(`diskActive: esperado null na 1ª leitura e número depois, veio ${snaps.map((x) => x.diskActive)}`);
  }
  if (!(s.totalPhys > s.availPhys && s.availPhys > 0 && s.processes.length > 20)) fail('numeros implausiveis');

  if (textedit) {
    // abre um arquivo: sem documento o TextEdit mostra só o painel Abrir, que é de outro processo (sem janela no app)
    const dir = mkdtempSync(join(tmpdir(), 'folga-smoke-'));
    const doc = join(dir, 'teste.txt');
    writeFileSync(doc, 'teste folga\n');
    // o TextEdit é nosso (conferido no início): sai no fim mesmo se o teste falhar; a pasta temporária também
    process.on('exit', () => {
      spawnSync('/usr/bin/osascript', ['-e', 'quit app "TextEdit" saving no']);
      rmSync(dir, { recursive: true, force: true });
    });
    spawn('/usr/bin/open', ['-a', 'TextEdit', doc], { stdio: 'ignore' });
    const ok = (x) => x.processes.some((p) => p.pid === x.foregroundPid && p.name.toLowerCase() === 'com.apple.textedit' && p.hasVisibleWindow === true && p.windowCount >= 1);
    try { await until(() => ok(snaps.at(-1)), 10000, 'TextEdit'); }
    catch {
      const x = snaps.at(-1), fg = x.processes.find((p) => p.pid === x.foregroundPid);
      const tes = x.processes.filter((p) => p.name.toLowerCase() === 'com.apple.textedit').map((p) => `${p.pid}:${p.hasVisibleWindow}/${p.windowCount}`);
      fail(`primeiro plano ou janela do TextEdit não apareceu (primeiro plano: ${fg?.name ?? x.foregroundPid}; TextEdit: ${tes.join(' ') || 'nenhum'})`);
    }
    te = snaps.at(-1).processes.find((p) => p.pid === snaps.at(-1).foregroundPid);
    console.log(`TextEdit em primeiro plano: pid=${te.pid} windowCount=${te.windowCount}`);
  }

  const groups = new Map();
  for (const p of s.processes) {
    const k = p.name.toLowerCase().replace(/\.exe$/, '');
    groups.set(k, (groups.get(k) ?? 0) + p.privateWorkingSet);
  }
  console.log('top 10 por privateWorkingSet (soma por nome):');
  [...groups].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([k, v]) => console.log(`  ${k.padEnd(28)} ${(v / MB).toFixed(1).padStart(9)} MB`));

  const me = s.processes.find((p) => p.pid === child.pid);
  if (!me) fail('a propria sonda nao aparece no snapshot');
  console.log(`sonda: pid=${me.pid} privateWorkingSet=${(me.privateWorkingSet / MB).toFixed(1)} MB`);

  child.stdin.write('{"type":"close","id":"t1","pids":[]}\n');
  await until(() => reply, 5000, 'reply do close');
  const re = replyErrors(reply, 't1');
  if (re.length || reply.ok !== true || reply.windowsClosed !== 0) fail(`reply inesperado: ${JSON.stringify(reply)} ${re.join('; ')}`);
  console.log('reply:', JSON.stringify(reply));

  if (textedit) {
    // Cmd+Q pela sonda: terminate() só no app .regular (o helper do painel Abrir fica de fora)
    const pids = snaps.at(-1).processes.filter((p) => p.name.toLowerCase() === 'com.apple.textedit').map((p) => p.pid);
    // key de outro app: pid que não é daquele bundle id nunca é fechado (pid reaproveitado)
    reply = null;
    child.stdin.write(JSON.stringify({ type: 'close', id: 't2k', pids, key: 'com.example.outro' }) + '\n');
    await until(() => reply, 5000, 'reply do close com key errada');
    if (replyErrors(reply, 't2k').length || reply.windowsClosed !== 0) fail(`close com key errada fechou: ${JSON.stringify(reply)}`);
    console.log(`key errada nao fecha (reply ${JSON.stringify(reply)})`);
    reply = null;
    child.stdin.write(JSON.stringify({ type: 'close', id: 't2', pids, key: 'com.apple.textedit' }) + '\n');
    await until(() => reply, 5000, 'reply do close do TextEdit');
    if (replyErrors(reply, 't2').length || reply.windowsClosed !== 1) fail(`close do TextEdit: ${JSON.stringify(reply)} (esperado windowsClosed 1)`);
    try { await until(() => !snaps.at(-1).processes.some((p) => p.pid === te.pid), 8000, 'TextEdit sair'); }
    catch { fail(`o TextEdit (pid ${te.pid}) nao saiu em 8 s depois do close`); }
    console.log(`TextEdit saiu pelo close (pids ${pids.join(',')}; reply ${JSON.stringify(reply)})`);
  }

  child.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  if (code === 'timeout') { child.kill(); fail('a sonda nao saiu em 3 s depois de fechar o stdin'); }
  console.log(`sonda saiu sozinha (exitCode ${code})`);
  load.kill();
  if (isMac) { await storage(); await disclaim(); }
  console.log('OK');
} catch (e) {
  child.kill();
  fail(e.message);
}

// Armazenamento (Mac): modos de uma vez só da sonda. Tudo em pastas de teste nossas; nada do usuário.
async function storage() {
  const helper = (args, input) => macHelper(args, input, 15000);
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'folga-smoke-'))), F = realpathSync(mkdtempSync(join(tmpdir(), 'folga-fora-')));
  const leftovers = [];
  // o item na Lixeira é nosso; sem Acesso Total ao Disco o macOS pode negar o rm: aí só avisa o que sobrou
  const untrash = (p) => {
    if (!p) return;
    try { rmSync(p, { recursive: true, force: true }); } catch (e) { leftovers.push(`${p} (${e.code})`); return; }
    if (existsSync(p)) leftovers.push(p);
  };
  // limpa no exit: fail() sai do processo sem passar por finally
  process.on('exit', () => {
    rmSync(T, { recursive: true, force: true }); rmSync(F, { recursive: true, force: true });
    if (leftovers.length) console.log(`sobrou na Lixeira (apague à mão): ${leftovers.join(', ')}`);
  });
  const inCI = !!process.env.CI;
  const short = (x) => JSON.stringify(x)?.slice(0, 200);
  {
    writeFileSync(join(T, 'a.bin'), 'x'); writeFileSync(join(F, 'segredo.txt'), 's'); mkdirSync(join(T, 'sub'));
    writeFileSync(join(T, 'sub', 'b.bin'), 'y'); symlinkSync(join(F, 'segredo.txt'), join(T, 'link.bin'));
    // TOCTOU: o Node validou T/sub/b.bin; antes do Swift, "sub" vira link para fora
    renameSync(join(T, 'sub'), join(T, 'sub-velha')); symlinkSync(F, join(T, 'sub')); writeFileSync(join(F, 'b.bin'), 'z');
    mkdirSync(join(T, 'Velho.app', 'Contents'), { recursive: true }); writeFileSync(join(T, 'Velho.app', 'Contents', 'x'), 'a');
    mkdirSync(join(T, 'sub-velha', 'Fundo.app'));

    const apps = await helper(['--trash'], { roots: [T], appRoot: null, paths: [join(T, 'Velho.app')] });
    if (!Array.isArray(apps) || apps.length !== 1) fail(`--trash fora do formato: ${short(apps)}`);
    if (apps[0].ok) fail('--trash aceitou .app sem appRoot');
    const ra = await helper(['--trash'], { roots: [T], appRoot: T, paths: [join(T, 'Velho.app'), join(T, 'sub-velha', 'Fundo.app'), '/Applications/Safari.app'] });
    if (!Array.isArray(ra) || ra.length !== 3) fail(`--trash fora do formato: ${short(ra)}`);
    if (ra.slice(1).some((x) => x.ok)) fail('--trash: .app só como filho direto do appRoot');
    if (!ra[0].ok) {
      if (inCI) console.log(`--trash do .app pulado na CI: ${ra[0].erro}`); else fail(`--trash: .app filho direto do appRoot recusado (${ra[0].erro})`);
    }
    untrash(ra[0].trashed);

    const sz = await helper(['--size'], join(T, 'sub-velha'));
    if (!(sz?.bytes > 0 && sz.files >= 1 && sz.denied === false)) fail(`--size fora do formato: ${short(sz)}`);

    const r = await helper(['--trash'], { roots: [T], appRoot: T, paths: [join(T, 'a.bin'), join(T, 'link.bin'), join(T, 'sub', 'b.bin'), join(F, 'segredo.txt'), join(T, 'nao-existe')] });
    if (!Array.isArray(r) || r.length !== 5) fail(`--trash fora do formato: ${short(r)}`);
    if (r.slice(1).some((x) => x.ok)) fail('--trash aceitou link, pasta trocada, fora da raiz ou inexistente');
    if (!existsSync(join(F, 'segredo.txt')) || !existsSync(join(F, 'b.bin')) || !existsSync(join(T, 'link.bin'))) fail('alvo fora da raiz foi tocado');
    if (!r[0].ok || !r[0].inTrash) {
      if (inCI) console.log(`--trash do arquivo pulado na CI: ${r[0].erro}`); else fail('--trash não mandou o arquivo de teste para a Lixeira');
    }
    untrash(r[0].trashed);   // o item é nosso: tira da Lixeira
    console.log(`--trash: recusas ${r.slice(1).map((x) => x.erro).join(' | ')}`);

    const m = await helper(['--meta'], [join(T, 'sub-velha', 'b.bin'), join(T, 'nao-existe')]);
    if (m?.[0]?.dataless !== false || m[1]?.missing !== true || !('lastUsed' in m[0])) fail(`--meta fora do formato: ${short(m)}`);
    const v = await helper(['--volume', homedir()], null);
    if (!(v?.total > 0 && v.available >= 0 && v.important >= 0 && typeof v.name === 'string')) fail(`--volume fora do formato: ${short(v)}`);
    console.log(`armazenamento: volume "${v.name}" total=${(v.total / GB).toFixed(1)} GB livre=${(v.available / GB).toFixed(1)} GB importante=${(v.important / GB).toFixed(1)} GB; size=${sz.bytes} B/${sz.files} arq`);
  }
}

// Responsabilidade (Mac): --responsible e --disclaim (o assistente não herda o Acesso Total ao Disco do app).
function disclaim() {
  const once = (args) => {
    const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 10000 });
    let j = null; try { j = JSON.parse(r.stdout); } catch { /* fica null */ }
    return { j, status: r.status };
  };
  const a = once(['--responsible']).j;
  if (!(a?.pid > 0 && a.responsible > 0 && typeof a.path === 'string')) fail(`--responsible fora do formato: ${JSON.stringify(a)}`);
  const b = once(['--disclaim', exe, '--responsible']);
  if (!(b.status === 0 && b.j?.pid > 0 && b.j.responsible === b.j.pid)) fail(`--disclaim não cortou a responsabilidade: ${JSON.stringify(b)}`);
  // mesmo pid (POSIX_SPAWN_SETEXEC): o pid lançado é o do programa final, então o kill do Node acerta nele
  const c = spawn(exe, ['--disclaim', exe, '--responsible'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  return new Promise((res) => c.on('close', () => {
    let j = null; try { j = JSON.parse(out); } catch { /* null */ }
    if (j?.pid !== c.pid) fail(`--disclaim trocou de pid: lançado ${c.pid}, rodou ${j?.pid}`);
    const f = once(['--disclaim', '/usr/bin/false']);
    if (f.status !== 1) fail(`--disclaim não repassou o código de saída: ${f.status}`);
    // 125 = disclaim indisponível/sem comando (nada executado); 127 = comando que não existe
    if (once(['--disclaim']).status !== 125) fail('--disclaim sem comando não saiu 125');
    if (once(['--disclaim', '/nao/existe/folga-x']).status !== 127) fail('--disclaim de comando inexistente não saiu 127');
    console.log(`responsabilidade: sonda → ${a.responsible} (${a.path.split('/').pop()}); --disclaim → ela mesma, pid igual, código repassado`);
    res();
  }));
}
