// Fonte real: SSE de /api/events e escrita com o token (R16). Mesma forma do mockSource.
import type {
  AgentEvent, AgentProvider, AppDataScan, Conversation, DiskInfo, LogEntry, MemoryState, QuickCleanItem, ReleaseResponse,
  Settings, StaleScan, StartupApp, Suggestion, SuggestionDraft, Warning,
} from '../../src/types';
import { mockRead, type Source } from './mock';

let tokenPromise: Promise<string> | null = null;
const token = () => (tokenPromise ??= fetch('/api/token').then(r => r.json()).then(b => b.token as string));

async function write<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-folga-token': await token() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { erro?: string }).erro ?? 'falhou');
  return data as T;
}
const MOCK = new URLSearchParams(location.search).has('mock');   // ?mock: números falsos de mock.ts, sem tocar no servidor
const read = <T>(path: string): Promise<T> => {
  const fake = MOCK ? mockRead(path) : undefined;
  if (fake !== undefined) return Promise.resolve(fake as T);
  return fetch(path).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as { erro?: string }).erro ?? 'falhou');
    return data as T;
  });
};

// Um único EventSource para a página inteira; cada tela assina o evento que quer.
type EventMap = { state: MemoryState; warnings: Warning[]; suggestions: Suggestion[]; agent: AgentEvent };
let es: EventSource | null = null;
export function onEvent<K extends keyof EventMap>(name: K, cb: (data: EventMap[K]) => void): () => void {
  es ??= new EventSource('/api/events');   // reconecta sozinho se o servidor reiniciar
  const fn = (e: Event) => cb(JSON.parse((e as MessageEvent).data) as EventMap[K]);
  es.addEventListener(name, fn);
  return () => es?.removeEventListener(name, fn);
}

export const apiSource: Source = {
  subscribe: onState => onEvent('state', onState),
  release: keys => write<ReleaseResponse>('POST', '/api/release', { keys }),
};

export const getLog = (limit = 100): Promise<LogEntry[]> => read(`/api/log?limit=${limit}`);
export const getSettings = (): Promise<Settings> => read('/api/settings');
export const putSettings = (patch: Partial<Settings>) => write<Settings>('PUT', '/api/settings', patch);
export const getStartup = (): Promise<{ on: boolean; available: boolean }> => read('/api/startup');
export const putStartup = (on: boolean) => write<{ on: boolean }>('PUT', '/api/startup', { on });

// v2: avisos (F-15)
export const getWarnings = (): Promise<Warning[]> => read('/api/warnings');
export const getDisk = (): Promise<DiskInfo[]> => read('/api/disk');
export const getStartupApps = (): Promise<StartupApp[]> => read('/api/startup-apps');

// v2: arquivos e sugestões (F-17)
export const getStale = (): Promise<StaleScan | null> => read('/api/files/stale');
export const scanStale = (opts: { olderThanDays?: number; minMB?: number } = {}) => write<StaleScan>('POST', '/api/files/scan', opts);
export const getAppData = (): Promise<AppDataScan> => read('/api/appdata');
export const getQuickClean = (): Promise<QuickCleanItem[]> => read('/api/quickclean');
export const getSuggestions = (): Promise<Suggestion[]> => read('/api/suggestions');
export const addSuggestion = (draft: SuggestionDraft) =>
  MOCK ? Promise.reject(new Error('modo ?mock: nada é enviado ao servidor')) : write<Suggestion>('POST', '/api/suggestions', draft);
export const approveSuggestion = (id: string) => write<Suggestion>('POST', `/api/suggestions/${encodeURIComponent(id)}/approve`, {});
export const ignoreSuggestion = (id: string) => write<Suggestion>('POST', `/api/suggestions/${encodeURIComponent(id)}/ignore`, {});

// v2: assistente (F-18)
export const getConversation = (): Promise<Conversation> => read('/api/agent');
export const sendToAgent = (provider: AgentProvider, text: string) => write<{ ok: true }>('POST', '/api/agent/message', { provider, text });
export const resetAgent = () => write<Conversation>('POST', '/api/agent/reset', {});
export const stopAgent = () => write<{ ok: true }>('POST', '/api/agent/stop', {});
