// Contrato da sonda como checagem executável (JS puro: o probe-smoke importa daqui).
// Fonte dos tipos: src/types.ts. Cada função devolve uma mensagem por regra violada.
import { cpus } from 'node:os';

const int = v => Number.isInteger(v);
const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const PRESSURES = ['normal', 'warn', 'critical'];

export function snapshotErrors(s, opts = {}) {
  const { mac = false, prev } = opts;
  const e = [];
  if (!s || typeof s !== 'object') return ['snapshot: não é objeto'];
  if (s.type !== 'snapshot') e.push('type: deveria ser "snapshot"');
  if (!int(s.t) || Math.abs(Date.now() - s.t) >= 60_000) e.push('t: inteiro a menos de 60 s de agora');
  if (!int(s.totalPhys) || s.totalPhys <= 0) e.push('totalPhys: inteiro > 0');
  if (!(num(s.availPhys) && s.availPhys > 0 && s.availPhys < s.totalPhys)) e.push('availPhys: precisa estar entre 0 e totalPhys');
  if (!int(s.memLoad) || s.memLoad < 0 || s.memLoad > 100) e.push('memLoad: inteiro 0-100');
  else if (s.totalPhys > 0 && Math.abs(s.memLoad - (100 * (s.totalPhys - s.availPhys)) / s.totalPhys) > 2) e.push('memLoad: fora de ±2 de 100×(total−avail)/total');
  if (!('foregroundPid' in s)) e.push('foregroundPid: chave ausente');
  else if (s.foregroundPid !== null && !int(s.foregroundPid)) e.push('foregroundPid: null ou inteiro');
  if ('diskActive' in s && s.diskActive !== null && !(num(s.diskActive) && s.diskActive <= 100)) e.push('diskActive: null ou 0-100');
  if ('audioPids' in s && !(Array.isArray(s.audioPids) && s.audioPids.every(int))) e.push('audioPids: array de inteiros');
  if (mac) {
    if (!('diskActive' in s)) e.push('diskActive: chave ausente (Mac)');
    if (!('audioPids' in s)) e.push('audioPids: chave ausente (Mac)');
    if (!PRESSURES.includes(s.memPressure)) e.push('memPressure: normal|warn|critical');
    if (!num(s.swapUsed)) e.push('swapUsed: número ≥ 0');
  }
  if (!Array.isArray(s.processes) || !s.processes.length) { e.push('processes: array não vazio'); return e; }
  const seen = new Set();
  for (const p of s.processes) {
    const w = `processes[${p?.pid}]`;
    if (!int(p.pid) || p.pid < 0) e.push(`${w}.pid: inteiro ≥ 0`);   // 0 = System Idle Process do Windows
    else if (seen.has(p.pid)) e.push(`${w}.pid: repetido`);
    seen.add(p.pid);
    if (!int(p.ppid) || p.ppid < 0) e.push(`${w}.ppid: inteiro ≥ 0`);
    if (typeof p.name !== 'string' || !p.name) e.push(`${w}.name: string não vazia`);
    if (typeof p.description !== 'string') e.push(`${w}.description: string`);
    if (!int(p.session)) e.push(`${w}.session: inteiro`);
    if (!num(p.privateWorkingSet)) e.push(`${w}.privateWorkingSet: ≥ 0`);
    if (!num(p.cpuTimeMs)) e.push(`${w}.cpuTimeMs: ≥ 0`);
    if (typeof p.hasVisibleWindow !== 'boolean') e.push(`${w}.hasVisibleWindow: booleano`);
    if (typeof p.accessible !== 'boolean') e.push(`${w}.accessible: booleano`);
    if ('windowCount' in p) {
      if (!int(p.windowCount) || p.windowCount < 0) e.push(`${w}.windowCount: inteiro ≥ 0`);
      // No Mac hasVisibleWindow = "app do Dock" e pode valer com 0 janelas (decisão 2026-10-20).
      else if (!mac && p.hasVisibleWindow !== p.windowCount > 0) e.push(`${w}.windowCount: hasVisibleWindow deveria ser windowCount > 0`);
    } else if (mac) e.push(`${w}.windowCount: ausente (Mac)`);
  }
  if (prev?.processes) {
    const antes = new Map(prev.processes.map(p => [p.pid, p]));
    const teto = (s.t - prev.t) * cpus().length * 1.1;   // ms de CPU possíveis no intervalo
    for (const p of s.processes) {
      const a = antes.get(p.pid);
      if (!a) continue;
      if (p.cpuTimeMs < a.cpuTimeMs) e.push(`processes[${p.pid}].cpuTimeMs: diminuiu`);
      else if (p.cpuTimeMs - a.cpuTimeMs > teto) e.push(`processes[${p.pid}].cpuTimeMs: delta acima de núcleos×intervalo×1,1`);
    }
  }
  return e;
}

export function replyErrors(r, id) {
  const e = [];
  if (!r || typeof r !== 'object') return ['reply: não é objeto'];
  if (r.type !== 'reply') e.push('type: deveria ser "reply"');
  if (r.id !== id) e.push(`id: esperado ${id}, veio ${r.id}`);
  if (typeof r.ok !== 'boolean') e.push('ok: booleano');
  if (!int(r.windowsClosed) || r.windowsClosed < 0) e.push('windowsClosed: inteiro ≥ 0');
  return e;
}
