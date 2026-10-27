// F-15: monitor de avisos (D15, R26), discos e apps de inicialização. Só leitura.
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readdir, lstat, statfs as fsStatfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import { macHelper } from './platform.ts';
import type { DiskInfo, Emit, MemoryState, Settings, StartupApp, Severity, View, Warning, WarningKind } from './types.ts';

export type WarningsDeps = {
  getState: () => MemoryState | null;
  getSettings: () => Settings;
  probeAlive: () => boolean;
  lastAutoCareRun: () => number | null;
  settingsProblem: () => string | null;   // R34: null = os ajustes vieram do settings.json
  emit: Emit;
  // opcionais, só para testes: o servidor passa apenas os obrigatórios
  exec?: (file: string, args: string[]) => Promise<string>;
  now?: () => number;
  platform?: NodeJS.Platform;
  macVolume?: () => Promise<unknown | null>;   // sonda --volume; injetável nos testes
  statfs?: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
  startupFolder?: string;
  launchDirs?: { dir: string; source: StartupApp['source']; domain: 'gui' | 'system' }[];   // Mac: pastas de LaunchAgents/Daemons
  notify?: (title: string, body: string) => void;   // decisão 20: só aviso crítico vira notificação
  crashDir?: string;   // Mac: padrão ~/Library/Logs/DiagnosticReports
};

const FAST_MS = 30_000;            // memória, disco, Auto Care
const PROBE_MS = 5_000;            // sonda (sem spawn; só para o limite de 30 s ser preciso)
const CRASH_MS = 10 * 60_000;
const AV_MS = 30 * 60_000;
const PROBE_DOWN_MS = 30_000;
const AUTOCARE_SHOWN_MS = 60 * 60_000;
const STARTUP_CACHE_MS = 5 * 60_000;
const MEM_CRITICAL = 97;
const DISK_ATTENTION = 10;
const DISK_CRITICAL = 5;

const SYSROOT = () => process.env.SystemRoot ?? 'C:\\Windows';
const PS = () => join(SYSROOT(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = () => join(SYSROOT(), 'System32', 'cmd.exe');
const REG = () => join(SYSROOT(), 'System32', 'reg.exe');
const U8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';

// Scripts fixos: nenhum dado entra neles. Application Error (1000) e Application Hang (1002); sem filtrar o
// provedor, outros softwares que usam os mesmos Ids (ex.: serviços com Id 1000 = "iniciado") viram falso travamento.
const PS_CRASHES = U8 + "$e=@(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Error','Application Hang';Id=1000,1002;StartTime=(Get-Date).AddHours(-24)} -MaxEvents 50 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{id=$_.Id;app=[string]$_.Properties[0].Value} }); ConvertTo-Json -InputObject $e -Compress";
const PS_AV = U8 + "ConvertTo-Json -InputObject @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | Select-Object displayName,productState) -Compress";

// ---------------------------------------------------------------- funções puras (testadas)

/** productState do SecurityCenter2: bits 12-15 = produto ativo (1); bits 4-7 = definições em dia (0). */
export function decodeAvState(state: number) {
  return { active: ((state >> 12) & 0xF) === 1, upToDate: ((state >> 4) & 0xF) === 0 };
}

export type AvProduct = { displayName: string; productState: number };
export function parseAv(json: string): AvProduct[] {
  const raw: unknown = json.trim() ? JSON.parse(json) : [];
  return (Array.isArray(raw) ? raw : [raw]).flatMap(p => {
    const o = p as { displayName?: unknown; productState?: unknown } | null;
    return o && typeof o.displayName === 'string' && typeof o.productState === 'number'
      ? [{ displayName: o.displayName, productState: o.productState }] : [];
  });
}

type Candidate = Omit<Warning, 'firstSeen' | 'lastSeen' | 'active'> & { since?: number };
const cand = (kind: WarningKind, id: string, severity: Severity, title: string, detail: string, view?: View, since?: number): Candidate =>
  ({ id, kind, severity, title, detail, ...(view ? { view } : {}), ...(since ? { since } : {}) });

/** Aviso só se nenhum produto está ativo, ou se nenhum ativo está com as definições em dia. */
export function avWarning(products: AvProduct[]): Candidate | null {
  const active = products.filter(p => decodeAvState(p.productState).active);
  if (!active.length) {
    return cand('antivirus', 'antivirus', 'critico', 'Antivírus desligado',
      products.length ? `Nenhum antivírus está ativo (${products.map(p => p.displayName).join(', ')}).` : 'O Windows não encontrou nenhum antivírus.');
  }
  if (!active.some(p => decodeAvState(p.productState).upToDate)) {
    return cand('antivirus', 'antivirus', 'critico', 'Antivírus desatualizado',
      `${active[0]?.displayName ?? 'O antivírus'} está com as definições antigas.`);
  }
  return null;
}

/** Nome vindo de arquivo/log: sem controle, quebra de linha nem invisível (bidi, U+2060–2064, tags), até `max` caracteres. */
export function cleanName(s: string, max = 80): string {
  return [...s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu, '')
    .replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

/** Um aviso por app (id com o nome em minúsculo), com a contagem de travamentos. */
export function crashCandidates(names: string[]): Candidate[] {
  const byApp = new Map<string, { name: string; n: number }>();
  for (const name of names) {
    if (!name) continue;
    const cur = byApp.get(name.toLowerCase());
    if (cur) cur.n++; else byApp.set(name.toLowerCase(), { name, n: 1 });
  }
  return [...byApp].map(([key, { name, n }]) =>
    cand('travamento', `travamento:${key}`, 'atencao', `${name} travou`,
      `Travou ${n === 1 ? '1 vez' : `${n} vezes`} nas últimas 24 h.`));
}

/** Saídas de fdesetup/spctl/csrutil. Só a frase conhecida vale; vazio, outro idioma ou "unknown"/"Custom" = null (não sei, sem aviso). */
export function parseMacSecurity(out: { fv: string; gk: string; sip: string }) {
  const yn = (text: string, yes: RegExp, no: RegExp) => yes.test(text) ? true : no.test(text) ? false : null;
  return {
    fileVault: yn(out.fv, /^FileVault is On\.\s*$/m, /^FileVault is Off\.\s*$/m),
    gatekeeper: yn(out.gk, /^assessments enabled\s*$/m, /^assessments disabled\s*$/m),
    sip: yn(out.sip, /status: enabled\.\s*$/m, /status: disabled\.\s*$/m),
  };
}

/** Um aviso `info` por proteção desligada; `null` não gera nada. */
export function macSecurityWarnings(s: ReturnType<typeof parseMacSecurity>): Candidate[] {
  const out: Candidate[] = [];
  if (s.fileVault === false) out.push(cand('seguranca', 'seguranca:filevault', 'info', 'FileVault desligado',
    'O disco não está criptografado: quem pegar o Mac consegue ler seus arquivos.'));
  if (s.gatekeeper === false) out.push(cand('seguranca', 'seguranca:gatekeeper', 'info', 'Gatekeeper desligado',
    'O Mac não confere se os apps que você abre vêm de fontes confiáveis.'));
  if (s.sip === false) out.push(cand('seguranca', 'seguranca:sip', 'info', 'Proteção do sistema (SIP) desligada',
    'Os arquivos centrais do macOS ficam abertos a alterações por qualquer app com permissão de administrador.'));
  return out;
}

/** Saída do Get-WinEvent → um aviso por app (nome sem .exe, minúsculo no id). */
export function parseCrashes(json: string): Candidate[] {
  const raw: unknown = json.trim() ? JSON.parse(json) : [];
  const names: string[] = [];
  for (const e of Array.isArray(raw) ? raw : [raw]) {
    const app = (e as { app?: unknown } | null)?.app;
    if (typeof app === 'string') names.push(app.trim().replace(/\.exe$/i, ''));
  }
  return crashCandidates(names);
}

// bug_type de travamento nos .ips: só os vistos em relatório real deste Mac. 309 = crash de processo (node, 21/10/2026).
// Outro tipo só entra aqui com fixture real ao lado.
const MAC_CRASH_TYPES = new Set(['309']);
const DAY_MS = 24 * 60 * 60_000;
const CRASH_FILES = 50;
const CRASH_HEAD = 4096;

/** Primeira linha de um .ips: um JSON com app_name e bug_type. Qualquer outra coisa = null. */
export function parseIpsHeader(firstLine: string): { app: string; bugType: string } | null {
  try {
    const o = JSON.parse(firstLine) as { app_name?: unknown; name?: unknown; bug_type?: unknown } | null;
    const app = typeof o?.app_name === 'string' && o.app_name ? o.app_name : o?.name;
    if (typeof app !== 'string' || !app || typeof o?.bug_type !== 'string') return null;
    return { app, bugType: o.bug_type };
  } catch { return null; }
}

/** Formato antigo (.crash): linha "Process:   Nome [pid]". */
export function parseCrashText(text: string): string | null {
  const m = /^Process:\s+(.+?)\s+\[\d+\]\s*$/m.exec(text);
  return m ? m[1]! : null;
}

/** Relatórios de até 24 h → um aviso por app. `file` com "/" (Retired/…) e extensões fora de .ips/.crash ficam de fora. */
export function macCrashes(entries: { file: string; mtimeMs: number; head: string }[], now: number): Candidate[] {
  const names: string[] = [];
  for (const e of entries) {
    if (e.file.includes('/') || now - e.mtimeMs > DAY_MS) continue;
    let app: string | null = null;
    if (e.file.endsWith('.ips')) {
      const h = parseIpsHeader(e.head.split('\n')[0] ?? '');
      if (h && MAC_CRASH_TYPES.has(h.bugType)) app = h.app;
    } else if (e.file.endsWith('.crash')) app = parseCrashText(e.head);
    const name = app === null ? '' : cleanName(app);
    if (name) names.push(name);
  }
  return crashCandidates(names);
}

/** Lê os relatórios mais novos da pasta (só o nível de cima, sem `Retired`). Pasta ilegível = lança: os avisos ficam. */
export async function readCrashEntries(dir: string, now: number): Promise<{ file: string; mtimeMs: number; head: string }[]> {
  const found: { file: string; mtimeMs: number }[] = [];
  for (const file of await readdir(dir)) {
    if (!/\.(ips|crash)$/.test(file)) continue;
    try {
      const st = await lstat(join(dir, file));   // lstat: link simbólico não é arquivo (não lê o que está fora da pasta)
      if (st.isFile() && now - st.mtimeMs <= DAY_MS && st.mtimeMs - now <= 5 * 60_000) found.push({ file, mtimeMs: st.mtimeMs });
    } catch { /* sumiu entre o readdir e o stat */ }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: { file: string; mtimeMs: number; head: string }[] = [];
  for (const f of found.slice(0, CRASH_FILES)) {
    try {
      // O_NOFOLLOW + confere no descritor: um link ou FIFO trocado entre o lstat e o open não é lido nem trava
      const fh = await open(join(dir, f.file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await fh.stat()).isFile()) continue;
        const buf = Buffer.alloc(CRASH_HEAD);
        const { bytesRead } = await fh.read(buf, 0, CRASH_HEAD, 0);
        out.push({ ...f, head: buf.toString('utf8', 0, bytesRead) });
      } finally { await fh.close(); }
    } catch { /* arquivo ilegível: pula só ele */ }
  }
  return out;
}

export const defaultCrashDir = () => join(homedir(), 'Library', 'Logs', 'DiagnosticReports');

const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const hm = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const GB = 1024 ** 3;

export function memoryWarning(memLoad: number, threshold: number): Candidate | null {
  if (memLoad < Math.min(threshold, MEM_CRITICAL)) return null;
  const critical = memLoad >= MEM_CRITICAL;
  return cand('memoria', 'memoria', critical ? 'critico' : 'atencao',
    critical ? 'Memória quase esgotada' : 'Memória alta',
    `${nf0.format(memLoad)} % da memória está em uso.`, 'memoria');
}

/** Disco do Mac: livre = o que o statfs diz (nunca somado ao purgeable); purgeable = o que o macOS libera sozinho. */
export function macDiskInfo(sf: { bsize: number; blocks: number; bavail: number }, vol: { name: string; important: number } | null): DiskInfo {
  const total = sf.bsize * sf.blocks, free = sf.bsize * sf.bavail;
  return vol ? { drive: vol.name, total, free, purgeable: Math.max(0, vol.important - free) } : { drive: 'Mac', total, free };
}

export function diskWarning(d: DiskInfo): Candidate | null {
  if (!(d.total > 0)) return null;
  const freePct = (d.free / d.total) * 100;
  if (freePct >= DISK_ATTENTION) return null;
  const critical = freePct < DISK_CRITICAL;
  return cand('disco', `disco:${d.drive}`, critical ? 'critico' : 'atencao',
    critical ? `Disco ${d.drive} quase cheio` : `Pouco espaço no disco ${d.drive}`,
    `${nf1.format(d.free / GB)} GB livres de ${nf1.format(d.total / GB)} GB (${nf1.format(freePct)} % livre).`, 'arquivos');
}

/**
 * R34: os ajustes salvos não foram lidos e o Folga está nos padrões. Crítico porque é silencioso e tira
 * proteções que o usuário escolheu: o Auto Care volta a desligado e as listas de "nunca fechar" somem.
 */
export function settingsWarning(problem: string | null): Candidate | null {
  if (!problem) return null;
  return cand('ajustes', 'ajustes', 'critico', 'Seus ajustes não foram lidos',
    `O Folga está com os padrões de fábrica: ${problem}. Abra Ajustes, confira e salve de novo.`, 'ajustes');
}

export function autoCareWarning(lastRun: number | null, now: number): Candidate | null {
  if (lastRun === null || now - lastRun >= AUTOCARE_SHOWN_MS) return null;
  return cand('autocare', 'autocare', 'info', `O Auto Care liberou memória às ${hm.format(lastRun)}`,
    'Ele fechou apps parados para abrir espaço. Veja o que saiu no Registro.', 'registro', lastRun);
}

/** reg.exe query: linhas "    Nome    REG_SZ    dado". Nome pode ter espaços; tipo REG_* delimita. */
export function parseRegQuery(text: string): { name: string; type: string; data: string }[] {
  const out: { name: string; type: string; data: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s+(REG_[A-Z_]+)(?:\s+(.*))?$/.exec(line);
    if (m) out.push({ name: m[1]!, type: m[2]!, data: (m[3] ?? '').trim() });
  }
  return out;
}

/** StartupApproved: primeiro byte com o bit baixo ligado (03, 07) = desativado; 02/06 = ativo. */
export function approvedEnabled(hex: string | undefined): boolean {
  if (!hex || hex.length < 2) return true;
  const b = parseInt(hex.slice(0, 2), 16);
  return Number.isNaN(b) ? true : (b & 1) === 0;
}

/**
 * `launchctl print <domínio>`: rótulos da seção `services = {` (carregados: "pid status<TAB>rótulo") e os
 * `"rótulo" => disabled` de `disabled services = {`. Texto fora do formato = conjuntos vazios.
 */
export function parseLaunchctlPrint(text: string): { loaded: Set<string>; disabled: Set<string> } {
  const loaded = new Set<string>(), disabled = new Set<string>();
  let sect: 'services' | 'disabled' | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === '\tservices = {') sect = 'services';
    else if (line === '\tdisabled services = {') sect = 'disabled';
    else if (line === '\t}') sect = null;
    else if (sect === 'services') { const m = /^\t\t\s*\S+\s+\S+\s*\t(\S+)$/.exec(line); if (m) loaded.add(m[1]!); }
    else if (sect === 'disabled') { const m = /^\t\t"(.+)" => disabled$/.exec(line); if (m) disabled.add(m[1]!); }
  }
  return { loaded, disabled };
}

const PLIST_MAX = 1024 * 1024;   // só conferimos o tamanho: o conteúdo nunca é lido

// ---------------------------------------------------------------- monitor

const RANK: Record<Severity, number> = { critico: 0, atencao: 1, info: 2 };
const RUN = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPR = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\';
const REG_SOURCES: { key: string; approved: string; source: StartupApp['source'] }[] = [
  { key: `HKCU\\${RUN}`, approved: `HKCU\\${APPR}Run`, source: 'registro_usuario' },
  { key: `HKLM\\${RUN}`, approved: `HKLM\\${APPR}Run`, source: 'registro_maquina' },
  { key: `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run`, approved: `HKLM\\${APPR}Run32`, source: 'registro_maquina' },
];

export function createWarnings(deps: WarningsDeps) {
  const now = deps.now ?? Date.now;
  const children = new Set<ChildProcess>();
  let stopped = false;   // só stop() liga; apply() antes de start() vale (testes chamam run.* direto)
  const timers: NodeJS.Timeout[] = [];
  const busy = new Set<string>();
  const active = new Map<string, Warning>();
  let lastSig = '';
  const notified = new Set<string>();   // críticos já notificados, até saírem da lista
  let downSince: number | null = null;
  let startupCache: { t: number; apps: StartupApp[] } | null = null;

  // Padrão: spawn com caminho absoluto, shell:false, sem janela. stop() mata o que estiver rodando.
  const exec = deps.exec ?? ((file: string, args: string[]) => new Promise<string>((resolve, reject) => {
    const c = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    children.add(c);
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => c.kill(), 20_000);
    timeout.unref();
    c.stdout.on('data', (d: Buffer) => chunks.push(d));
    c.on('error', e => { clearTimeout(timeout); children.delete(c); reject(e); });
    c.on('close', code => {
      clearTimeout(timeout); children.delete(c);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
      // saída não zero: quem precisa do texto (spctl --status sai 1 com Gatekeeper desligado) lê e.stdout; morte por sinal/tempo não tem
      else reject(Object.assign(new Error(`saiu com ${code}`), code === null ? {} : { stdout: Buffer.concat(chunks).toString('utf8') }));
    });
  }));
  const statfs = deps.statfs ?? ((p: string) => fsStatfs(p));
  const ps = (script: string) => exec(PS(), ['-NoProfile', '-NonInteractive', '-Command', script]);
  // cmd + chcp 65001: sem isso o reg.exe escreve em cp850 e "Antônio" sai errado. Chaves fixas, sem espaços.
  const regQuery = (key: string) => exec(CMD(), ['/d', '/c', 'chcp', '65001', '>nul', '&', REG(), 'query', key]).catch(() => '');

  function list(): Warning[] {
    return [...active.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.lastSeen - a.lastSeen);
  }

  // R26: id estável; mesmo aviso só atualiza lastSeen; causa que some sai da lista; emite só se algo visível mudou.
  function apply(kind: WarningKind, found: (Candidate | null)[]) {
    if (stopped) return;
    const t = now();
    const keep = new Set<string>();
    for (const c of found) {
      if (!c) continue;
      const { since, ...w } = c;
      keep.add(w.id);
      active.set(w.id, { ...w, firstSeen: since ?? active.get(w.id)?.firstSeen ?? t, lastSeen: t, active: true });
    }
    for (const [id, w] of active) if (w.kind === kind && !keep.has(id)) active.delete(id);
    const sig = [...active.values()].map(w => `${w.id}|${w.severity}|${w.title}|${w.detail}`).sort().join('\n');
    if (sig !== lastSig) { lastSig = sig; deps.emit('warnings', list()); }
    // decisão 20: crítico novo (ou que subiu de atenção) notifica uma vez; saiu da lista ou desceu = libera para a próxima vez
    for (const id of notified) if (active.get(id)?.severity !== 'critico') notified.delete(id);
    // só no Mac (decisão 20); stop() vale porque apply() já retornou lá em cima
    for (const w of (deps.platform ?? process.platform) === 'darwin' ? active.values() : []) {
      if (w.severity !== 'critico' || notified.has(w.id)) continue;
      notified.add(w.id);
      try { deps.notify?.(w.title, w.detail); } catch { /* avisar nunca atrapalha a lista de avisos */ }
    }
  }

  // --volume é caro e o aviso roda a cada minuto: guarda 10 min
  let volAt = 0;
  let vol: { name: string; important: number } | null = null;
  async function disk(): Promise<DiskInfo[]> {
    if ((deps.platform ?? process.platform) === 'darwin') {
      // statfs do volume de dados (o home), não do "/" lacrado
      let s;
      try { s = await statfs(homedir()); } catch { return []; }
      if (now() - volAt > 10 * 60_000) {
        const r = await (deps.macVolume ?? (() => macHelper(['--volume', homedir()], null, 15_000)))() as { name?: unknown; important?: unknown } | null;
        // falha da sonda mantém o último valor bom (o nome do disco entra no id do aviso) e tenta de novo na próxima leitura
        if (r && typeof r.name === 'string' && typeof r.important === 'number') { vol = { name: r.name, important: r.important }; volAt = now(); }
      }
      return [macDiskInfo(s, vol)];
    }
    const sys = (process.env.SystemDrive ?? 'C:').toUpperCase();
    const profile = parse(homedir()).root.replace(/\\$/, '').toUpperCase();
    const drives = [...new Set([sys, profile].filter(d => /^[A-Z]:$/.test(d)))];
    const out: DiskInfo[] = [];
    for (const drive of drives) {
      try {
        const s = await statfs(`${drive}\\`);
        out.push({ drive, total: s.bsize * s.blocks, free: s.bsize * s.bavail });
      } catch { /* disco sumiu/sem acesso: fica de fora */ }
    }
    return out;
  }

  // chamada que chega com o mesmo ciclo ocupado não se perde: vira UMA rodada a mais no fim (várias viram uma só)
  const again = new Set<string>();
  const job = (name: string, fn: () => Promise<void> | void) => async () => {
    if (busy.has(name)) { again.add(name); return; }
    busy.add(name);
    try {
      do {
        again.delete(name);
        try { await fn(); } catch { /* falha de consulta não muda os avisos que já existem */ }
      } while (again.has(name));
    } finally { busy.delete(name); }
  };

  const run = {
    probe: job('probe', () => {
      const t = now();
      if (deps.probeAlive()) downSince = null; else downSince ??= t;
      apply('sonda', [downSince !== null && t - downSince > PROBE_DOWN_MS
        ? cand('sonda', 'sonda', 'critico', 'A sonda parou de responder',
          'O Folga não está recebendo leituras de memória. Feche e abra o app.') : null]);
    }),
    fast: job('fast', async () => {
      const s = deps.getState();
      if (s) apply('memoria', [memoryWarning(s.memLoad, deps.getSettings().autoCareThreshold)]);
      apply('autocare', [autoCareWarning(deps.lastAutoCareRun(), now())]);
      apply('ajustes', [settingsWarning(deps.settingsProblem())]);
      const disks = await disk();
      if (disks.length) apply('disco', disks.map(diskWarning));
    }),
    crashes: job('crashes', async () => {
      if ((deps.platform ?? process.platform) === 'darwin') {
        const t = now();
        return apply('travamento', macCrashes(await readCrashEntries(deps.crashDir ?? defaultCrashDir(), t), t));
      }
      apply('travamento', parseCrashes(await ps(PS_CRASHES)));
    }),
    // No Mac este ciclo lê FileVault/Gatekeeper/SIP (comandos fixos, só leitura); comando que falha vira "não sei"
    antivirus: job('antivirus', async () => {
      if ((deps.platform ?? process.platform) === 'darwin') {
        const read = (f: string, a: string[]) => exec(f, a).catch((e: { stdout?: unknown }) => typeof e?.stdout === 'string' ? e.stdout : '');
        const [fv, gk, sip] = await Promise.all([
          read('/usr/bin/fdesetup', ['status']), read('/usr/sbin/spctl', ['--status']), read('/usr/bin/csrutil', ['status']),
        ]);
        const sec = parseMacSecurity({ fv, gk, sip });
        const found = macSecurityWarnings(sec);
        // item que não deu para ler (null) mantém o aviso que já estava na tela
        const ids = { fileVault: 'seguranca:filevault', gatekeeper: 'seguranca:gatekeeper', sip: 'seguranca:sip' } as const;
        for (const k of Object.keys(ids) as (keyof typeof ids)[]) {
          const old = active.get(ids[k]);
          if (sec[k] === null && old) { const { firstSeen, lastSeen: _l, active: _a, ...c } = old; found.push({ ...c, since: firstSeen }); }
        }
        return apply('seguranca', found);
      }
      apply('antivirus', [avWarning(parseAv(await ps(PS_AV)))]);
    }),
  };

  // Mac: só `launchctl print` (verbo de leitura), caminho absoluto, argumentos fixos; nome de plist nunca vai para argv.
  async function readLaunchItems(): Promise<StartupApp[]> {
    const uid = process.getuid?.() ?? 501;
    const dirs = deps.launchDirs ?? [
      { dir: join(homedir(), 'Library', 'LaunchAgents'), source: 'launchagent_usuario' as const, domain: 'gui' as const },
      { dir: '/Library/LaunchAgents', source: 'launchagent_sistema' as const, domain: 'gui' as const },
      { dir: '/Library/LaunchDaemons', source: 'launchdaemon' as const, domain: 'system' as const },
    ];
    const state = new Map<string, ReturnType<typeof parseLaunchctlPrint>>();
    for (const d of new Set(dirs.map(x => x.domain))) {
      // falha aqui rejeita: o estado não é inventado
      const parsed = parseLaunchctlPrint(await exec('/bin/launchctl', ['print', d === 'gui' ? `gui/${uid}` : 'system']));
      if (!parsed.loaded.size) throw new Error('launchctl print sem serviços carregados');   // formato desconhecido: não vira "tudo desativado"
      state.set(d, parsed);
    }
    const apps: StartupApp[] = [];
    for (const d of dirs) {
      const st = state.get(d.domain)!;
      // pasta que não existe = sem itens; outra falha (sem permissão, não é pasta) rejeita: não vira "nenhum item"
      const files = await readdir(d.dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return [] as string[];
        throw new Error(`não deu para ler ${d.dir} (${e.code ?? 'erro'})`);
      });
      for (const f of files) {
        if (!f.endsWith('.plist')) continue;
        // ponytail: rótulo = nome do arquivo; o launchctl usa o Label de dentro do plist (quase sempre igual). Teto conhecido: ler o Label exigiria abrir o plist.
        const label = f.slice(0, -'.plist'.length);
        const name = cleanName(label);
        if (!name) continue;
        const path = join(d.dir, f);
        try {
          const l = await lstat(path);   // sem seguir link: só listamos, nunca abrimos
          if (!(l.isSymbolicLink() || (l.isFile() && l.size <= PLIST_MAX))) continue;
        } catch { continue; }
        apps.push({ name, command: cleanName(path, 1024), source: d.source, enabled: st.loaded.has(label) && !st.disabled.has(label) });
      }
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  async function readStartupApps(): Promise<StartupApp[]> {
    if ((deps.platform ?? process.platform) === 'darwin') return readLaunchItems();
    const apps: StartupApp[] = [];
    const queries = await Promise.all(REG_SOURCES.map(async s => [s, await regQuery(s.key), await regQuery(s.approved)] as const));
    for (const [s, runText, apprText] of queries) {
      const approved = new Map(parseRegQuery(apprText).map(r => [r.name.toLowerCase(), r.data]));
      for (const r of parseRegQuery(runText)) {
        apps.push({ name: r.name, command: r.data, source: s.source, enabled: approvedEnabled(approved.get(r.name.toLowerCase())) });
      }
    }
    const folder = deps.startupFolder ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const approved = new Map(parseRegQuery(await regQuery(`HKCU\\${APPR}StartupFolder`)).map(r => [r.name.toLowerCase(), r.data]));
    for (const f of await readdir(folder).catch(() => [] as string[])) {
      if (!/\.(lnk|url)$/i.test(f)) continue;
      apps.push({ name: f.replace(/\.(lnk|url)$/i, ''), command: join(folder, f), source: 'pasta_inicializar', enabled: approvedEnabled(approved.get(f.toLowerCase())) });
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  return {
    start(): void {
      if (timers.length) return;
      stopped = false;
      const every = (fn: () => Promise<void>, ms: number) => { fn(); timers.push(setInterval(fn, ms).unref()); };
      every(run.probe, PROBE_MS);
      every(run.fast, FAST_MS);
      every(run.crashes, CRASH_MS);
      every(run.antivirus, AV_MS);
    },
    stop(): void {
      stopped = true;
      for (const t of timers.splice(0)) clearInterval(t);
      for (const c of children) c.kill();
      children.clear();
    },
    list,
    disk,
    async startupApps(): Promise<StartupApp[]> {
      if (startupCache && now() - startupCache.t < STARTUP_CACHE_MS) return startupCache.apps;
      const apps = await readStartupApps();
      startupCache = { t: now(), apps };
      return apps;
    },
    /** Um ciclo de cada fonte, direto (testes e script de verificação). */
    run,
  };
}
export type Warnings = ReturnType<typeof createWarnings>;
