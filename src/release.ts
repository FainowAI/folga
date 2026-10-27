// Liberar memória: WM_CLOSE (no Mac, Cmd+Q), conferir, medir e registrar (R07–R09, R14, ADR 0003).
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Probe } from './probe.ts';
import type { AppGroup, LogEntry, MemoryState, ReleaseResponse, ReleaseResult, Settings } from './types.ts';

export type ReleaseDeps = {
  dataDir: string;
  probe: Pick<Probe, 'send'>;
  getState: () => MemoryState | null;
  getSettings: () => Settings;
  waitForSnapshot: () => Promise<MemoryState>;
  closeWaitMs?: number;     // R07: conferir depois de 8 s
  measureWaitMs?: number;   // R08: medir 5 s depois do último fechamento
  platform?: NodeJS.Platform;   // padrão process.platform
};
export type ReleaseError = { erro: string; status: number };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function createReleaser(deps: ReleaseDeps) {
  const logFile = join(deps.dataDir, 'log.jsonl');
  const mac = (deps.platform ?? process.platform) === 'darwin';
  const freed: ReleaseResult[] = [];
  let busy = false;

  const nextState = async (): Promise<MemoryState> => {
    const fallback = sleep(15_000).then(() => deps.getState());
    const s = await Promise.race([deps.waitForSnapshot(), fallback]);
    if (!s) throw new Error('sem leitura');
    return s;
  };

  // onlyIdle: quem confirmou olhando uma lista antiga (alerta do menu da barra) só fecha o que segue parado
  async function release(keys: string[], origin: LogEntry['origin'], onlyIdle = false): Promise<ReleaseResponse | ReleaseError> {
    if (busy) return { erro: 'já existe uma liberação em andamento', status: 409 };
    const state = deps.getState();
    if (!state) return { erro: 'ainda lendo a memória', status: 503 };

    // R09: só candidatos; um protegido no pedido recusa o pedido inteiro. App que já sumiu é ignorado.
    const groups: AppGroup[] = [];
    for (const key of new Set(keys)) {
      const g = state.apps.find(a => a.key === key);
      if (!g) continue;
      if (g.state === 'protected') return { erro: `${g.name} é protegido e não pode ser fechado`, status: 409 };
      if (onlyIdle && g.state !== 'idle') return { erro: `${g.name} voltou a ser usado; nada foi fechado`, status: 409 };
      groups.push(g);
    }
    if (groups.length === 0) return { erro: 'nenhum dos apps está aberto', status: 409 };

    busy = true;
    try {
      const availBefore = state.availPhys;
      for (const g of groups) {
        try { await deps.probe.send({ type: 'close', pids: g.pids, key: g.key }); } catch { /* conferido abaixo */ }
      }
      await sleep(deps.closeWaitMs ?? 8_000);

      const after = await nextState();
      const alive = new Set(after.apps.flatMap(a => a.pids));
      const settings = deps.getSettings();
      const results: ReleaseResult[] = [];
      for (const g of groups) {
        const living = g.pids.filter(p => alive.has(p));
        let outcome: ReleaseResult['outcome'];
        if (living.length === 0) outcome = 'fechou';
        else {
          const now = after.apps.find(a => a.key === g.key);
          const hasWindow = now ? now.reason !== 'no_window' : false;
          // Mac: Cmd+Q que não saiu (pergunta de salvar, recusa) fica aberto, com ou sem janela; não existe "bandeja"
          outcome = hasWindow || mac ? 'ficou_aberto' : 'bandeja';
          // ADR 0003: encerrar à força só app sem janela que o usuário liberou (P03)
          // só os pids que seguem neste mesmo grupo: pid reaproveitado por outro app na espera nunca é forçado
          const target = now ? living.filter(p => now.pids.includes(p)) : [];
          if (!hasWindow && target.length && settings.mayForceQuit.includes(g.key)) {
            try {
              // probe.cs responde ok:false quando algum pid já tinha saído: confere na leitura seguinte
              const reply = await deps.probe.send({ type: 'kill', pids: target });
              if (reply.ok) outcome = 'encerrado';
              else {
                const still = new Set((await nextState()).apps.flatMap(a => a.pids));
                if (!target.some(p => still.has(p))) outcome = 'encerrado';
              }
            } catch { /* fica o desfecho anterior */ }
          }
        }
        results.push({ key: g.key, name: g.name, outcome });
      }

      await sleep(deps.measureWaitMs ?? 5_000);
      const measured = await nextState();
      const entry: LogEntry = { t: Date.now(), origin, availBefore, availAfter: measured.availPhys, results };
      await appendFile(logFile, JSON.stringify(entry) + '\n');

      for (const r of results) if (r.outcome === 'fechou' || r.outcome === 'encerrado') freed.unshift(r);
      freed.splice(50);
      return { availBefore, availAfter: measured.availPhys, results };
    } finally {
      busy = false;
    }
  }

  // ponytail: lê o arquivo inteiro; rotacionar quando passar de ~10 mil linhas (ADR 0005)
  async function readLog(limit: number): Promise<LogEntry[]> {
    let text = '';
    try { text = await readFile(logFile, 'utf8'); } catch { return []; }
    const out: LogEntry[] = [];
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* linha corrompida: ignora */ }
    }
    return out;
  }

  return { release, readLog, freed: () => [...freed], isBusy: () => busy };
}
