// F-20: o vigia (R30). Olha memória e disco sozinho e PROPÕE um cartão; nada acontece sem o clique do
// usuário (R20), e a aprovação revalida tudo (R21). Sem modelo de linguagem: os números já estão aqui.
import { pressureAtLeast } from './autocare.ts';
import { EXPIRED, size } from './suggestions.ts';
import type { DiskInfo, MemoryState, QuickCleanItem, Settings, Suggestion, SuggestionDraft, SuggestionKind } from './types.ts';

export type WatchDeps = {
  getState: () => MemoryState | null;
  getSettings: () => Settings;
  disks: () => Promise<DiskInfo[]>;
  quickClean: () => Promise<QuickCleanItem[]>;
  listSuggestions: () => Suggestion[];
  propose: (draft: SuggestionDraft) => Promise<unknown>;
  notify?: (title: string, body: string) => void;   // R31: aviso do Windows, só na proposta nova
  now?: () => number;
  checkMs?: number;   // testes encurtam o ciclo
};

const CHECK_MS = 60_000;
const MEM_STREAK = 2;              // duas leituras seguidas, como o Auto Care (R10)
const MEM_LINE_OFF = 85;           // com o Auto Care desligado
const MEM_BEFORE_AUTOCARE = 7;     // ligado: propõe 7 pontos antes dele agir
const MEM_FLOOR = 70;              // nunca propor abaixo disso
const MEM_MIN_BYTES = 500 * 1024 ** 2;
const MEM_MAX_APPS = 5;
const DISK_LOW_PCT = 15;
const DISK_EVERY_MS = 30 * 60_000;   // medir a limpeza varre temporários e caches: devagar
const DISK_MIN_BYTES = 1024 ** 3;
const COOLDOWN_MS = 60 * 60_000;      // depois de propor ou de uma decisão
const SAID_NO_MS = 6 * 60 * 60_000;   // depois de um "ignorar" do usuário

/** A partir de quantos % de memória vale propor. */
export function memoryLine(s: Settings): number {
  return s.autoCareEnabled ? Math.max(MEM_FLOOR, s.autoCareThreshold - MEM_BEFORE_AUTOCARE) : MEM_LINE_OFF;
}

/** Os apps parados que valem a pena fechar agora, maiores primeiro. Null = não vale propor. */
export function memoryPlan(state: MemoryState, settings: Settings): { keys: string[]; names: string[]; bytes: number } | null {
  // Mac: propõe já na pressão amarela (R30), antes ou junto do Auto Care; Windows: pela porcentagem
  const above = settings.autoCareTrigger === 'pressure' ? pressureAtLeast(state.memPressure, 'warn') : state.memLoad >= memoryLine(settings);
  if (!above) return null;
  const idle = state.apps.filter(a => a.state === 'idle')
    .sort((a, b) => b.privateWorkingSet - a.privateWorkingSet).slice(0, MEM_MAX_APPS);
  const bytes = idle.reduce((a, b) => a + b.privateWorkingSet, 0);
  if (bytes < MEM_MIN_BYTES) return null;
  return { keys: idle.map(a => a.key), names: idle.map(a => a.name), bytes };
}

export function memoryDraft(plan: { names: string[]; keys: string[]; bytes: number }, memLoad: number): SuggestionDraft {
  const n = plan.names.length;
  const lista = n === 1 ? plan.names[0]! : `${plan.names.slice(0, -1).join(', ')} e ${plan.names[n - 1]}`;
  return {
    kind: 'liberar_memoria',
    title: `Memória em ${Math.round(memLoad)} %: dá para liberar ${size(plan.bytes)}`,
    reason: `${lista} ${n === 1 ? 'está parado' : 'estão parados'} e ${n === 1 ? 'ocupa' : 'ocupam'} ${size(plan.bytes)}. `
      + 'O Folga fecha do jeito normal: se algum tiver algo não salvo, ele pergunta antes.',
    items: plan.keys,
  };
}

/** O disco do sistema, ou o primeiro que veio. */
export function systemDisk(disks: readonly DiskInfo[]): DiskInfo | null {
  if (process.platform !== 'win32') return disks[0] ?? null;
  const sys = (process.env.SystemDrive ?? 'C:').toUpperCase();
  return disks.find(d => d.drive.toUpperCase() === sys) ?? disks[0] ?? null;
}

export function diskFreePct(d: DiskInfo): number {
  return d.total > 0 ? (d.free / d.total) * 100 : 100;
}

export function cleanDraft(items: readonly QuickCleanItem[], disk: DiskInfo): SuggestionDraft | null {
  const bytes = items.filter(i => i.actionable).reduce((a, i) => a + i.bytes, 0);
  if (bytes < DISK_MIN_BYTES) return null;
  return {
    kind: 'limpeza_rapida',
    title: `Disco ${disk.drive} com ${Math.round(diskFreePct(disk))} % livre: dá para apagar ${size(bytes)}`,
    reason: 'Temporários com mais de 7 dias e cache de navegador fechado. Cookies e histórico ficam, '
      + 'para você não sair dos sites. Isso se refaz sozinho com o uso.',
    items: [],
  };
}

export function createWatch(deps: WatchDeps) {
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let memStreak = 0;
  let diskAt = 0;
  const proposedAt: Partial<Record<SuggestionKind, number>> = {};

  /** Pode propor este tipo agora? Pendente barra; "ignorar" do usuário espera mais; expirar não é "não". */
  function free(kind: SuggestionKind): boolean {
    const t = now();
    const mine = deps.listSuggestions().filter(s => s.kind === kind);
    if (mine.some(s => s.status === 'pendente')) return false;
    const last = mine[0];   // list() devolve a mais nova primeiro
    if (last?.doneAt !== undefined) {
      const saidNo = last.status === 'ignorada' && last.result !== EXPIRED;
      if (t - last.doneAt < (saidNo ? SAID_NO_MS : COOLDOWN_MS)) return false;
    }
    const mem = proposedAt[kind];
    return mem === undefined || t - mem >= COOLDOWN_MS;
  }

  async function propose(draft: SuggestionDraft) {
    proposedAt[draft.kind] = now();   // marca antes: uma recusa não vira repetição a cada minuto
    const r = await deps.propose(draft);
    // só avisa se o cartão existe mesmo: proposta recusada pelo servidor não vira notificação
    if (r && typeof r === 'object' && 'id' in r) deps.notify?.('Folga', `${draft.title} — toque para decidir.`);
  }

  async function memory(): Promise<void> {
    const state = deps.getState();
    const plan = state && memoryPlan(state, deps.getSettings());
    if (!plan) { memStreak = 0; return; }
    memStreak++;
    if (memStreak < MEM_STREAK || !free('liberar_memoria')) return;
    memStreak = 0;
    await propose(memoryDraft(plan, state!.memLoad));
  }

  async function disk(): Promise<void> {
    if (now() - diskAt < DISK_EVERY_MS || !free('limpeza_rapida')) return;
    diskAt = now();
    const d = systemDisk(await deps.disks());
    // a prévia é cara (varre temporários e caches): só com o disco apertado
    if (!d || diskFreePct(d) >= DISK_LOW_PCT) return;
    const draft = cleanDraft(await deps.quickClean(), d);
    if (draft) await propose(draft);
  }

  async function tick(): Promise<void> {
    if (!deps.getSettings().watchEnabled) { memStreak = 0; return; }
    for (const step of [memory, disk]) {
      try { await step(); } catch { /* uma falha de leitura não derruba o vigia */ }
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => void tick(), deps.checkMs ?? CHECK_MS);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Um ciclo direto (testes e verificação ao vivo). */
    tick,
  };
}
export type Watch = ReturnType<typeof createWatch>;
