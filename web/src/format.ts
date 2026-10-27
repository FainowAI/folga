// Formatos compartilhados pelas telas (pt-BR, espaço não separável entre número e unidade).
import type { MemPressure, Outcome, Settings } from '../../src/types';

export const MB = 1024 ** 2;
export const GB = 1024 ** 3;
export const NB = '\u00a0';
export const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nfAuto = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

export const gb = (b: number) => nfAuto.format(b / GB);                       // "11,8", "16"
export const size = (b: number) =>
  b >= GB ? `${nf1.format(b / GB)}${NB}GB` : `${nf0.format(Math.max(0, b) / MB)}${NB}MB`;
export const pct = (n: number) => `${Math.round(n)}${NB}%`;
export const plural = (n: number, one: string, many: string) => `${nf0.format(n)} ${n === 1 ? one : many}`;

export const pressureName: Record<MemPressure, string> = { normal: 'verde', warn: 'amarela', critical: 'vermelha' };
/** quando o Auto Care começa: "em 92 %" ou, no Mac, "na pressão amarela" */
export const autoCareAt = (s: Settings) =>
  s.autoCareTrigger === 'pressure' ? `na pressão ${pressureName[s.autoCarePressure]}` : `em ${pct(s.autoCareThreshold)}`;

/** "menos de 1 min", "40 min", "2 h", "3 d" */
export function ago(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return `menos de 1${NB}min`;
  if (m < 60) return `${m}${NB}min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}${NB}h` : `${Math.floor(h / 24)}${NB}d`;
}

export const OUTCOME: Record<Outcome, { text: string; tone: string }> = {
  fechou: { text: 'fechou', tone: 'ok' },
  ficou_aberto: { text: 'ficou aberto (talvez pedindo para salvar)', tone: 'warn' },
  bandeja: { text: 'foi para a bandeja', tone: 'quiet' },
  encerrado: { text: 'encerrado', tone: 'ok' },
  recusado: { text: 'recusado', tone: 'bad' },
};
