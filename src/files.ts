// F-17: arquivos parados, limpeza rápida e Lixeira (D16, D17, R21, R22).
// Nada aqui apaga arquivo do usuário de vez: arquivo do usuário só vai para a Lixeira (R22); só temporários
// com mais de 7 dias e cache de navegador fechado são apagados, e quem chama é a aprovação de um cartão.
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync, unlinkSync, type Dirent, type Stats } from 'node:fs';
import { lstat, opendir, readdir, realpath, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { macHelper, userFolders } from './platform.ts';
import type { QuickCleanCategory, QuickCleanItem, Settings, StaleBasis, StaleFile, StaleScan } from './types.ts';

export type Browser = 'chrome' | 'edge' | 'safari';
export type FilesDeps = {
  getSettings: () => Settings;
  roots?: string[];          // testes: pastas permitidas no lugar das do usuário
  tempDirs?: string[];       // testes: temporários no lugar de %TEMP%
  cacheDirs?: Partial<Record<Browser, string[]>>;   // testes: pastas de cache no lugar das dos navegadores
  // opcionais, só para testes
  recentDir?: string;                                // pasta "Recent" do Windows
  accessTracking?: boolean;                          // pula o fsutil
  browsersOpen?: () => Promise<Partial<Record<Browser, boolean>>>;
  runningKeys?: () => ReadonlySet<string> | null;    // Mac: chaves dos apps abertos (sonda); null = sem leitura = tudo aberto
  trash?: () => Promise<TrashInfo>;
  // testes: Lixeira falsa no lugar do PowerShell/trashItem. Número = quantos entraram (aí a contagem antes/depois não roda)
  sendToTrash?: (paths: string[], roots: string[], appRoot: string | null) => Promise<void | number>;
  meta?: (paths: string[]) => Promise<FileMeta[] | null>;   // testes: Spotlight falso no lugar do `probe-mac --meta`
  openFiles?: () => Promise<ReadonlySet<string> | null>;      // testes: lsof falso (caminhos abertos; null = não deu para ler)
  appRoot?: string | null;   // pasta onde um .app velho vira item (padrão: ~/Downloads no Mac; null = nenhum .app)
  maxEntries?: number; maxMs?: number; now?: () => number;
};
export type Inspected = { path: string; size: number; lastUsed: number; basis: StaleBasis };
export type InspectError = { erro: string };
/** denied = não deu para ler (Mac sem Acesso Total ao Disco): desconhecido, nunca 0 */
export type TrashInfo = { bytes: number; files: number; denied?: boolean };
const TRASH_BATCH = 200;   // um lote lento só perde as respostas dele (o que já foi para a Lixeira continua lá)
/** O que o `probe-mac --meta` diz de um caminho (datas em ms). */
export type FileMeta = { lastUsed: number | null; added: number | null; dataless: boolean; missing: boolean };
const META_BATCH = 500;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/**
 * Mac: último uso = o mais novo entre mtime, "última abertura" e "adicionado" do Spotlight (arquivo que acabou de chegar
 * na pasta não é parado, mesmo aberto há muito tempo). Empate: spotlight, depois adicionado. Sem Spotlight vale o mtime.
 */
function macUsage(mtime: number, m: FileMeta | null): { lastUsed: number; basis: StaleBasis } {
  const used = num(m?.lastUsed), added = num(m?.added);
  const lastUsed = Math.max(mtime, used ?? 0, added ?? 0);
  const basis: StaleBasis = used === lastUsed ? 'spotlight' : added === lastUsed ? 'adicionado' : 'modificacao';
  return { lastUsed, basis };
}

/** Nota do que o macOS protege (Lixeira, cache do Safari). Decisão 17: o Folga não pede Acesso Total ao Disco,
 *  então a nota não manda liberar nada, nem dentro do app nem fora dele. */
export const fdaNote = (): string => 'Não deu para ler: o macOS protege esta pasta e o Folga não pede essa permissão.';
const DAY = 86_400_000;
const MAX_ENTRIES = 100_000;
const MAX_MS = 20_000;
const MAX_DEPTH = 10;
const MAX_FINDINGS = 500;
const TEMP_DAYS = 7;
const PREVIEW_MS = 30_000;   // B6: o preview é caro (varre %TEMP% e caches, roda PowerShell)
const SKIP_DIRS = new Set(['node_modules', '.git', 'appdata', '$recycle.bin', '__pycache__', 'site-packages']);
// D20: marcadores de projeto de código; a pasta que tem um deles não entra na busca de arquivos parados
const PROJECT_MARKERS: ReadonlySet<string> = new Set(['.git', 'package.json', 'pyvenv.cfg', 'pyproject.toml', 'cargo.toml', 'go.mod']);

const MAC = process.platform === 'darwin';

/** Forma do caminho pedido (R21), antes de tocar no disco. null = forma aceitável; o resto do fluxo ainda confere raiz e arquivo. */
export function pathShapeError(raw: unknown, platform: NodeJS.Platform): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || /[\u0000-\u001f]/.test(raw)) return 'caminho inválido';
  if (platform === 'win32') {
    // só letra de unidade (nada de \\servidor, \\?\, \\.\ nem caminho relativo) e nenhum ':' depois dela (fluxos NTFS)
    return !/^[A-Za-z]:[\\/]/.test(raw) || raw.indexOf(':', 2) !== -1 ? 'caminho inválido ou fora das pastas permitidas' : null;
  }
  // absoluto e sem '.'/'..': quem pede não navega, aponta
  return !raw.startsWith('/') || raw.split('/').some(seg => seg === '.' || seg === '..') ? 'caminho inválido ou fora das pastas permitidas' : null;
}
/** Chave de comparação de caminho: o APFS não distingue caixa nem NFC/NFD; o NTFS só não distingue caixa (NFC e NFD são arquivos distintos). */
export const pathKey = (p: string, platform: NodeJS.Platform = process.platform) =>
  (platform === 'darwin' ? p.normalize('NFC') : p).toLowerCase();
// ponytail: toda pasta com extensão é opaca; pasta comum com ponto no nome fica de fora da busca — falso negativo seguro.
// LaunchServices diria "é pacote" com certeza, mas é outro processo por pasta.
/** Pasta-pacote do Mac (.app, .photoslibrary, .bundle…): por dentro é do app, não do usuário. */
export const isPackageDir = (name: string) => /\.[a-z][a-z0-9-]*$/i.test(name);

const SYSROOT = () => process.env.SystemRoot ?? 'C:\\Windows';
const PS = () => join(SYSROOT(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const U8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';

// Scripts fixos: nenhum caminho entra no texto do script (R21); os dados vão por stdin, em JSON UTF-8.
// AllDialogs (e não OnlyErrorDialogs, que suprime a confirmação do Windows): se um arquivo for grande demais para
// a Lixeira ou a Lixeira estiver desligada, o Windows pergunta em vez de apagar de vez em silêncio (R22).
const PS_RECYCLE = U8 + "Add-Type -AssemblyName Microsoft.VisualBasic;" +
  "$r=New-Object IO.StreamReader([Console]::OpenStandardInput(),[Text.Encoding]::UTF8);" +
  "$list=$r.ReadToEnd()|ConvertFrom-Json;" +   // sem @(): no PS 5.1 isso embrulharia a lista inteira em 1 item
  "foreach($p in @($list)){ try{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile([string]$p,'AllDialogs','SendToRecycleBin') }catch{} }";
// Tamanho da Lixeira do usuário (todas as unidades) pelo Shell.
const PS_TRASH = U8 + "$s=(New-Object -ComObject Shell.Application).Namespace(10);$b=0;$n=0;" +
  "foreach($i in $s.Items()){ $n++; $b+=[double]$i.Size };" +
  "ConvertTo-Json -InputObject ([pscustomobject]@{bytes=$b;files=$n}) -Compress";

function run(file: string, args: string[], input: string | null, timeoutMs: number): Promise<string> {
  return new Promise(res => {
    // shell:false e caminho absoluto: armadilha de spawn no Windows (CLAUDE.md)
    const c = spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => c.kill(), timeoutMs);
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', d => { out += d; });
    c.on('error', () => { clearTimeout(timer); res(''); });
    c.on('close', () => { clearTimeout(timer); res(out); });
    c.stdin.on('error', () => {});
    c.stdin.end(input ?? undefined, 'utf8');
  });
}
const runPS = (script: string, input: unknown, timeoutMs: number) =>
  run(PS(), ['-NoProfile', '-NonInteractive', '-Command', script], input === null ? null : JSON.stringify(input), timeoutMs);

const lc = (s: string) => s.toLowerCase();
// M3: arquivo extraído de zip ou copiado mantém o mtime antigo; criação e mudança de metadados contam como "chegou agora"
const ageOf = (st: Stats) => Math.max(st.mtimeMs, st.birthtimeMs, st.ctimeMs);
// O APFS só atualiza o atime quando ele é mais velho que o mtime: um temporário lido todo dia pode parecer parado
// há 7 dias. Por isso, antes de apagar, um lsof só (openFilesMac) tira da lista o que algum processo nosso segura aberto.
// ponytail: teto: arquivo aberto por processo de outro usuário (root) não aparece no lsof -u e pode ir embora
/** Idade de um temporário. No Mac o unlink não respeita arquivo aberto, então leitura recente também segura. */
const tempAge = (st: Stats) => (MAC ? Math.max(ageOf(st), st.atimeMs) : ageOf(st));
const BROWSERS = ['chrome', 'edge', 'safari'] as const;
const BROWSER_NAME: Record<Browser, string> = { chrome: 'Chrome', edge: 'Edge', safari: 'Safari' };
const BROWSER_KEY: Record<Browser, string> = { chrome: 'com.google.chrome', edge: 'com.microsoft.edgemac', safari: 'com.apple.safari' };
const exists = (p: string) => lstat(p).then(() => true, () => false);

const LSOF_ESC: Record<string, number> = { '\\': 92, t: 9, n: 10, r: 13, b: 8, f: 12 };
/**
 * Desfaz o escape do lsof (visto ao vivo em 21/10/2026): byte fora do ASCII vira \xNN, barra invertida vira \\,
 * tab/quebra de linha viram \t/\n. ponytail: outro controle (^X) não é desfeito; nome assim não casa e pode sair.
 */
export function lsofName(s: string): string {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s[i] === '\\' ? /^x([0-9a-f]{2})/i.exec(s.slice(i + 1, i + 4)) : null;
    if (hex) { out.push(parseInt(hex[1]!, 16)); i += 3; }
    else if (s[i] === '\\' && LSOF_ESC[s[i + 1]!] !== undefined) { out.push(LSOF_ESC[s[i + 1]!]!); i++; }
    else out.push(...Buffer.from(s[i]!, 'utf8'));
  }
  return Buffer.from(out).toString('utf8');
}
/** Caminhos abertos pelos processos deste usuário: um lsof só. Falhou, demorou ou saiu torto → null (nada se apaga). */
function openFilesMac(): Promise<ReadonlySet<string> | null> {
  return new Promise(res => {
    // -Fn: uma linha por campo; as de nome começam com 'n' (p = processo, f = descritor)
    const c = spawn('/usr/sbin/lsof', ['-nP', '-Fn', '-u', String(process.getuid?.() ?? -1)], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { c.kill(); res(null); }, 10_000);
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', d => { out += d; });
    c.on('error', () => { clearTimeout(timer); res(null); });
    c.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !out.startsWith('p')) return res(null);
      res(new Set(out.split('\n').filter(l => l.startsWith('n/')).map(l => lsofName(l.slice(1)))));
    });
  });
}

/** `child` está estritamente dentro de `root`? (relative do win32 ignora maiúsculas; outra unidade vira caminho absoluto) */
function inside(root: string, child: string) {
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function realOrNull(p: string) { try { return await realpath(p); } catch { return null; } }
/** Caminho sem link em nenhum ponto (o real é ele mesmo). Pasta de cache e pasta de cada arquivo passam por aqui:
 *  um link trocado ali levaria a limpeza a apagar o que está do outro lado (revisão de segurança). */
// ponytail: no Windows não há permissão por pasta (TCC) a herdar, e o nome curto 8.3 (C:\Users\ANTNIO~1) faria o
// caminho real nunca bater; lá fica como era, sem esta checagem
async function isRealPath(p: string) {
  if (process.platform === 'win32') return true;
  const r = await realOrNull(p);
  return r !== null && r === p;
}

/** Passeio com teto de entradas e de tempo. Não segue link nem junção; lê metadados com lstat, em lotes. */
export type Budget = { entries: number; maxEntries: number; deadline: number; now: () => number; stopped: boolean };
export async function walk(
  root: string, maxDepth: number, skipDir: ((name: string) => boolean) | null, b: Budget,
  onFile: (path: string, st: Stats) => void | Promise<void>,
  projectMarkers: ReadonlySet<string> | null = null,
) {
  const stack: Array<[string, number]> = [[root, 0]];
  let active = 0;
  async function visit(dir: string, depth: number) {
    const files: string[] = [];
    const subdirs: Array<[string, number]> = [];
    let project = false;
    try {
      const d = await opendir(dir);
      try {
        for await (const e of d as AsyncIterable<Dirent>) {
          if (b.entries >= b.maxEntries || b.now() > b.deadline) { b.stopped = true; break; }
          b.entries++;
          // D20: pasta de projeto de código (abaixo da raiz) fica de fora inteira: dependência parada não é lixo
          if (projectMarkers && depth > 0 && projectMarkers.has(lc(e.name))) { project = true; break; }
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) {
            if (depth < maxDepth && !(skipDir && skipDir(e.name))) subdirs.push([join(dir, e.name), depth + 1]);
          } else if (e.isFile()) files.push(join(dir, e.name));
        }
      } finally { await d.close().catch(() => {}); }
    } catch { /* sem acesso à pasta: segue */ }
    if (project) return;
    stack.push(...subdirs);
    for (let i = 0; i < files.length && !b.stopped; i += 64) {
      await Promise.all(files.slice(i, i + 64).map(async f => {
        try { const st = await lstat(f); if (st.isFile()) await onFile(f, st); } catch { /* sumiu ou travado */ }
      }));
    }
  }
  // 6 pastas ao mesmo tempo: pasta grande de temporários leva segundos em fila única
  async function worker() {
    while (!b.stopped) {
      const it = stack.pop();
      if (!it) { if (active === 0) return; await new Promise(r => setImmediate(r)); continue; }
      active++;
      try { await visit(it[0], it[1]); } finally { active--; }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
}
export const newBudget = (maxEntries: number, maxMs: number, now: () => number): Budget =>
  ({ entries: 0, maxEntries, deadline: now() + maxMs, now, stopped: false });

export function createFiles(deps: FilesDeps) {
  const now = deps.now ?? Date.now;
  let lastScan: StaleScan | null = null;
  let trackingCache: boolean | null = null;

  // ---------- Mac: Spotlight e .app de Downloads ----------
  /** Metadados em lotes; lote sem resposta (ou resposta torta) vira null por item e answered = false. Sempre pergunta ao menos uma vez. */
  async function metaAll(ps: string[]): Promise<{ list: Array<FileMeta | null>; answered: boolean }> {
    const list: Array<FileMeta | null> = [];
    let answered = true;
    for (let i = 0; i === 0 || i < ps.length; i += META_BATCH) {
      const part = ps.slice(i, i + META_BATCH);
      const r = await (deps.meta ? deps.meta(part) : macHelper(['--meta'], part, 30_000)).catch(() => null);
      const got = Array.isArray(r) && r.length === part.length ? (r as Array<FileMeta | null>) : null;
      if (!got) answered = false;
      list.push(...part.map((_, j) => (got?.[j] && typeof got[j] === 'object' ? got[j] : null)));
    }
    return { list, answered };
  }
  /** Pasta (real) onde um .app velho pode virar item; só vale se estiver numa pasta permitida. */
  function appRootIn(roots: string[]): string | null {
    const want = deps.appRoot !== undefined ? deps.appRoot : (MAC ? join(homedir(), 'Downloads') : null);
    if (!want) return null;
    let r: string;
    try { r = realpathSync.native(want); } catch { return null; }
    return roots.some(o => o === r || inside(o, r)) ? r : null;
  }
  /** Tamanho somado de um pacote .app e o mtime mais novo lá dentro (a pasta em si muda de data por qualquer coisa). */
  async function appStats(app: string, b: Budget): Promise<{ size: number; mtime: number }> {
    let size = 0, mtime = 0;
    await walk(app, 32, null, b, (_p, st) => { size += st.size; if (st.mtimeMs > mtime) mtime = st.mtimeMs; });
    return { size, mtime };
  }

  // ---------- pastas permitidas ----------
  function allowedRoots(): string[] {
    const candidates = deps.roots ?? userFolders();
    const seen = new Set<string>();
    const real: string[] = [];
    for (const c of candidates) {
      let r: string;
      try { r = realpathSync.native(c); } catch { continue; }   // não existe: fora
      if (!seen.has(lc(r))) { seen.add(lc(r)); real.push(r); }
    }
    // pasta dentro de outra pasta permitida só duplicaria a varredura
    return real.filter(r => !real.some(o => o !== r && inside(o, r)));
  }

  // ---------- sinal de uso ----------
  async function accessTracking(): Promise<boolean> {
    if (deps.accessTracking !== undefined) return deps.accessTracking;
    if (process.platform !== 'win32') return false;   // o fsutil é do Windows
    if (trackingCache === null) {
      const out = await run(join(SYSROOT(), 'System32', 'fsutil.exe'), ['behavior', 'query', 'disablelastaccess'], null, 8_000);
      const v = /=\s*(\d)/.exec(out)?.[1];
      trackingCache = v === '0' || v === '2';   // 0 e 2 = ligado; 1 e 3 = desligado; sem resposta = tratar como desligado
    }
    return trackingCache;
  }

  /** nome do atalho em Recent (sem .lnk, minúsculo) → hora do atalho */
  async function recentMap(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    const dir = deps.recentDir ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Recent');
    let names: string[] = [];
    try { names = await readdir(dir); } catch { return m; }
    for (let i = 0; i < names.length; i += 64) {
      await Promise.all(names.slice(i, i + 64).filter(n => lc(n).endsWith('.lnk')).map(async n => {
        try {
          const t = (await lstat(join(dir, n))).mtimeMs;
          const k = lc(n.slice(0, -4));
          if (t > (m.get(k) ?? 0)) m.set(k, t);
        } catch { /* ignora */ }
      }));
    }
    return m;
  }

  /** Último uso: o maior entre acesso/modificação e o atalho de mesmo nome em Recent. */
  function usage(name: string, st: Stats, tracking: boolean, recent: Map<string, number>): { lastUsed: number; basis: StaleBasis } {
    const own = tracking ? Math.max(st.atimeMs, st.mtimeMs) : st.mtimeMs;
    const lnk = recent.get(lc(name)) ?? 0;
    return lnk > own
      ? { lastUsed: lnk, basis: 'recentes' }
      : { lastUsed: own, basis: tracking ? 'acesso' : 'modificacao' };
  }

  // ---------- varredura ----------
  async function doScan(opts: { olderThanDays?: number; minMB?: number }): Promise<StaleScan> {
    const s = deps.getSettings();
    const days = opts.olderThanDays ?? s.staleDays;
    const minBytes = (opts.minMB ?? s.staleMinMB) * 1024 * 1024;
    const t0 = now();
    const roots = allowedRoots();
    const tracking = await accessTracking();
    const recent = await recentMap();
    const b = newBudget(deps.maxEntries ?? MAX_ENTRIES, deps.maxMs ?? MAX_MS, now);
    const found: StaleFile[] = [];
    let total = 0;
    // Mac: o passeio só junta candidatos (o último uso nunca é menor que o mtime, então o corte pelo mtime não perde nada);
    // quem decide é o Spotlight, depois, em lotes
    const cands: Array<{ path: string; root: string; size: number; mtime: number; isApp?: true }> = [];
    for (const root of roots) {
      await walk(root, MAX_DEPTH, n => n.startsWith('.') || SKIP_DIRS.has(lc(n)) || (MAC && isPackageDir(n)), b, (path, st) => {
        if (st.size < minBytes) return;
        if (MAC) { if ((t0 - st.mtimeMs) / DAY >= days) cands.push({ path, root, size: st.size, mtime: st.mtimeMs }); return; }
        const name = basename(path);
        const u = usage(name, st, tracking, recent);
        if ((t0 - u.lastUsed) / DAY < days) return;
        total += st.size;
        found.push({ path, name, root, size: st.size, lastUsed: u.lastUsed, lastModified: st.mtimeMs, basis: u.basis });
      }, PROJECT_MARKERS);
      if (b.stopped) break;
    }
    let tracked = tracking;
    if (MAC) {
      // decisão 12: .app (pasta de verdade, não link) filho direto do Downloads vira um item só, com o tamanho total
      const appRoot = appRootIn(roots);
      if (appRoot && !b.stopped) {
        const root = roots.find(o => o === appRoot || inside(o, appRoot))!;
        let ents: Dirent[] = [];
        try { ents = await readdir(appRoot, { withFileTypes: true }); } catch { /* sem acesso */ }
        for (const e of ents) {
          if (b.stopped || !e.isDirectory() || !e.name.toLowerCase().endsWith('.app')) continue;
          const path = join(appRoot, e.name);
          const a = await appStats(path, b);
          if (b.stopped) break;   // soma cortada pelo teto: o tamanho não bateria com o da aprovação (M5)
          if (a.size >= minBytes && (t0 - a.mtime) / DAY >= days) cands.push({ path, root, size: a.size, mtime: a.mtime, isApp: true });
        }
      }
      const { list, answered } = await metaAll(cands.map(c => c.path));
      tracked = answered;
      cands.forEach((c, i) => {
        const m = list[i] ?? null;
        if (m && (m.missing === true || m.dataless === true)) return;   // sumiu ou só existe no iCloud: nunca entra
        const u = macUsage(c.mtime, m);
        if ((t0 - u.lastUsed) / DAY < days) return;
        total += c.size;
        found.push({ path: c.path, name: basename(c.path), root: c.root, size: c.size, lastUsed: u.lastUsed, lastModified: c.mtime, basis: u.basis, ...(c.isApp ? { isApp: true as const } : {}) });
      });
    }
    found.sort((a, c) => c.size - a.size);
    const scan: StaleScan = {
      t: t0, durationMs: now() - t0, roots, scanned: b.entries, truncated: b.stopped, accessTracking: tracked,
      olderThanDays: days, minBytes, files: found.slice(0, MAX_FINDINGS), totalBytes: total,
    };
    lastScan = scan;
    return scan;
  }
  // Uma varredura por vez: a segunda espera a primeira.
  let chain: Promise<unknown> = Promise.resolve();
  function scan(opts: { olderThanDays?: number; minMB?: number } = {}): Promise<StaleScan> {
    const p = chain.then(() => doScan(opts));
    chain = p.catch(() => {});
    return p;
  }

  // ---------- pasta de projeto de código (D20) e pacote do Mac ----------
  const projectCache = new Map<string, boolean>();
  /** Alguma pasta entre a raiz permitida e o arquivo é projeto (marcador) ou, no Mac, pacote? (a raiz em si não conta, como na busca) */
  async function inProject(file: string, roots: string[]): Promise<string | null> {
    const root = roots.find(r => inside(r, file));
    if (!root) return null;
    let dir = dirname(file);
    while (inside(root, dir)) {
      if (MAC && isPackageDir(basename(dir))) return 'está dentro de um pacote (app ou biblioteca)';
      const key = lc(dir);
      let hit = projectCache.get(key);
      if (hit === undefined) {
        hit = (await Promise.all([...PROJECT_MARKERS].map(m => exists(join(dir, m))))).some(Boolean);
        projectCache.set(key, hit);
      }
      if (hit) return 'está dentro de uma pasta de projeto de código';   // D20
      dir = dirname(dir);
    }
    return null;
  }

  // ---------- revalidação de caminhos (R21) ----------
  /**
   * Um caminho só passa se estiver dentro de uma pasta permitida, existir e for arquivo comum (não pasta, não link).
   * Única pasta aceita: no Mac, um .app (pasta de verdade) filho direto do appRoot (decisão 12).
   */
  async function inspect(paths: string[]): Promise<Array<Inspected | InspectError>> {
    projectCache.clear();   // a pasta pode ter virado (ou deixado de ser) projeto desde a última validação
    const roots = allowedRoots();
    const tracking = await accessTracking();
    const recent = await recentMap();
    const appRoot = MAC ? appRootIn(roots) : null;
    const one = async (raw: unknown): Promise<Inspected | InspectError> => {
      const shape = pathShapeError(raw, process.platform);
      if (shape) return { erro: shape };
      const full = resolve(raw as string);   // normaliza '..' e '/'
      // o que vale é o caminho real (resolve 8.3, caixa e junções): ele tem que estar dentro de uma pasta permitida
      const real = await realOrNull(full);
      if (!real) return { erro: roots.some(r => inside(r, full)) ? 'o arquivo não existe mais' : 'fora das pastas permitidas' };
      if (!roots.some(r => inside(r, real))) return { erro: 'fora das pastas permitidas' };
      const [st, st2] = await Promise.all([lstat(full).catch(() => null), lstat(real).catch(() => null)]);
      if (!st || !st2) return { erro: 'o arquivo não existe mais' };
      if (st.isSymbolicLink() || st2.isSymbolicLink()) return { erro: 'é um atalho ou link, não um arquivo' };
      const isApp = !!appRoot && st2.isDirectory() && dirname(real) === appRoot && lc(real).endsWith('.app');
      if (!st2.isFile() && !isApp) return { erro: 'não é um arquivo comum' };
      const blocked = await inProject(real, roots);
      if (blocked) return { erro: blocked };
      if (isApp) {
        const a = await appStats(real, newBudget(MAX_ENTRIES, MAX_MS, now));
        return { path: real, size: a.size, lastUsed: a.mtime, basis: 'modificacao' };   // lastUsed: mtime, o Spotlight entra abaixo
      }
      if (MAC) return { path: real, size: st2.size, lastUsed: st2.mtimeMs, basis: 'modificacao' };
      return { path: real, size: st2.size, ...usage(basename(real), st2, tracking, recent) };
    };
    const out: Array<Inspected | InspectError> = [];
    for (let i = 0; i < paths.length; i += 32) out.push(...await Promise.all(paths.slice(i, i + 32).map(one)));
    if (MAC) {
      // mesma regra da busca: a aprovação (M5) compara o lastUsed visto no cartão com este
      const idx = out.flatMap((x, i) => ('erro' in x ? [] : [i]));
      if (idx.length) {
        const { list } = await metaAll(idx.map(i => (out[i] as Inspected).path));
        idx.forEach((i, k) => {
          const x = out[i] as Inspected, m = list[k] ?? null;
          if (m?.missing === true) out[i] = { erro: 'o arquivo não existe mais' };
          else if (m?.dataless === true) out[i] = { erro: 'só existe no iCloud' };
          else out[i] = { ...x, ...macUsage(x.lastUsed, m) };
        });
      }
    }
    return out;
  }

  // ---------- Lixeira ----------
  /** Itens na Lixeira agora; null = não deu para ler (nunca fingir que são 0). */
  async function trashCount(): Promise<number | null> {
    try { return (await (deps.trash ? deps.trash() : readTrash())).files; } catch { return null; }
  }
  async function recycle(paths: string[]): Promise<{ ok: string[]; failed: string[]; inTrash: number | null }> {
    const checked = await inspect(paths);
    const send: string[] = [];
    const sentFor = new Map<string, string>();   // caminho real → pedido original
    const failed: string[] = [];
    paths.forEach((p, i) => {
      const c = checked[i]!;
      if ('erro' in c) failed.push(p); else { send.push(c.path); sentFor.set(c.path, p); }
    });
    const ok: string[] = [];
    let inTrash: number | null = 0;
    if (send.length) {
      // Mac: quem diz quantos entraram é o trashItem (a Lixeira em si fica atrás do Acesso Total ao Disco)
      const before = MAC ? null : await trashCount();
      const roots = allowedRoots();
      const n = deps.sendToTrash ? await deps.sendToTrash(send, roots, appRootIn(roots))
        : MAC ? await macTrash(send, roots)
        : void await runPS(PS_RECYCLE, send, 120_000);
      // o disco diz o que saiu da pasta; a contagem da Lixeira (antes × depois) diz quantos de fato entraram (M4)
      for (const real of send) (await exists(real) ? failed : ok).push(sentFor.get(real)!);
      if (typeof n === 'number') inTrash = n;
      else if (MAC) inTrash = null;
      else {
        const after = await trashCount();
        inTrash = before === null || after === null ? null : Math.max(0, after - before);
      }
    }
    return { ok, failed, inTrash };
  }

  /** `probe-mac --trash` em lotes: ele revalida cada caminho sozinho (inclusive o .app só filho direto do appRoot). */
  async function macTrash(paths: string[], roots: string[]): Promise<number> {
    const appRoot = appRootIn(roots);
    let n = 0;
    for (let i = 0; i < paths.length; i += TRASH_BATCH) {
      const part = paths.slice(i, i + TRASH_BATCH);
      const r = await macHelper(['--trash'], { roots, appRoot, paths: part }, 120_000);
      // sem resposta = nenhum confirmado; o exists() de quem chama diz o que saiu da pasta
      if (Array.isArray(r)) n += r.filter(x => !!x && typeof x === 'object' && (x as { ok?: unknown }).ok === true && (x as { inTrash?: unknown }).inTrash === true).length;
    }
    return n;
  }

  // ---------- limpeza rápida ----------
  const tempDirs = () => deps.tempDirs ?? [tmpdir()];
  function cacheDirs(): Record<Browser, string[]> {
    if (deps.cacheDirs) return { chrome: deps.cacheDirs.chrome ?? [], edge: deps.cacheDirs.edge ?? [], safari: deps.cacheDirs.safari ?? [] };
    if (MAC) {
      const caches = join(homedir(), 'Library', 'Caches');
      // Chrome/Edge: perfis → Cache/Cache_Data e Code Cache, como no Windows; Safari: a pasta inteira (protegida pelo macOS)
      return { chrome: [join(caches, 'Google', 'Chrome')], edge: [join(caches, 'Microsoft Edge')], safari: [join(caches, 'com.apple.Safari')] };
    }
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return { chrome: [join(local, 'Google', 'Chrome', 'User Data')], edge: [join(local, 'Microsoft', 'Edge', 'User Data')], safari: [] };
  }
  async function profileCaches(userData: string): Promise<string[]> {
    const out: string[] = [];
    let profiles: Dirent[] = [];
    try { profiles = await readdir(userData, { withFileTypes: true }); } catch { return out; }
    for (const p of profiles) {
      if (!p.isDirectory()) continue;
      for (const sub of [['Cache', 'Cache_Data'], ['Code Cache']]) {
        const d = join(userData, p.name, ...sub);
        if (await exists(d)) out.push(d);
      }
    }
    return out;
  }
  async function browsersOpen(): Promise<Record<Browser, boolean>> {
    if (MAC && (deps.runningKeys || !deps.browsersOpen)) {
      const keys = deps.runningKeys?.() ?? null;
      // sem leitura da sonda = tratar como aberto (nunca apagar o cache de um navegador que pode estar em uso)
      return { chrome: !keys || keys.has(BROWSER_KEY.chrome), edge: !keys || keys.has(BROWSER_KEY.edge), safari: !keys || keys.has(BROWSER_KEY.safari) };
    }
    if (deps.browsersOpen) { const o = await deps.browsersOpen(); return { chrome: !!o.chrome, edge: !!o.edge, safari: !!o.safari }; }
    const out = await run(join(SYSROOT(), 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], null, 15_000);
    // sem resposta da tasklist = tratar como aberto (nunca apagar o cache de um navegador que pode estar em uso)
    if (!out) return { chrome: true, edge: true, safari: true };
    return { chrome: /"chrome\.exe"/i.test(out), edge: /"msedge\.exe"/i.test(out), safari: false };
  }

  /** Arquivos que a limpeza apagaria: temporários com mais de 7 dias e caches de navegador fechado. */
  async function collect(opts: { size?: boolean } = {}): Promise<{
    temp: Array<[string, Stats]>;
    cache: Record<Browser, Array<[string, Stats]>>;
    open: Record<Browser, boolean>;
    safari: { bytes: number; denied: boolean } | null;   // Safari: só tamanho (Swift) e nota; nunca entra na lista nem é apagado
  }> {
    const limit = now() - TEMP_DAYS * DAY;
    const budget = () => newBudget(MAX_ENTRIES * 5, 60_000, now);
    const temp: Array<[string, Stats]> = [];
    const cache: Record<Browser, Array<[string, Stats]>> = { chrome: [], edge: [], safari: [] };
    const dirs = cacheDirs();
    let safari: { bytes: number; denied: boolean } | null = null;
    // temporários, caches e a consulta de processos andam juntos: o preview aparece quando o mais lento termina
    const [open] = await Promise.all([
      browsersOpen(),
      // caminho real (/var → /private/var): é como o lsof devolve os abertos
      (async () => { const b = budget(); for (const d of tempDirs()) await walk(await realOrNull(d) ?? d, 32, null, b, (p, st) => { if (tempAge(st) < limit) temp.push([p, st]); }); })(),
      ...BROWSERS.map(async br => {
        // Safari: pasta protegida; nunca acionável, legível ou não (o Folga não apaga esse cache). Só o preview mede, pelo Swift.
        if (br === 'safari') {
          if (opts.size === false) return;
          for (const d of dirs.safari) {
            if (!await exists(d)) continue;
            const r = await macHelper(['--size'], d, 20_000) as { bytes?: unknown; denied?: unknown } | null;
            const denied = !r || typeof r !== 'object' || r.denied === true;
            safari = { bytes: (safari?.bytes ?? 0) + (denied ? 0 : Math.max(0, Number(r.bytes) || 0)), denied: (safari?.denied ?? false) || denied };
          }
          return;
        }
        const targets = deps.cacheDirs ? dirs[br] : (await Promise.all(dirs[br].map(profileCaches))).flat();
        const b = budget();
        for (const d of targets) if (await isRealPath(d)) await walk(d, 32, null, b, (p, st) => { cache[br].push([p, st]); });
      }),
    ]);
    return { temp, cache, open, safari };
  }
  const sum = (l: Array<[string, Stats]>) => l.reduce((a, [, st]) => a + st.size, 0);

  // B6: single-flight + cache de 30 s; quickClean invalida. `fresh` (aprovação) sempre coleta de novo.
  let previewP: Promise<QuickCleanItem[]> | null = null;
  let previewAt: number | null = null;   // null = coleta em andamento
  let previewGen = 0;
  function quickCleanPreview(opts: { fresh?: boolean } = {}): Promise<QuickCleanItem[]> {
    if (previewP && !opts.fresh && (previewAt === null || now() - previewAt < PREVIEW_MS)) return previewP;
    const gen = previewGen;
    previewAt = null;
    const p: Promise<QuickCleanItem[]> = collectPreview().then(r => { if (gen === previewGen && previewP === p) previewAt = now(); return r; });
    previewP = p;
    p.catch(() => { if (previewP === p) previewP = null; });
    return p;
  }
  async function collectPreview(): Promise<QuickCleanItem[]> {
    const [{ temp, cache, open, safari }, t] = await Promise.all([collect(), deps.trash ? deps.trash() : trashInfo()]);
    const items: QuickCleanItem[] = [{
      category: 'temp_usuario', label: 'Arquivos temporários com mais de 7 dias', bytes: sum(temp), files: temp.length, actionable: true,
    }];
    // cache: só o de navegador fechado conta como "a apagar"; se todos estiverem abertos, mostra o tamanho só como informação
    const closed = BROWSERS.filter(b => !open[b] && cache[b].length);
    const opened = BROWSERS.filter(b => open[b] && cache[b].length);
    const pick = closed.length ? closed : opened;
    const list = pick.flatMap(b => cache[b]);
    const and = (l: string[]) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} e ${l.at(-1)}` : l[0]!);
    const notes = [
      ...(opened.length ? [`${and(opened.map(b => BROWSER_NAME[b]))} ${opened.length > 1 ? 'abertos' : 'aberto'}: feche para limpar o cache`] : []),
      // Safari protegido: nunca acionável; sem permissão = desconhecido (fdaNote), com o tamanho só informativo
      ...(safari ? [safari.denied ? `Safari: ${fdaNote()}` : `Safari: ${Math.round(safari.bytes / 1048576)} MB que o Folga não apaga (pasta protegida pelo macOS)`] : []),
    ];
    items.push({
      category: 'cache_navegador', label: 'Cache dos navegadores', bytes: sum(list), files: list.length, actionable: closed.length > 0,
      ...(notes.length ? { note: notes.join(' · ') } : {}),
    });
    if (!MAC) items.push({
      category: 'lixeira', label: 'Lixeira do Windows', bytes: t.bytes, files: t.files, actionable: false, note: 'Esvazie pela Lixeira do Windows',
    });
    else if (t.denied) items.push({ category: 'lixeira', label: 'Lixeira', bytes: 0, files: 0, actionable: false, unknown: true, note: fdaNote() });
    else items.push({ category: 'lixeira', label: 'Lixeira', bytes: t.bytes, files: t.files, actionable: false, note: 'Esvazie pelo Finder' });
    return items;
  }
  async function readTrash(): Promise<TrashInfo> {
    if (MAC) {
      // sem permissão (ou sem resposta) = desconhecido; nada aqui tenta contornar nem pede a permissão
      const j = await macHelper(['--size'], join(homedir(), '.Trash'), 20_000) as { bytes?: unknown; files?: unknown; denied?: unknown } | null;
      if (!j || typeof j !== 'object' || j.denied === true) return { bytes: 0, files: 0, denied: true };
      return { bytes: Math.max(0, Number(j.bytes) || 0), files: Math.max(0, Number(j.files) || 0) };
    }
    const j = JSON.parse(await runPS(PS_TRASH, null, 20_000)) as { bytes?: number; files?: number };
    return { bytes: Math.max(0, Number(j.bytes) || 0), files: Math.max(0, Number(j.files) || 0) };
  }
  const trashInfo = () => readTrash().catch((): TrashInfo => (MAC ? { bytes: 0, files: 0, denied: true } : { bytes: 0, files: 0 }));

  /** Apaga de vez só o que o preview marca como acionável. `categories` limita ao que o cartão aprovado mostrava. */
  async function quickClean(opts: { categories?: QuickCleanCategory[] } = {}): Promise<{ bytes: number; files: number; skipped: number }> {
    previewGen++; previewP = null;   // o que o preview guardou deixou de valer
    const want = new Set<QuickCleanCategory>(opts.categories ?? ['temp_usuario', 'cache_navegador']);
    const { temp, cache, open } = await collect({ size: false });   // só o preview mede o Safari
    const limit = now() - TEMP_DAYS * DAY;
    const todo: Array<[string, Stats]> = [];
    let skipped = 0;
    if (want.has('temp_usuario') && temp.length) {
      // I2: no Mac o unlink não respeita arquivo aberto; o que está aberto fica, e sem a lista nenhum temporário sai
      const held = deps.openFiles ? await deps.openFiles() : MAC ? await openFilesMac() : undefined;
      const keys = held && new Set([...held].map(k => pathKey(k)));
      if (keys === null) skipped += temp.length;
      else for (const [p, st] of temp) if (keys?.has(pathKey(p))) skipped++; else todo.push([p, st]);
    }
    let bytes = 0, files = 0;
    /** old = temporário: ainda tem de ser antigo na hora do unlink.
     *  Revisão de segurança: apagar pelo caminho inteiro deixa uma corrida (a pasta vira link entre a checagem e o
     *  unlink e o unlink apaga o arquivo do outro lado, numa pasta protegida). Aqui o processo entra na pasta
     *  (chdir), confere que entrou na pasta certa e apaga pelo NOME: trocar a pasta depois não muda onde o unlink cai.
     *  Tudo síncrono dentro de cada pasta: nenhum outro código roda com o diretório atual trocado. */
    const del = (list: Array<[string, Stats]>, old: boolean) => {
      const porPasta = new Map<string, string[]>();
      for (const [p] of list) { const d = dirname(p); porPasta.set(d, [...(porPasta.get(d) ?? []), basename(p)]); }
      const antes = process.cwd();
      const mesma = (a: string, b: string) => process.platform === 'win32' || a === b;   // Windows: ver isRealPath
      for (const [d, nomes] of porPasta) {
        try {
          process.chdir(d);   // segue link se a pasta já virou link: a conferência abaixo pega
          if (!mesma(process.cwd(), d)) { skipped += nomes.length; continue; }
          for (const n of nomes) {
            try {
              const st = lstatSync(n);   // reconfere logo antes: ainda arquivo comum e (se temporário) ainda antigo
              if (!st.isFile() || (old && tempAge(st) >= limit)) { skipped++; continue; }
              unlinkSync(n);
              bytes += st.size; files++;
            } catch { skipped++; }   // travado, em uso ou sem permissão: fica
          }
        } catch { skipped += nomes.length; }
        finally { try { process.chdir(antes); } catch { /* a pasta de antes sumiu: segue */ } }
      }
    };
    del(todo, true);
    // M2: o navegador pode ter aberto desde a coleta; confere de novo logo antes de apagar os arquivos de cada um
    if (want.has('cache_navegador')) {
      for (const b of BROWSERS) {
        if (open[b] || !cache[b].length) continue;
        if ((await browsersOpen())[b]) { skipped += cache[b].length; continue; }
        del(cache[b], false);
      }
    }
    return { bytes, files, skipped };
  }

  return {
    allowedRoots,
    last(): StaleScan | null { return lastScan; },
    scan, inspect, quickCleanPreview, recycle, quickClean,
  };
}
export type Files = ReturnType<typeof createFiles>;
