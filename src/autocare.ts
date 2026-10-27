// Auto Care de memória (R10–R13): decisão pura; quem dispara é o server.ts.
import type { MemoryState, MemPressure, Settings } from './types.ts';

export type AutoCareMemory = { above: number; nextEligibleAt: number | null; lastRunAt: number | null; running: boolean };
export const emptyAutoCare = (): AutoCareMemory => ({ above: 0, nextEligibleAt: null, lastRunAt: null, running: false });

const RANK: Record<MemPressure, number> = { normal: 0, warn: 1, critical: 2 };
export const pressureAtLeast = (p: MemPressure | undefined, min: MemPressure): boolean => p !== undefined && RANK[p] >= RANK[min];

const aboveLine = (state: Pick<MemoryState, 'memLoad' | 'memPressure'>, s: Settings) =>
  s.autoCareTrigger === 'pressure' ? pressureAtLeast(state.memPressure, s.autoCarePressure) : state.memLoad >= s.autoCareThreshold;

/** Uma leitura nova. `keys` vem preenchido só quando é para liberar agora. Não mexe em `running`. */
export function decide(
  mem: AutoCareMemory, state: Pick<MemoryState, 'memLoad' | 'apps' | 'memPressure'>, settings: Settings, now: number,
): { mem: AutoCareMemory; keys: string[] | null } {
  // R10: o contador conta leituras seguidas; abaixo do limite (ou desligado) zera
  if (!settings.autoCareEnabled || !aboveLine(state, settings)) return { mem: { ...mem, above: 0 }, keys: null };
  const next = { ...mem, above: mem.above + 1 };
  if (next.above < 2 || mem.running) return { mem: next, keys: null };
  if (mem.nextEligibleAt !== null && now < mem.nextEligibleAt) return { mem: next, keys: null };   // R12
  const keys = state.apps.filter(a => a.state === 'idle').map(a => a.key);                          // R11
  if (keys.length === 0) return { mem: next, keys: null };   // nada parado: não chama release, não conta execução
  return { mem: { ...next, above: 0 }, keys };
}

/** Fim de uma execução. `ran` = release chegou a rodar (só isso conta para o freio, R12). */
export function finishRun(mem: AutoCareMemory, ran: boolean, cooldownMinutes: number, now: number): AutoCareMemory {
  return ran
    ? { ...mem, running: false, lastRunAt: now, nextEligibleAt: now + cooldownMinutes * 60_000 }
    : { ...mem, running: false };
}
