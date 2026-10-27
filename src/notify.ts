// R31: aviso do Windows quando o vigia propõe algo e a janela está fechada.
// O texto NUNCA entra no script: vai por variável de ambiente, e o script o escapa para XML. Assim um nome
// de app ou de arquivo não vira comando (mesma ideia da R24).
import { spawn } from 'node:child_process';
import { join, posix } from 'node:path';

const PS = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// AppId do próprio PowerShell: é o único jeito de tocar um toast sem instalar/registrar um app.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
// Sem aspas duplas no script: o -Command do powershell.exe as embaralha. Q é a aspa, montada na hora.
export const SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$Q = [char]34',
  'function E($s) { [Security.SecurityElement]::Escape([string]$s) }',
  // uma linha só: o join por ';' abaixo quebraria uma chamada partida em várias
  "$x = '<toast activationType=' + $Q + 'protocol' + $Q + ' launch=' + $Q + (E $env:FOLGA_TOAST_URL) + $Q"
    + " + '><visual><binding template=' + $Q + 'ToastGeneric' + $Q + '><text>' + (E $env:FOLGA_TOAST_TITLE)"
    + " + '</text><text>' + (E $env:FOLGA_TOAST_BODY) + '</text></binding></visual></toast>'",
  '$d = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$d.LoadXml($x)',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($d))`,
].join('; ');

const OSA = '/usr/bin/osascript';
/**
 * Mac: dentro do Folga.app o próprio `Folga --notify` (aviso com o nome e o clique do app); fora dele, ou se o app
 * recusar, o osascript. Título e corpo vão só pelo ambiente (FOLGA_TOAST_*), nunca nos argumentos nem no script.
 * Windows e o resto: null (segue o PowerShell).
 */
export function notifyCommand(platform: string, vars: Record<string, string | undefined>): { cmd: string; args: string[] } | null {
  if (platform !== 'darwin') return null;
  const app = vars.FOLGA_APP_PATH ?? '';
  if (vars.FOLGA_APP === '1' && posix.isAbsolute(app) && app.endsWith('.app')) return { cmd: posix.join(app, 'Contents', 'MacOS', 'Folga'), args: ['--notify'] };
  return osa();
}
const osa = () => ({ cmd: OSA, args: ['-e', 'display notification (system attribute "FOLGA_TOAST_BODY") with title (system attribute "FOLGA_TOAST_TITLE")'] });

type SpawnCmd = (cmd: string, args: string[], extra: Record<string, string>, done: (code: number | null, err?: NodeJS.ErrnoException) => void) => void;
const spawnCmd: SpawnCmd = (cmd, args, extra, done) => {
  const child = spawn(cmd, args, { shell: false, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...extra } });
  const kill = setTimeout(() => child.kill(), 15_000);
  kill.unref();
  child.on('error', err => { clearTimeout(kill); done(null, err); });
  child.on('exit', code => { clearTimeout(kill); done(code); });
  child.unref();
};

export type NotifyDeps = {
  port: number;
  /** só para testes */
  platform?: string;
  vars?: Record<string, string | undefined>;
  spawnCmd?: SpawnCmd;
  now?: () => number;
  /** só para testes: o que de fato dispara o processo */
  run?: (title: string, body: string, url: string) => void;
};

export function createNotify(deps: NotifyDeps) {
  let broken = false;   // se o Windows recusar uma vez, não insiste a cada proposta
  const url = `http://127.0.0.1:${deps.port}`;

  // app do Mac: ausente (ENOENT/EACCES/126/127) = só osascript para sempre; 3 (não perguntado), 4 (sem autorização ou
  // alertas desligados — só uma leitura de estado, o Vittorio pode ligar depois), 5 e outra falha de spawn = osascript
  // só desta vez e o app volta a ser tentado depois do recuo de 10 min
  let appBroken = false;
  let appRetryAt = 0;
  const now = deps.now ?? Date.now;
  const APP_BACKOFF_MS = 10 * 60_000;
  const sp = deps.spawnCmd ?? spawnCmd;
  const platform = deps.platform ?? process.platform;
  const vars = deps.vars ?? process.env;

  const run = deps.run ?? ((title: string, body: string, u: string) => {
    const extra = { FOLGA_TOAST_TITLE: title, FOLGA_TOAST_BODY: body, FOLGA_TOAST_URL: u };
    const mac = notifyCommand(platform, vars);
    if (!mac) return sp(PS(), ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT], extra, code => { if (code !== 0) broken = true; });
    // osascript que falha só cala tudo quando ele é o único caminho (fora do app), mesma regra do Windows;
    // como reserva do app, não: senão uma falha dele calaria o Folga.app para sempre
    const viaOsascript = () => sp(OSA, osa().args, extra, code => { if (code !== 0 && mac.cmd === OSA) broken = true; });
    if (mac.cmd === OSA || appBroken || now() < appRetryAt) return viaOsascript();
    sp(mac.cmd, mac.args, extra, (code, err) => {
      if (code === 0) return;
      if (code === 126 || code === 127 || err?.code === 'ENOENT' || err?.code === 'EACCES') appBroken = true;
      else appRetryAt = now() + APP_BACKOFF_MS;
      viaOsascript();
    });
  });

  return {
    /** Fire-and-forget: avisar nunca pode atrapalhar o que o Folga estava fazendo. */
    toast(title: string, body: string): void {
      if (broken || vars.FOLGA_NOTIFY === '0') return;   // FOLGA_NOTIFY=0: testes que sobem o servidor
      try { run(title, body, url); } catch { broken = true; }
    },
  };
}
export type Notify = ReturnType<typeof createNotify>;
