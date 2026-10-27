// Liga o Node à sonda nativa: uma linha JSON por mensagem em stdin/stdout (ADR 0002).
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProbeCommand, ProbeReply, ProbeSnapshot } from './types.ts';

type CommandBody = { type: ProbeCommand['type']; pids: number[]; key?: string };

export type Probe = {
  send(cmd: CommandBody, timeoutMs?: number): Promise<ProbeReply>;
  pid(): number | null;
  stop(): void;
};

export function startProbe(
  command: string,
  args: string[],
  onSnapshot: (snap: ProbeSnapshot) => void,
  onStatus: (alive: boolean) => void = () => {},
): Probe {
  let child: ChildProcess | null = null;
  let stopped = false;
  let retryMs = 500;
  let seq = 0;
  const pending = new Map<string, { resolve: (r: ProbeReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  const failPending = (why: string) => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(why)); pending.delete(id); }
  };

  const launch = () => {
    // shell:false e caminho absoluto: armadilha de spawn no Windows (CLAUDE.md)
    const c = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: false, windowsHide: true });
    child = c;
    c.on('error', () => { /* o 'exit' cuida do reinício */ });
    createInterface({ input: c.stdout! }).on('line', line => {
      let msg: ProbeSnapshot | ProbeReply;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'snapshot') { retryMs = 500; onSnapshot(msg); return; }
      if (msg.type === 'reply') {
        const p = pending.get(msg.id);
        if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg); }
      }
    });
    onStatus(true);
    c.on('exit', () => {
      if (child === c) child = null;
      failPending('sonda encerrada');
      onStatus(false);
      if (stopped) return;
      // ponytail: espera crescente até 30 s; sem limite de tentativas, a sonda é obrigatória
      setTimeout(() => { if (!stopped) launch(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    });
  };
  launch();

  return {
    send(cmd, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const c = child;
        if (!c || !c.stdin || c.stdin.destroyed) { reject(new Error('sonda indisponível')); return; }
        const id = `c${++seq}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('sonda não respondeu')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const full = { type: cmd.type, id, pids: cmd.pids } as ProbeCommand;
        c.stdin.write(JSON.stringify(full) + '\n');
      });
    },
    pid: () => child?.pid ?? null,
    stop() {
      stopped = true;
      const c = child;
      if (!c) return;
      c.stdin?.end();          // a sonda sai sozinha quando o stdin fecha
      setTimeout(() => { if (c.exitCode === null) c.kill(); }, 1_000).unref();
    },
  };
}
