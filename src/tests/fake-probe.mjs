// Sonda falsa para testes: imita probe.exe (snapshots em stdout, comandos em stdin).
import { createInterface } from 'node:readline';

const intervalMs = Number(process.env.FAKE_INTERVAL_MS ?? 200);
const GB = 1024 ** 3;
const MAC = !!process.env.FAKE_MAC;
const TOTAL = (MAC ? 8 : 16) * GB;
let avail = Number(process.env.FAKE_AVAIL_GB ?? 6) * GB;   // memLoad = 100 - avail/total
const mp = (pid, ppid, name, description, o = {}) => [pid, { pid, ppid, name, description, session: 501, privateWorkingSet: 40e6, cpuTimeMs: 0, windowCount: 1, hasVisibleWindow: true, accessible: true, ...o }];
const procs = new Map(MAC ? [
  mp(process.ppid, 1, 'node', 'node', { privateWorkingSet: 50e6, windowCount: 0, hasVisibleWindow: false }),
  mp(process.pid, process.ppid, 'node', 'node', { privateWorkingSet: 30e6, windowCount: 0, hasVisibleWindow: false }),
  mp(9001, 1, 'com.apple.TextEdit', 'TextEdit', { privateWorkingSet: Number(process.env.FAKE_NOTEPAD_MB ?? 40) * 1e6 }),
  mp(9002, 1, 'com.apple.Preview', 'Preview', { windowCount: 0 }),   // app do Dock sem janela
  mp(9003, 1, 'com.example.menubar', 'Barra', { windowCount: 0, hasVisibleWindow: false }),
  mp(9004, 1, 'com.google.Chrome', 'Google Chrome', { privateWorkingSet: 300e6 }),
  mp(9005, 9004, 'com.google.Chrome', 'Google Chrome Helper', { privateWorkingSet: 150e6, windowCount: 0, hasVisibleWindow: false }),
  mp(9006, 1, 'com.apple.dock', 'Dock', { privateWorkingSet: 90e6 }),
  mp(9007, 1, 'com.apple.Terminal', 'Terminal'),
  mp(1, 0, 'launchd', 'launchd', { session: 0, windowCount: 0, hasVisibleWindow: false, accessible: false }),
  // FAKE_APP_PID: o Folga.app (a sonda agrupa o app e os processos do WebKit dele por local.folga.mac)
  ...(process.env.FAKE_APP_PID ? [mp(Number(process.env.FAKE_APP_PID), 1, 'local.folga.mac', 'Folga', { windowCount: 0, hasVisibleWindow: false })] : []),
] : [
  [process.ppid, { pid: process.ppid, ppid: 1, name: 'node.exe', description: 'Node.js', session: 1, privateWorkingSet: 50e6, cpuTimeMs: 0, hasVisibleWindow: false, accessible: true }],
  [process.pid, { pid: process.pid, ppid: process.ppid, name: 'node.exe', description: 'Node.js', session: 1, privateWorkingSet: 30e6, cpuTimeMs: 0, hasVisibleWindow: false, accessible: true }],
  [9001, { pid: 9001, ppid: 4, name: 'notepad.exe', description: 'Bloco de Notas', session: 1, privateWorkingSet: Number(process.env.FAKE_NOTEPAD_MB ?? 40) * 1e6, cpuTimeMs: 0, hasVisibleWindow: true, accessible: true }],
  [9002, { pid: 9002, ppid: 4, name: 'explorer.exe', description: 'Windows Explorer', session: 1, privateWorkingSet: 90e6, cpuTimeMs: 0, hasVisibleWindow: true, accessible: true }],
  [9003, { pid: 9003, ppid: 4, name: 'svchost.exe', description: '', session: 0, privateWorkingSet: 20e6, cpuTimeMs: 0, hasVisibleWindow: false, accessible: false }],
]);

// servidor morto por SIGKILL no teste: o pipe fecha e a sonda sai quieta, como a real (sem EPIPE no stderr)
process.stdout.on('error', () => process.exit(0));
const write = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const tick = () => write({
  type: 'snapshot', t: Date.now(), memLoad: Math.round(100 - (avail / TOTAL) * 100),
  totalPhys: TOTAL, availPhys: avail, foregroundPid: null, audioPids: [], processes: [...procs.values()],
  ...(MAC && { diskActive: null, memPressure: process.env.FAKE_PRESSURE ?? 'normal', swapUsed: 2 * GB }),
});
tick();
const ticker = setInterval(tick, intervalMs);
// FAKE_SILENT_AFTER_MS: a sonda trava (viva, mas sem leitura nova), como uma sonda pendurada
if (process.env.FAKE_SILENT_AFTER_MS) setTimeout(() => clearInterval(ticker), Number(process.env.FAKE_SILENT_AFTER_MS));

createInterface({ input: process.stdin })
  .on('line', line => {
    const cmd = JSON.parse(line);
    let windowsClosed = 0;
    for (const pid of cmd.pids) {
      const p = procs.get(pid);
      if (!p) continue;
      if (cmd.type === 'close' && MAC && cmd.key && p.name.toLowerCase() !== cmd.key) continue;   // como a sonda do Mac
      if (cmd.type === 'close' && p.hasVisibleWindow) {
        windowsClosed++; procs.delete(pid); avail += p.privateWorkingSet;
        if (MAC) for (const o of [...procs.values()]) if (o.name === p.name) { procs.delete(o.pid); avail += o.privateWorkingSet; }   // Cmd+Q leva os helpers
      }
      if (cmd.type === 'kill') { procs.delete(pid); avail += p.privateWorkingSet; }
    }
    write({ type: 'reply', id: cmd.id, ok: true, windowsClosed });
  })
  .on('close', () => process.exit(0));   // como a real: sai quando o stdin fecha
