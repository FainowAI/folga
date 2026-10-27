// Compila a sonda. Windows: probe/probe.cs com o csc.exe que ja vem no Windows (ADR 0002) -> probe/bin/probe.exe.
// Mac: probe/probe-mac.swift com o swiftc das Command Line Tools -> probe/bin/probe-mac.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'probe', 'bin');
const isMac = process.platform === 'darwin';

let cmd, args, out;
if (isMac) {
  cmd = '/usr/bin/xcrun';
  out = join(outDir, 'probe-mac');
  args = ['swiftc', '-O', join(root, 'probe', 'probe-mac.swift'), '-o', out];
  if (!existsSync(cmd)) {
    console.error('xcrun nao encontrado: instale as Command Line Tools: xcode-select --install');
    process.exit(1);
  }
} else {
  cmd = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  out = join(outDir, 'probe.exe');
  args = ['/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${out}`, join(root, 'probe', 'probe.cs')];
  if (!existsSync(cmd)) {
    console.error(`csc.exe nao encontrado em ${cmd}. A sonda precisa do .NET Framework 4.x (vem no Windows 10/11).`);
    process.exit(1);
  }
}
mkdirSync(outDir, { recursive: true });

const r = spawnSync(cmd, args, { shell: false, encoding: 'utf8' });
if (r.error) { console.error(`falha ao rodar ${cmd}:`, r.error.message); process.exit(1); }
if (r.stdout.trim()) console.log(r.stdout.trim());
if (r.stderr.trim()) console.error(r.stderr.trim());
if (r.status !== 0) {
  console.error(`${isMac ? 'swiftc' : 'csc'} terminou com codigo ${r.status}${isMac ? ' (sem as Command Line Tools? xcode-select --install)' : ''}`);
  process.exit(r.status || 1);
}
console.log(`ok: ${out}`);
