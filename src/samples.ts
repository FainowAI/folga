// Janela dos gráficos de linha do Início: as leituras dos últimos 60 s, como o Gerenciador de Tarefas.
import type { Sample } from './types.ts';

export const SAMPLE_WINDOW_MS = 60_000;

/** Junta a leitura nova e corta pelo tempo (não pela contagem: o intervalo da sonda é ajustável). */
export function pushSample(list: Sample[], s: Sample, windowMs = SAMPLE_WINDOW_MS): Sample[] {
  return [...list, s].filter(x => s.t - x.t <= windowMs);
}

/** Até quanto tempo a última leitura da sonda vale como "apps abertos agora": 3 intervalos, nunca menos de 10 s. */
export function freshWindowMs(sampleSeconds: number): number {
  return Math.max(10_000, 3 * (Number(sampleSeconds) || 0) * 1000);
}
