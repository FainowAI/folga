// Janela do app: Edge em modo app com perfil próprio (ADR 0001) e atalho opcional na pasta Inicializar (P04).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { writePrivate } from './platform.ts';

const EDGE_CANDIDATES = [
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

/** Abre a janela e devolve o pid do processo principal do Edge (raiz da árvore "self"). */
export function openWindow(url: string, dataDir: string, onExit: (pid: number) => void): number | null {
  const edge = EDGE_CANDIDATES.find(existsSync);
  if (!edge) return null;
  // perfil próprio: os processos desta janela não se misturam com o Edge do dia a dia (R05)
  const child = spawn(edge, [
    `--app=${url}`, `--user-data-dir=${join(dataDir, 'edge-profile')}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1180,760',
  ], { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
  const pid = child.pid ?? null;
  if (pid) child.on('exit', () => onExit(pid));
  return pid;
}

const PS = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const MAC = process.platform === 'darwin';
export const startupDir = () => process.env.FOLGA_STARTUP_DIR
  ?? (MAC ? join(homedir(), 'Library', 'LaunchAgents')
    : join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'));
const lnkPath = () => join(startupDir(), MAC ? 'local.folga.app.plist' : 'Folga.lnk');
const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;

export const startupInstalled = () => existsSync(lnkPath());
/** Windows sempre; Mac só com o servidor dentro do Folga.app (o plist aponta para o bundle). */
export const startupAvailable = () => process.platform === 'win32' || (MAC && process.env.FOLGA_APP === '1');
/** Caminho do .app que o plist vai abrir: absoluto, termina em .app, sem caractere de controle. */
export const appBundlePath = (): string | null => {
  const p = process.env.FOLGA_APP_PATH ?? '';
  return isAbsolute(p) && p.endsWith('.app') && !/[\x00-\x1f]/.test(p) ? p : null;
};
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** LaunchAgent do "Abrir com o Mac": o launchd lê no próximo login (o Node não chama launchctl). --login = só o ícone. */
export const launchAgentXml = (appPath: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.folga.app</string>
  <key>ProgramArguments</key>
  <array><string>${xml(join(appPath, 'Contents', 'MacOS', 'Folga'))}</string><string>--login</string></array>
  <key>AssociatedBundleIdentifiers</key><array><string>local.folga.mac</string></array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;

/** Cria ou remove o atalho que sobe o Folga no logon e abre a janela. */
export function setStartup(on: boolean, root: string): Promise<boolean> {
  // unlinkSync, não rmSync: no Node 24.13 o rmSync não apaga arquivo em caminho com acento (C:\Users\Antônio) nem dá erro
  if (!on) { try { unlinkSync(lnkPath()); } catch { /* já não existia */ } return Promise.resolve(startupInstalled()); }
  if (MAC) {
    const app = appBundlePath();
    if (!app) return Promise.resolve(false);
    try { mkdirSync(startupDir(), { recursive: true }); writePrivate(lnkPath(), launchAgentXml(app)); } catch { /* sem escrita: on=false abaixo */ }
    return Promise.resolve(startupInstalled());
  }
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnkPath())})`,
    `$s.TargetPath = ${psQuote(process.execPath)}`,
    // sem --no-window: o Antônio pediu a janela aberta no logon (2026-10-18). O servidor sobe junto de qualquer jeito.
    `$s.Arguments = '"' + ${psQuote(join(root, 'scripts', 'launch.mjs'))} + '"'`,
    `$s.WorkingDirectory = ${psQuote(root)}`,
    '$s.WindowStyle = 7',   // minimizado: o console do node pisca menos
    '$s.Description = "Folga: liberar memória"',
    '$s.Save()',
  ].join('; ');
  return new Promise(resolve => {
    const p = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', shell: false, windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', () => resolve(startupInstalled()));
  });
}
