// F-02: agrupa processos em apps e decide parado / em uso / protegido (R02-R06).
// Função pura: o tempo vem em ctx.now, nada de node:* nem estado global.
import type { AppGroup, AppReason, AppState, ProbeProcess, ProbeSnapshot, Settings } from './types.ts';
import { SYSTEM_PROCESSES } from './types.ts';

export type ClassifyHistory = {
  lastFocusedAt: Record<string, number>;                        // por chave de app
  cpu: Record<number, { t: number; cpuTimeMs: number }>;        // última leitura por pid
  cpuSamples: Record<string, { t: number; percent: number }[]>; // por chave, últimos 30 s
  busy?: Record<string, true>;                                  // acima da linha de CPU na leitura anterior (R04)
};
export const emptyHistory = (): ClassifyHistory => ({ lastFocusedAt: {}, cpu: {}, cpuSamples: {}, busy: {} });
export type ClassifyContext = { selfPids: readonly number[]; userSession: number; startedAt: number; now: number };

const CPU_WINDOW_MS = 30_000;
const BUSY_RELEASE = 0.6;   // R04: ocupado só volta a parado abaixo de 60 % da linha (3 % no padrão de 5 %)
// R29: navegador Chromium fechado janela por janela reabre só a última (visto em scripts/qa-chrome.ts).
// ponytail: Edge, Brave e os outros são o mesmo motor (inferido, só o Chrome foi testado); Firefox sem teste.
// No Mac a chave é o bundle id: mesma lista do `chromium` de probe/probe-mac.swift.
const CHROMIUM = new Set(['chrome', 'msedge', 'brave', 'vivaldi', 'opera', 'chromium',
  'com.google.chrome', 'com.microsoft.edgemac', 'com.brave.browser', 'com.vivaldi.vivaldi', 'com.operasoftware.opera', 'org.chromium.chromium']);
const SELF_KEY = '__self';

export function appKey(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, '');
}

const ORDER: Record<AppState, number> = { idle: 0, in_use: 1, protected: 2 };

const MAX_HOPS = 8;   // R36: corrente de ppid curta; mais que isso é lixo ou laço
// R36: quem lança app do usuário mas não é dono de nada. Sem isto o Codex do Antônio vira "serviço do
// Shell Infrastructure Host" (visto ao vivo em 2026-10-19). Fora da SYSTEM_PROCESSES de propósito: aqui só
// corta a subida, não muda o que é protegido (R05). Os de sessão 0 (services, svchost) já caem na sessão.
const NOT_A_PARENT = new Set(['sihost', 'taskhostw', 'runtimebroker', 'dllhost', 'userinit', 'wininit']);
/**
 * R36: de quem é este processo sem janela. Sobe pelo `ppid` pulando o mesmo app, para no primeiro
 * ancestral que é um app do usuário **com janela visível**, e, se não achar nenhum, fica com o primeiro
 * ancestral de outro app (o ChatGPT minimizado na bandeja que lançou um node, por exemplo). Sistema, outra
 * sessão e o próprio Folga cortam a subida: sem isso tudo que mora na bandeja viraria "serviço do explorer".
 * ponytail: o ppid do Windows pode apontar para um pid reaproveitado — visto ao vivo em 2026-10-19,
 * `node <- cmd <- claude <- powershell <- WindowsTerminal`, onde o pai do claude já era outro processo.
 * Parar na primeira janela visível descarta esse lixo; sem a hora de início não dá para conferir o pid.
 */
function parentOf(
  pid: number, key: string,
  byPid: Map<number, ProbeProcess>, keyOf: (p: ProbeProcess) => string,
  windowed: ReadonlySet<string>, userSession: number,
): string | null {
  let cur = byPid.get(pid);
  let fallback: string | null = null;
  const seen = new Set<number>([pid]);
  for (let i = 0; i < MAX_HOPS && cur; i++) {
    const up = byPid.get(cur.ppid);
    if (!up || seen.has(up.pid) || up.session !== userSession) break;
    seen.add(up.pid);
    const upKey = keyOf(up);
    if (upKey !== key) {
      if (upKey === SELF_KEY || NOT_A_PARENT.has(upKey) || SYSTEM_PROCESSES.includes(upKey)) break;
      if (windowed.has(upKey)) return upKey;
      fallback ??= upKey;
    }
    cur = up;
  }
  return fallback;
}

export function classify(
  snap: ProbeSnapshot, history: ClassifyHistory, settings: Settings, ctx: ClassifyContext,
): { apps: AppGroup[]; history: ClassifyHistory } {
  // clone: o history recebido não é alterado
  const lastFocusedAt = { ...history.lastFocusedAt };
  const cpu: ClassifyHistory['cpu'] = {};
  const cpuSamples: ClassifyHistory['cpuSamples'] = {};
  const busy: Record<string, true> = {};

  // 1-2. agrupa (self antes, para a janela do Folga não se misturar ao msedge do usuário)
  const keyOf = (p: ProbeProcess) => (ctx.selfPids.includes(p.pid) ? SELF_KEY : appKey(p.name));
  const groups = new Map<string, ProbeProcess[]>();
  const byPid = new Map<number, ProbeProcess>();        // R36: para subir pelo ppid
  const windowed = new Set<string>();                   // apps do usuário com janela visível em algum processo
  for (const p of snap.processes) {
    const key = keyOf(p);
    const list = groups.get(key);
    if (list) list.push(p); else groups.set(key, [p]);
    byPid.set(p.pid, p);
    if (p.session === ctx.userSession && p.hasVisibleWindow) windowed.add(key);
  }

  const neverClose = new Set(settings.neverClose.map(appKey));
  const audioPids = new Set(snap.audioPids ?? []);
  const apps: AppGroup[] = [];

  for (const [key, procs] of groups) {
    // 3. CPU: delta de tempo de CPU ÷ delta de relógio, em % de um núcleo
    let sample = 0;
    for (const p of procs) {
      const prev = history.cpu[p.pid];
      if (prev && snap.t > prev.t && p.cpuTimeMs >= prev.cpuTimeMs) {
        sample += ((p.cpuTimeMs - prev.cpuTimeMs) / (snap.t - prev.t)) * 100;
      } // ponytail: pid novo, relógio parado ou contador menor (pid reaproveitado) contribui 0
      cpu[p.pid] = { t: snap.t, cpuTimeMs: p.cpuTimeMs };
    }
    const samples = [...(history.cpuSamples[key] ?? []), { t: snap.t, percent: sample }]
      .filter((s) => snap.t - s.t <= CPU_WINDOW_MS);
    cpuSamples[key] = samples;
    const cpuPercent = Math.round((samples.reduce((a, s) => a + s.percent, 0) / samples.length) * 10) / 10;
    // histerese: sem ela, um app rondando a linha troca de grupo a cada leitura
    const busyNow = cpuPercent >= settings.busyCpuPercent * (history.busy?.[key] ? BUSY_RELEASE : 1);
    if (busyNow) busy[key] = true;

    // 4. foco
    const inForeground = snap.foregroundPid !== null && procs.some((p) => p.pid === snap.foregroundPid);
    if (inForeground) lastFocusedAt[key] = ctx.now;
    const focused = lastFocusedAt[key] ?? null;

    // 5. estado, primeira regra que casar: self, other_session, system, no_window, never_close,
    //    foreground, audio (tocando som com a janela no fundo), busy, recent, idle
    const mine = procs.filter((p) => p.session === ctx.userSession);
    const windows = mine.reduce((n, p) => n + (p.windowCount ?? (p.hasVisibleWindow ? 1 : 0)), 0);
    let state: AppState;
    let reason: AppReason;
    if (key === SELF_KEY) { state = 'protected'; reason = 'self'; }
    else if (mine.length === 0) { state = 'protected'; reason = 'other_session'; }
    else if (SYSTEM_PROCESSES.includes(key) || !mine.some((p) => p.accessible)) { state = 'protected'; reason = 'system'; }
    else if (!mine.some((p) => p.hasVisibleWindow)) { state = 'protected'; reason = 'no_window'; }
    else if (neverClose.has(key)) { state = 'protected'; reason = 'never_close'; }
    else if (inForeground) { state = 'in_use'; reason = 'foreground'; }
    else if (procs.some((p) => audioPids.has(p.pid))) { state = 'in_use'; reason = 'audio'; }
    else if (busyNow) { state = 'in_use'; reason = 'busy'; }
    else if (ctx.now - (focused ?? ctx.startedAt) < settings.idleMinutes * 60_000) { state = 'in_use'; reason = 'recent'; }
    else if (CHROMIUM.has(key) && windows > 1) { state = 'in_use'; reason = 'multi_window'; }
    else { state = 'idle'; reason = 'idle'; }

    // apps empacotados (Paint, Bloco de Notas) trazem o próprio "x.exe" como descrição: não serve de nome
    const description = procs.map((p) => p.description.trim()).find((d) => d !== '' && !/\.exe$/i.test(d));
    // R36: quem lançou os processos sem janela e quanto é de cada um, maiores primeiro. Só aqui: os outros
    // motivos ou são o topo da árvore (never_close) ou não têm próximo passo (system, self, other_session).
    // Sem corte na lista: é desta conta que sai o "+ X GB em serviços" da linha do dono, e cortar perderia
    // bytes. Quem mostra é que corta (três nomes nas palavras).
    let parents: AppGroup['parents'];
    if (reason === 'no_window') {
      const bytes = new Map<string, number>();
      for (const p of mine) {
        const par = parentOf(p.pid, key, byPid, keyOf, windowed, ctx.userSession);
        if (par) bytes.set(par, (bytes.get(par) ?? 0) + p.privateWorkingSet);
      }
      if (bytes.size > 0) parents = [...bytes].sort((a, b) => b[1] - a[1]).map(([key, bytes]) => ({ key, bytes }));
    }

    const first = procs[0]!; // grupo nunca é vazio
    const fileName = first.name.replace(/\.exe$/i, '');
    apps.push({
      key,
      name: key === SELF_KEY ? 'Folga' : description ?? fileName.charAt(0).toUpperCase() + fileName.slice(1),
      pids: procs.map((p) => p.pid),
      privateWorkingSet: procs.reduce((a, p) => a + p.privateWorkingSet, 0),
      cpuPercent, state, reason, lastFocusedAt: focused, windows, parents,
    });
  }

  // 6. idle, in_use, protected; maior primeiro dentro de cada um
  apps.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.privateWorkingSet - a.privateWorkingSet);
  return { apps, history: { lastFocusedAt, cpu, cpuSamples, busy } };
}
