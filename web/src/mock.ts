// Fonte falsa com a MESMA forma da real (F-03 só troca a importação no App.tsx).
import { DEFAULT_SETTINGS } from '../../src/types';
import type { AppDataScan, AppGroup, DiskInfo, MemoryState, QuickCleanItem, StaleScan, Outcome, ReleaseResponse, ReleaseResult } from '../../src/types';

export type Source = {
  subscribe(onState: (s: MemoryState) => void): () => void;
  release(keys: string[]): Promise<ReleaseResponse>;
};

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const MIN = 60_000;
const TOTAL = 16 * GB;
const startedAt = Date.now() - 5 * 60 * MIN;
const MAC = /Mac/.test(navigator.platform);   // no Mac a sonda manda pressão e swap, e o Auto Care é por pressão

type Seed = Pick<AppGroup, 'key' | 'name' | 'state' | 'reason'> & {
  n: number; mb: number; cpu?: number; focusedMinAgo?: number | null;
};

// Números do guia (Mint): Parados 3,3 GB, Em uso, e ~42 processos protegidos somando ~2,8 GB.
// ponytail: a soma dos apps passa do "em uso" do sistema; é mock, a UI não confere isso.
const SEEDS: Seed[] = [
  { key: 'figma', name: 'Figma', state: 'idle', reason: 'idle', n: 6, mb: 1638, focusedMinAgo: 120 },
  { key: 'slack', name: 'Slack', state: 'idle', reason: 'idle', n: 5, mb: 1126, focusedMinAgo: 40 },
  { key: 'spotify', name: 'Spotify', state: 'idle', reason: 'idle', n: 4, mb: 640, focusedMinAgo: 180 },
  { key: 'chrome', name: 'Chrome', state: 'in_use', reason: 'foreground', n: 14, mb: 5530, cpu: 6 },
  { key: 'code', name: 'Code', state: 'in_use', reason: 'busy', n: 8, mb: 1946, cpu: 18, focusedMinAgo: 8 },
  { key: 'notion', name: 'Notion', state: 'in_use', reason: 'recent', n: 4, mb: 820, focusedMinAgo: 5 },
  { key: 'explorer', name: 'explorer', state: 'protected', reason: 'system', n: 1, mb: 320 },
  { key: 'dwm', name: 'dwm', state: 'protected', reason: 'system', n: 1, mb: 190 },
  { key: 'svchost', name: 'svchost', state: 'protected', reason: 'system', n: 19, mb: 610 },
  { key: 'msedge', name: 'msedge', state: 'protected', reason: 'no_window', n: 9, mb: 820 },
  { key: 'searchhost', name: 'SearchHost', state: 'protected', reason: 'system', n: 1, mb: 210 },
  { key: 'shellexperiencehost', name: 'ShellExperienceHost', state: 'protected', reason: 'system', n: 1, mb: 120 },
  { key: 'onedrive', name: 'OneDrive', state: 'protected', reason: 'no_window', n: 2, mb: 260 },
  { key: 'folga', name: 'Folga', state: 'protected', reason: 'self', n: 2, mb: 90 },
  { key: 'windowsterminal', name: 'WindowsTerminal', state: 'protected', reason: 'never_close', n: 1, mb: 110 },
  { key: 'ctfmon', name: 'ctfmon', state: 'protected', reason: 'system', n: 1, mb: 20 },
  { key: 'runtimebroker', name: 'RuntimeBroker', state: 'protected', reason: 'system', n: 4, mb: 150 },
];

// Como cada app reage ao WM_CLOSE neste mock.
const OUTCOME: Record<string, Outcome> = {
  figma: 'fechou', slack: 'bandeja', spotify: 'ficou_aberto', chrome: 'fechou', code: 'ficou_aberto',
};

let pid = 1000;
let apps: AppGroup[] = SEEDS.map((s) => ({
  key: s.key, name: s.name, state: s.state, reason: s.reason,
  pids: Array.from({ length: s.n }, () => pid++),
  privateWorkingSet: s.mb * MB,
  cpuPercent: s.cpu ?? 0,
  lastFocusedAt: s.focusedMinAgo == null ? null : Date.now() - s.focusedMinAgo * MIN,
}));
let freed: ReleaseResult[] = [];
let target = 11.8 * GB;   // memória "em uso" para onde a leitura volta
let used = target;

const listeners = new Set<(s: MemoryState) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

const jitter = (v: number, amp: number) => v + (Math.random() - 0.5) * amp;

function snapshot(): MemoryState {
  const t = Date.now();
  return {
    t, memLoad: Math.round((used / TOTAL) * 100), totalPhys: TOTAL, availPhys: TOTAL - used,
    apps: apps.map((a) => (a.reason === 'foreground' ? { ...a, lastFocusedAt: t } : a)),
    freed, settings: { ...DEFAULT_SETTINGS, autoCareEnabled: true, ...(MAC && { autoCareTrigger: 'pressure' as const }) },
    startedAt, autoCare: { nextEligibleAt: null, lastRunAt: null },
    ...(MAC && { memPressure: 'warn' as const, swapUsed: 4.5 * GB }),
  };
}

function tick() {
  used += (target - used) * 0.1 + (Math.random() - 0.5) * 40 * MB;
  apps = apps.map((a) => ({
    ...a,
    privateWorkingSet: Math.max(MB, jitter(a.privateWorkingSet, 6 * MB)),
    cpuPercent: a.reason === 'busy' ? Math.max(6, jitter(18, 6)) : a.reason === 'foreground' ? Math.max(0, jitter(6, 4)) : 0,
  }));
  const s = snapshot();
  listeners.forEach((l) => l(s));
}

export const mockSource: Source = {
  subscribe(onState) {
    listeners.add(onState);
    onState(snapshot());
    timer ??= setInterval(tick, 2000);
    return () => {
      listeners.delete(onState);
      if (!listeners.size) { clearInterval(timer); timer = undefined; }
    };
  },

  async release(keys) {
    const availBefore = TOTAL - used;
    await new Promise((r) => setTimeout(r, 2000));
    const results: ReleaseResult[] = [];
    let closed = 0;
    for (const key of keys) {
      const a = apps.find((x) => x.key === key);
      // ponytail: o servidor real recusa o pedido inteiro (R09); aqui recusa só o app protegido.
      if (!a || a.state === 'protected') { results.push({ key, name: a?.name ?? key, outcome: 'recusado' }); continue; }
      const outcome = OUTCOME[key] ?? 'fechou';
      results.push({ key, name: a.name, outcome });
      if (outcome === 'fechou') {
        closed += a.privateWorkingSet;
        freed = [...freed, { key, name: a.name, outcome }];
        apps = apps.filter((x) => x.key !== key);
      } else if (outcome === 'bandeja') {
        apps = apps.map((x) => (x.key === key ? { ...x, state: 'protected', reason: 'no_window' } : x));
      }
    }
    const back = closed * 0.9;   // R08: o que volta de verdade nunca é a soma dos apps
    target -= back;
    used -= back;
    const s = snapshot();
    listeners.forEach((l) => l(s));
    return { availBefore, availAfter: TOTAL - used, results };
  },
};

// Respostas falsas das leituras da tela Arquivos e do Início (só ?mock). undefined = vai para o servidor.
// ponytail: só Mac (números do guia); no Windows cai no servidor como antes.
export function mockRead(path: string): unknown {
  if (!MAC) return undefined;
  const t = Date.now();
  if (path === '/api/disk') return [{ drive: 'Macintosh HD', total: 494 * GB, free: 38 * GB, purgeable: 21 * GB }] satisfies DiskInfo[];
  if (path === '/api/appdata') {
    const lib = '/Users/voce/Library';
    return {
      t, durationMs: 3400, truncated: false, totalBytes: 16.1 * GB,
      entries: [
        {
          id: 'claude', name: 'Claude', where: `${lib}/Application Support/Claude`, bytes: 13 * GB,
          items: [
            { id: 'claude:code-cache', label: 'Cache de código', path: `${lib}/Application Support/Claude/Code Cache`, bytes: 0.4 * GB, files: 310, actionable: false, note: 'Claude aberto: feche para limpar' },
            { id: 'claude:gpu-cache', label: 'Cache de vídeo', path: `${lib}/Application Support/Claude/GPUCache`, bytes: 120 * MB, files: 12, actionable: false, note: 'Claude aberto: feche para limpar' },
          ],
          notes: [{ text: 'Disco da máquina virtual do Claude: não é cache, o Folga não limpa', bytes: 12.4 * GB }],
        },
        {
          id: 'chrome', name: 'Google Chrome', where: `${lib}/Application Support/Google/Chrome`, bytes: 1.7 * GB,
          items: [
            { id: 'chrome:gpu', label: 'Cache de vídeo', path: `${lib}/Application Support/Google/Chrome/GPUCache`, bytes: 1.4 * GB, files: 38, actionable: true },
            { id: 'chrome:shader', label: 'Cache de sombreadores', path: `${lib}/Application Support/Google/Chrome/ShaderCache`, bytes: 0.3 * GB, files: 21, actionable: false, note: 'Chrome aberto: feche para limpar' },
          ],
          notes: [],
        },
      ],
    } satisfies AppDataScan;
  }
  if (path === '/api/quickclean') {
    return [
      { category: 'temp_usuario', label: 'Temporários', bytes: 640 * MB, files: 1_820, actionable: true },
      // como o servidor: Chrome medido e acionável; o Safari sem permissão só aparece na nota (nunca unknown no item)
      { category: 'cache_navegador', label: 'Cache dos navegadores', bytes: 820 * MB, files: 2_400, actionable: true, note: 'Safari: Não deu para ler: o macOS protege esta pasta e o Folga não pede essa permissão.' },
      { category: 'lixeira', label: 'Lixeira', bytes: 1.2 * GB, files: 96, actionable: false, note: 'o Folga não esvazia' },
    ] as QuickCleanItem[];
  }
  if (path === '/api/files/stale') {
    const d = 86_400_000;
    return {
      t, durationMs: 1800, roots: [], scanned: 4200, truncated: false, totalBytes: 2.3 * GB, olderThanDays: 180, minBytes: 10 * MB, accessTracking: true,
      files: [
        { path: '/Users/voce/Downloads/Instalador antigo.app', name: 'Instalador antigo.app', root: 'Downloads', size: 1.4 * GB, lastUsed: t - 400 * d, lastModified: t - 400 * d, basis: 'adicionado', isApp: true },
        { path: '/Users/voce/Documents/Aula gravada.mov', name: 'Aula gravada.mov', root: 'Documents', size: 0.9 * GB, lastUsed: t - 250 * d, lastModified: t - 260 * d, basis: 'spotlight' },
      ],
    } satisfies StaleScan;
  }
  return undefined;
}
