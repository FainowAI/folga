// Dados dos apps: mede cada pasta de dados de app; apaga de vez SÓ o cache recriável que uma entrada de
// CACHE_RULES produz, de app fechado (allowlist, R22). O resto aparece com tamanho e "o Folga não limpa".
// Segurança: o id que chega no clean nunca vira caminho; os alvos são recalculados das regras e de nomes lidos
// do disco, link nunca é seguido (o rm do Node apaga o link, não o alvo) e o dono é reconferido antes de cada rm.
import { spawn } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { newBudget, walk } from './files.ts';
import type { AppDataEntry, AppDataItem, AppDataScan } from './types.ts';

export type AppDataBase = 'appSupport' | 'caches' | 'containers' | 'groupContainers' | 'localAppData' | 'roamingAppData';
export type CacheRule = {
  id: string; os: 'darwin' | 'win32'; label: string; base: AppDataBase; dir: string;   // '*' = cada pasta-filha
  owner: readonly string[] | 'folder'; profiles?: boolean; subdirs?: readonly string[]; versions?: readonly string[];
};

const CHROMIUM = ['Cache', 'Code Cache', 'GPUCache', 'GraphiteDawnCache', 'DawnWebGPUCache', 'ShaderCache'] as const;
const GPU = CHROMIUM.slice(2);   // Cache e Code Cache do Chrome/Edge são da limpeza rápida

// Pastas e bundle ids conferidos ao vivo em 20/10/2026. Fathom ficou de fora: a pasta existe, o app não está instalado.
export const CACHE_RULES: readonly CacheRule[] = [
  { id: 'claude', os: 'darwin', label: 'Claude', base: 'appSupport', dir: 'Claude', owner: ['com.anthropic.claudefordesktop'], subdirs: CHROMIUM, versions: ['claude-code', 'claude-code-vm'] },
  { id: 'code', os: 'darwin', label: 'VS Code', base: 'appSupport', dir: 'Code', owner: ['com.microsoft.vscode'], subdirs: [...CHROMIUM, 'CachedData'] },
  { id: 'miro', os: 'darwin', label: 'Miro', base: 'appSupport', dir: 'RealtimeBoard', owner: ['com.electron.realtimeboard'], subdirs: CHROMIUM },
  { id: 'chrome', os: 'darwin', label: 'Chrome', base: 'appSupport', dir: 'Google/Chrome', owner: ['com.google.chrome'], profiles: true, subdirs: GPU },
  { id: 'caches', os: 'darwin', label: 'Cache', base: 'caches', dir: '*', owner: 'folder' },
  { id: 'claude', os: 'win32', label: 'Claude', base: 'roamingAppData', dir: 'Claude', owner: ['claude'], subdirs: CHROMIUM, versions: ['claude-code'] },
  { id: 'code', os: 'win32', label: 'VS Code', base: 'roamingAppData', dir: 'Code', owner: ['code'], subdirs: [...CHROMIUM, 'CachedData'] },
  { id: 'chrome', os: 'win32', label: 'Chrome', base: 'localAppData', dir: 'Google/Chrome/User Data', owner: ['chrome'], profiles: true, subdirs: GPU },
  { id: 'edge', os: 'win32', label: 'Edge', base: 'localAppData', dir: 'Microsoft/Edge/User Data', owner: ['msedge'], profiles: true, subdirs: GPU },
];

const VM = 'Disco da máquina virtual do Claude: não é cache, o Folga não limpa.';
export const NOT_CACHE: readonly { os: 'darwin' | 'win32'; base: AppDataBase; path: string; text: string }[] = [
  { os: 'darwin', base: 'appSupport', path: 'Claude/vm_bundles', text: VM },
  { os: 'win32', base: 'roamingAppData', path: 'Claude/vm_bundles', text: VM },
];

const WHERE: Record<AppDataBase, string> = {
  appSupport: 'Suporte a Aplicativos', caches: 'Caches', containers: 'Contêineres', groupContainers: 'Contêineres de Grupo',
  localAppData: 'AppData Local', roamingAppData: 'AppData Roaming',
};
/**
 * FOLGA_APPDATA_BASES (testes e verificação ao vivo). Lança se não for objeto só com bases conhecidas e caminhos
 * absolutos: o servidor não sobe, em vez de cair no ~/Library real ou de varrer '/' por um JSON torto.
 */
export function parseAppDataBases(raw: string): Partial<Record<AppDataBase, string>> {
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('FOLGA_APPDATA_BASES: use um objeto JSON');
  for (const [k, p] of Object.entries(v)) {
    if (!Object.hasOwn(WHERE, k)) throw new Error(`FOLGA_APPDATA_BASES: base desconhecida: ${k}`);
    if (typeof p !== 'string' || !p || !isAbsolute(p)) throw new Error(`FOLGA_APPDATA_BASES: ${k} precisa de caminho absoluto`);
  }
  return v as Partial<Record<AppDataBase, string>>;
}
const PROFILE = /^(Default|Profile \d+|Guest Profile|System Profile)$/;
const BUNDLE_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;   // o que decide é casar com app instalado (installedIds)
const NO_CACHE = 'Sem cache reconhecido: o Folga não limpa.';
const NO_APP = 'Cache sem app identificado: o Folga não limpa.';

/** Maior versão numérica (por parte); null se a lista for vazia ou algum nome não for versão. */
export function newestVersion(names: readonly string[]): string | null {
  if (!names.length || names.some(n => !/^\d+(\.\d+)*$/.test(n))) return null;
  const cmp = (a: string, b: string) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const top = names.reduce((a, b) => (cmp(b, a) > 0 ? b : a));
  return names.filter(n => cmp(n, top) === 0).length > 1 ? null : top;   // 2.0 e 2.0.0: empate, nada oferecido
}

/** Bundle ids (minúsculos) dos .app instalados, numa chamada só do mdls. Falha → null (nada do Caches é limpável). */
async function mdlsInstalledIds(): Promise<ReadonlySet<string> | null> {
  const dirs = ['/Applications', '/Applications/Utilities', join(homedir(), 'Applications')];
  const apps = (await Promise.all(dirs.map(async d => (await childDirs(d)).filter(n => n.endsWith('.app')).map(n => join(d, n))))).flat();
  if (!apps.length) return null;
  return new Promise(res => {
    // shell:false e caminho absoluto; com -raw e vários arquivos, a saída vem separada por NUL
    const c = spawn('/usr/bin/mdls', ['-raw', '-name', 'kMDItemCFBundleIdentifier', ...apps], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => c.kill(), 20_000);
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', d => { out += d; });
    c.on('error', () => { clearTimeout(timer); res(null); });
    c.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return res(null);
      res(new Set(out.split('\0').map(x => x.trim().toLowerCase()).filter(x => x && x !== '(null)')));
    });
  });
}

/** Pasta de verdade: não é link, e o caminho montado é o próprio caminho real (nenhum pedaço dele é link). */
async function isRealDir(p: string) {
  try { const st = await lstat(p); return st.isDirectory() && !st.isSymbolicLink() && await realpath(p) === p; } catch { return false; }
}
/** Pastas-filhas (link fica de fora: Dirent de readdir não segue link). */
async function childDirs(p: string) {
  try { return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}

type Target = AppDataItem & { owners: string[]; app: string; entry: string; needsApp: boolean };

export function createAppData(deps: {
  platform?: NodeJS.Platform; bases?: Partial<Record<AppDataBase, string>>;
  runningKeys: () => ReadonlySet<string> | null; now?: () => number; maxEntries?: number; maxMs?: number;
  installedIds?: () => Promise<ReadonlySet<string> | null>;
}) {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const maxEntries = deps.maxEntries ?? 500_000, maxMs = deps.maxMs ?? 60_000;
  // cache de 10 min dos apps instalados (Caches no Mac só é limpável se a pasta casar com um deles)
  let inst: { at: number; p: Promise<ReadonlySet<string> | null> } | null = null;
  function installed() {
    if (!inst || now() - inst.at > 10 * 60_000) {
      inst = { at: now(), p: deps.installedIds ? deps.installedIds() : process.platform === 'darwin' ? mdlsInstalledIds() : Promise.resolve(null) };
    }
    return inst.p;
  }
  /** Acionável? Dono fechado e, no Caches, pasta (ou prefixo de 2+ partes) = bundle id de app instalado. Senão, a nota. */
  function judge(t: Target, keys: ReadonlySet<string> | null, apps: ReadonlySet<string> | null): string | null {
    if (t.needsApp && !t.owners.some(o => apps?.has(o))) return NO_APP;
    if (keys === null) return 'Ainda lendo os apps abertos: tente de novo';
    if (t.owners.some(o => keys.has(o))) return `${t.app} aberto: feche para limpar`;
    return null;
  }
  // ponytail: alocado, como o du; clone do APFS conta nas duas cópias
  const bytesOf = (st: Stats) => (process.platform === 'win32' ? st.size : st.blocks * 512);

  function defaultBases(): Partial<Record<AppDataBase, string>> {
    if (platform === 'darwin') {
      const lib = join(homedir(), 'Library');
      return { appSupport: join(lib, 'Application Support'), caches: join(lib, 'Caches'), containers: join(lib, 'Containers'), groupContainers: join(lib, 'Group Containers') };
    }
    if (platform === 'win32') return { localAppData: process.env.LOCALAPPDATA, roamingAppData: process.env.APPDATA };
    return {};
  }

  async function realBases() {
    const out: Array<[AppDataBase, string]> = [];
    for (const [k, v] of Object.entries(deps.bases ?? defaultBases()) as Array<[AppDataBase, string | undefined]>) {
      if (!v) continue;
      try { out.push([k, await realpath(v)]); } catch { /* não existe: fora */ }
    }
    return out;
  }

  /** Alvos que as regras produzem nesta máquina. Caminho = base real + dir da regra + nomes lidos do disco. */
  async function targets(bases: Map<AppDataBase, string>): Promise<Target[]> {
    const out: Target[] = [];
    const add = async (rule: CacheRule, b: string, rel: string[], owners: string[], app: string, needsApp = false) => {
      const path = join(b, ...(rule.dir === '*' ? [] : rule.dir.split('/')), ...rel);
      if (!await isRealDir(path)) return;
      out.push({
        id: `${rule.id}:${rel.join('/')}`, label: `${app}: ${rel.join('/')}`, path, bytes: 0, files: 0, actionable: false,
        owners, app, needsApp, entry: `${rule.base}:${rule.dir === '*' ? rel[0] : rule.dir.split('/')[0]}`,
      });
    };
    for (const rule of CACHE_RULES) {
      const b = bases.get(rule.base);
      if (rule.os !== platform || !b) continue;
      if (rule.dir === '*') {
        for (const n of await childDirs(b)) {
          // dono = a pasta e cada prefixo de 2+ partes: com.x.app.ShipIt é do com.x.app, notion.id.ShipIt do notion.id
          const parts = n.toLowerCase().split('.');
          const owners = parts.slice(1).map((_, i) => parts.slice(0, i + 2).join('.'));
          if (BUNDLE_ID.test(n) && !/^com\.apple(\.|$)/i.test(n)) await add(rule, b, [n], owners, n, true);
        }
        continue;
      }
      if (rule.owner === 'folder') continue;
      const owners = [...rule.owner];
      const ruleDir = join(b, ...rule.dir.split('/'));
      if (!await isRealDir(ruleDir)) continue;
      const homes = rule.profiles ? (await childDirs(ruleDir)).filter(n => PROFILE.test(n)).map(n => [n]) : [[]];
      for (const h of homes) for (const s of rule.subdirs ?? []) await add(rule, b, [...h, s], owners, rule.label);
      for (const v of rule.versions ?? []) {
        if (!await isRealDir(join(ruleDir, v))) continue;
        const names = await childDirs(join(ruleDir, v));
        const newest = newestVersion(names);
        if (newest) for (const n of names) if (n !== newest) await add(rule, b, [v, n], owners, rule.label);
      }
    }
    return out;
  }

  async function collect(): Promise<{ scan: AppDataScan; all: Target[] }> {
    const t0 = now();
    const bases = new Map(await realBases());
    const all = await targets(bases);
    const budget = newBudget(maxEntries, maxMs, now);
    const entries: AppDataEntry[] = [];
    for (const [base, b] of bases) {
      for (const name of await childDirs(b)) {
        const path = join(b, name);
        const items = all.filter(t => t.entry === `${base}:${name}`);
        const nots = NOT_CACHE.filter(n => n.os === platform && n.base === base && n.path.split('/')[0] === name)
          .map(n => ({ text: n.text, path: join(b, ...n.path.split('/')), bytes: 0 }));
        const e: AppDataEntry = { id: `${base}:${name}`, name, where: WHERE[base], bytes: 0, items: [], notes: [] };
        await walk(path, 64, null, budget, (p, st) => {
          const n = bytesOf(st);
          e.bytes += n;
          for (const t of items) if (p.startsWith(t.path + sep)) { t.bytes += n; t.files++; }
          for (const x of nots) if (p.startsWith(x.path + sep)) x.bytes += n;
        });
        e.items = items.map(({ owners: _o, app: _a, entry: _e, needsApp: _n, ...i }) => i);
        e.notes = nots.filter(x => x.bytes > 0).map(({ text, bytes }) => ({ text, bytes }));
        if (!items.length) e.notes.push({ text: NO_CACHE, bytes: e.bytes });
        entries.push(e);
      }
    }
    entries.sort((a, b) => b.bytes - a.bytes);
    return {
      all,
      scan: {
        t: now(), durationMs: now() - t0, truncated: budget.stopped,
        totalBytes: entries.reduce((a, e) => a + e.bytes, 0), entries: entries.slice(0, 40),
      },
    };
  }

  /** Veredito na hora (aberto/fechado, app instalado) sobre a medição guardada: fechar o app destrava sem medir de novo. */
  async function judged({ scan, all }: { scan: AppDataScan; all: Target[] }): Promise<AppDataScan> {
    const keys = deps.runningKeys();
    const apps = all.some(t => t.needsApp) ? await installed() : null;
    const byId = new Map(all.map(t => [t.id, t]));
    return {
      ...scan,
      entries: scan.entries.map(e => ({
        ...e,
        items: e.items.map(({ note: _old, ...i }) => {
          const note = judge(byId.get(i.id)!, keys, apps);
          return note === null ? { ...i, actionable: true } : { ...i, actionable: false, note };
        }),
      })),
    };
  }

  // single-flight + cache de 5 min das MEDIDAS; `fresh` coleta de novo; clean invalida
  let cached: { p: Promise<{ scan: AppDataScan; all: Target[] }>; at: number | null } | null = null;
  function preview(opts: { fresh?: boolean } = {}): Promise<AppDataScan> {
    if (cached && !opts.fresh && (cached.at === null || now() - cached.at < 5 * 60_000)) return cached.p.then(judged);
    const c: NonNullable<typeof cached> = { p: collect(), at: null };
    c.p.then(() => { c.at = now(); }, () => { if (cached === c) cached = null; });
    cached = c;
    return c.p.then(judged);
  }

  // clean: alvos recalculados das regras (o id que chega só escolhe entre eles); mede SÓ os pedidos, cada um com o
  // próprio orçamento; medição cortada = não apaga (skipped). Dono, app e caminho real reconferidos logo antes do rm.
  async function clean(ids: string[]) {
    cached = null;
    const byId = new Map((await targets(new Map(await realBases()))).map(t => [t.id, t]));
    let bytes = 0, files = 0, skipped = 0;
    for (const id of new Set(ids)) {
      const t = typeof id === 'string' ? byId.get(id) : undefined;
      if (!t || judge(t, deps.runningKeys(), t.needsApp ? await installed() : null) !== null) { skipped++; continue; }
      const b = newBudget(maxEntries, maxMs, now);
      let tb = 0, tf = 0;
      await walk(t.path, 64, null, b, (_p, st) => { tb += bytesOf(st); tf++; });
      if (b.stopped || judge(t, deps.runningKeys(), t.needsApp ? await installed() : null) !== null || !await isRealDir(t.path)) { skipped++; continue; }
      try { await rm(t.path, { recursive: true }); bytes += tb; files += tf; } catch { skipped++; }
    }
    return { bytes, files, skipped };
  }

  return { preview, clean };
}
