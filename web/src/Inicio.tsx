// Início (D18): painel no estilo do Mint (nota em anel, memória e disco em linha) com a nota de saúde e os problemas,
// como o "Status do dispositivo" do McAfee. Dados vivos: SSE de avisos e sugestões, disco a cada 60 s.
import { useEffect, useRef, useState } from 'react';
import type { DiskInfo, MemoryState, Sample, Severity, Suggestion, View, Warning } from '../../src/types';
import { getDisk, getSuggestions, getWarnings, onEvent } from './api';
import { NB, autoCareAt, gb, nf0, pct, plural, size } from './format';
import { computeHealth, systemDisk } from './health';
import { SuggestionCard } from './SuggestionCard';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Conta do 0 (ou do valor anterior) até o alvo em ~600 ms. */
function useCountUp(target: number, ms = 600) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (reducedMotion()) { from.current = target; setV(target); return; }
    const start = performance.now(), a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const val = a + (target - a) * (1 - (1 - t) ** 3);
      from.current = val;
      setV(val);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function CountUp({ value, format = (n: number) => nf0.format(n) }: { value: number; format?: (n: number) => string }) {
  return <>{format(useCountUp(value))}</>;
}

/** Anel com o arco animado por stroke-dashoffset. O texto de dentro é decoração; o rótulo vai no role="img". */
function Ring({ value, px, stroke, tone, label, children }: {
  value: number; px: number; stroke: number; tone: string; label: string; children?: React.ReactNode;
}) {
  const r = (px - stroke) / 2, c = 2 * Math.PI * r;
  const [on, setOn] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(id); }, []);
  const shown = on ? Math.min(100, Math.max(0, value)) : 0;
  return (
    <div className="ring" style={{ width: px, height: px }} role="img" aria-label={label}>
      <svg viewBox={`0 0 ${px} ${px}`} aria-hidden="true">
        <circle className="ring-track" cx={px / 2} cy={px / 2} r={r} strokeWidth={stroke} />
        <circle className="ring-arc" cx={px / 2} cy={px / 2} r={r} strokeWidth={stroke} stroke={tone}
          strokeDasharray={c} style={{ strokeDashoffset: c * (1 - shown / 100) }} transform={`rotate(-90 ${px / 2} ${px / 2})`} />
      </svg>
      <div className="ring-in" aria-hidden="true">{children}</div>
    </div>
  );
}

const WINDOW = 60_000;   // = SAMPLE_WINDOW_MS do servidor
const CW = 300, CH = 100;  // sistema de coordenadas do SVG; ele estica na largura do cartão

/** Gráfico de linha dos últimos 60 s, eixo fixo de 0 a 100 %, como o Gerenciador de Tarefas. Hover mostra o ponto. */
function LineChart({ samples, pick, tone, label }: {
  samples: Sample[] | undefined; pick: (s: Sample) => number | null; tone: string; label: string;
}) {
  const [hover, setHover] = useState<{ t: number; v: number } | null>(null);
  const pts = (samples ?? []).map(s => ({ t: s.t, v: pick(s) }));
  const end = pts.at(-1)?.t ?? 0;
  const x = (t: number) => ((t - end + WINDOW) / WINDOW) * CW;
  const y = (v: number) => CH - (Math.min(100, Math.max(0, v)) / 100) * CH;
  // leitura sem valor (1ª da sonda) quebra a linha em vez de cair para zero
  let cur: [number, number][] = [];
  const segs = [cur];
  for (const p of pts) {
    if (p.v !== null) cur.push([x(p.t), y(p.v)]);
    else if (cur.length) segs.push(cur = []);
  }
  const live = segs.filter(g => g.length > 1);
  const xy = ([a, b]: [number, number]) => `${a.toFixed(1)},${b.toFixed(1)}`;
  const line = live.map(g => 'M' + g.map(xy).join('L')).join('');
  const area = live.map(g => `M${xy([g[0]![0], CH])}L${g.map(xy).join('L')}L${xy([g.at(-1)![0], CH])}Z`).join('');
  const h = hover;

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = end - WINDOW + ((e.clientX - r.left) / r.width) * WINDOW;
    let best: { t: number; v: number } | null = null;
    for (const p of pts) if (p.v !== null && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = { t: p.t, v: p.v };
    setHover(best);
  };
  const at = (t: number) => `${(x(t) / CW) * 100}%`;

  return (
    <div className="chart" role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" aria-hidden="true">
        {[25, 50, 75].map(g => <line key={g} className="chart-grid" x1={0} x2={CW} y1={y(g)} y2={y(g)} vectorEffect="non-scaling-stroke" />)}
        {area && <path d={area} fill={tone} fillOpacity={0.14} />}
        {line && <path d={line} className="chart-line" stroke={tone} vectorEffect="non-scaling-stroke" />}
      </svg>
      {!line && <span className="chart-empty">{samples ? 'Juntando leituras…' : 'Reinicie o Folga para ver o gráfico.'}</span>}
      {h && (
        <>
          <i className="chart-cross" style={{ left: at(h.t) }} />
          <i className="chart-dot" style={{ left: at(h.t), top: `${(y(h.v) / CH) * 100}%`, background: tone }} />
          <span className={`chart-tip${x(h.t) > CW * 0.6 ? ' chart-tip-l' : ''}`} style={{ left: at(h.t) }}>
            <b>{nf0.format(h.v)}{NB}%</b> {end - h.t < 1_000 ? 'agora' : `há ${nf0.format((end - h.t) / 1_000)}${NB}s`}
          </span>
        </>
      )}
      <span className="chart-axis" aria-hidden="true"><span>60{NB}s</span><span>agora</span></span>
    </div>
  );
}

/** Carrega uma vez, relê a cada `every` ms (se houver) e assina o evento SSE (se houver). */
function useLive<T>(load: () => Promise<T>, subscribe: ((cb: (d: T) => void) => () => void) | null, every?: number) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const run = () => load().then(
      d => { if (alive) { setData(d); setFailed(false); } },
      () => { if (alive) setFailed(true); },
    );
    void run();
    const timer = every ? setInterval(() => { if (!document.hidden) void run(); }, every) : undefined;
    const off = subscribe?.(d => { if (alive && Array.isArray(d)) { setData(d); setFailed(false); } });
    return () => { alive = false; clearInterval(timer); off?.(); };
  }, [load, subscribe, every]);
  return { data, failed };
}

const asList = <T,>(l: unknown): T[] => (Array.isArray(l) ? (l as T[]) : []);
const loadWarnings = () => getWarnings().then(l => asList<Warning>(l));
const loadSuggestions = () => getSuggestions().then(l => asList<Suggestion>(l));
const loadDisk = () => getDisk().then(l => asList<DiskInfo>(l));
const subWarnings = (cb: (d: Warning[]) => void) => onEvent('warnings', cb);
const subSuggestions = (cb: (d: Suggestion[]) => void) => onEvent('suggestions', cb);

const STATUS = {
  bom: { word: 'Bom', tone: 'var(--accent)', line: 'Tudo em ordem. Seu computador está com folga.' },
  regular: { word: 'Regular', tone: 'var(--idle)', line: 'Quase lá. Resolva os pontos abaixo para ganhar folga.' },
  critico: { word: 'Crítico', tone: 'var(--danger)', line: 'Seu computador precisa de atenção agora.' },
} as const;

const SEV: Record<Severity, { rank: number; text: string; tone: string }> = {
  critico: { rank: 0, text: 'Crítico', tone: 'var(--danger)' },
  atencao: { rank: 1, text: 'Atenção', tone: 'var(--idle)' },
  info: { rank: 2, text: 'Info', tone: 'var(--in-use)' },
};

const Check = () => (
  <svg className="home-check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 9.8" />
  </svg>
);
const Chevron = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);

export function Inicio({ state, go }: { state: MemoryState | null; go: (v: View, prompt?: string) => void }) {
  const warnings = useLive(loadWarnings, subWarnings);
  const suggestions = useLive(loadSuggestions, subSuggestions);
  const disks = useLive(loadDisk, null, 60_000);

  const active = (warnings.data ?? []).filter(w => w.active)
    .sort((a, b) => SEV[a.severity].rank - SEV[b.severity].rank || b.lastSeen - a.lastSeen);
  const pending = (suggestions.data ?? []).filter(s => s.status === 'pendente');
  const sys = systemDisk(disks.data ?? []);

  const health = computeHealth({ state, warnings: active, disks: disks.data ?? [], pendingSuggestions: pending.length });
  const st = STATUS[health.status];
  // sem resposta de alguma fonte, a nota não pode afirmar que está tudo bem
  const partial = [warnings, suggestions, disks].some(r => r.failed && !r.data);
  const score = useCountUp(health.score);

  const used = state ? state.totalPhys - state.availPhys : 0;
  const diskUsed = sys ? sys.total - sys.free : 0;
  const diskPct = sys && sys.total > 0 ? (diskUsed / sys.total) * 100 : 0;
  const diskLow = sys && sys.total > 0 && sys.free / sys.total < 0.1;
  const diskTone = diskLow ? 'var(--danger)' : 'var(--idle)';
  const diskNow = state?.samples?.at(-1)?.disk ?? null;

  return (
    <section className="page home" aria-labelledby="home-title">
      <header className="home-head">
        <div>
          <h1 className="page-title" id="home-title">Início</h1>
          <p className="muted home-line" role="status" aria-live="polite">{!state ? 'Lendo o computador…' : partial ? 'Algumas leituras falharam; a nota pode estar incompleta.' : st.line}</p>
        </div>
        <button type="button" className="pill" onClick={() => go('assistente')}>Pergunte ao assistente</button>
      </header>

      <div className="home-grid">
        {/* nota de saúde */}
        <article className="card home-health" aria-labelledby="home-health-t">
          <Ring value={state ? health.score : 0} px={172} stroke={12} tone={st.tone} label={`Nota de saúde: ${health.score} de 100, ${st.word}`}>
            <span className="ring-num">{state ? nf0.format(score) : '–'}</span>
            <span className="ring-sub">de 100</span>
          </Ring>
          <div className="home-health-body">
            <h2 className="card-t" id="home-health-t">Saúde do computador</h2>
            <p className="home-word" style={{ color: st.tone }}>{state ? st.word : '–'}</p>
            {state && !partial && health.problems.length === 0 && (
              <p className="home-ok"><Check />Nenhum problema encontrado.</p>
            )}
            {health.problems.length > 0 && (
              <ul className="home-problems" aria-label="Problemas encontrados">
                {health.problems.map((p, i) => (
                  <li key={`${p.view}-${i}`}>
                    <button type="button" className="home-problem" onClick={() => go(p.view, p.prompt)}>
                      <span className="home-problem-text">{p.text}</span>
                      <span className="home-problem-go">{p.prompt ? 'Pedir ao assistente' : 'Resolver'}<Chevron /></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </article>

        {/* memória */}
        <article className="card home-ring-card" aria-labelledby="home-mem-t">
          <div className="card-head">
            <h2 className="card-t" id="home-mem-t">Memória</h2>
            <button type="button" className="link" onClick={() => go('memoria')}>Liberar</button>
          </div>
          {state ? (
            <div className="home-ring-row">
              <div className="home-plot">
                <p className="home-now"><span className="ring-num ring-num-sm"><CountUp value={state.memLoad} />{NB}%</span><span className="ring-sub">em uso</span></p>
                <LineChart samples={state.samples} pick={s => s.mem} tone="var(--in-use)" label={`Memória em uso nos últimos 60 segundos; agora ${pct(state.memLoad)}`} />
              </div>
              <dl className="home-facts">
                <div><dt><i className="dot" style={{ background: 'var(--in-use)' }} />Em uso</dt><dd>{gb(used)}{NB}GB</dd></div>
                <div><dt><i className="dot dot-empty" />Livre</dt><dd>{gb(state.availPhys)}{NB}GB</dd></div>
                <div><dt>Total</dt><dd>{gb(state.totalPhys)}{NB}GB</dd></div>
              </dl>
            </div>
          ) : <p className="muted" role="status">Lendo a memória…</p>}
          {state && (
            <p className="home-foot"><span>Auto Care</span>
              <span>{state.settings.autoCareEnabled ? autoCareAt(state.settings).replace(/^./, (c) => c.toUpperCase()) : 'desligado'}</span></p>
          )}
        </article>

        {/* disco */}
        <article className="card home-ring-card" aria-labelledby="home-disk-t">
          <div className="card-head">
            <h2 className="card-t" id="home-disk-t">Disco{sys ? ` ${sys.drive}` : ''}</h2>
            <button type="button" className="link" onClick={() => go('arquivos')}>Arquivos</button>
          </div>
          {sys && sys.total > 0 ? (
            <div className="home-ring-row">
              <div className="home-plot">
                <p className="home-now">
                  <span className="ring-num ring-num-sm">{diskNow === null ? '–' : <><CountUp value={diskNow} />{NB}%</>}</span>
                  <span className="ring-sub">em atividade</span>
                </p>
                <LineChart samples={state?.samples} pick={s => s.disk} tone={diskTone}
                  label={`Atividade do disco nos últimos 60 segundos${diskNow === null ? '' : `; agora ${pct(diskNow)}`}. ${size(sys.free)} livres em ${sys.drive}`} />
              </div>
              <dl className="home-facts">
                <div><dt><i className="dot" style={{ background: diskTone }} />Ocupado</dt><dd>{size(diskUsed)}</dd></div>
                <div><dt><i className="dot dot-empty" />Livre</dt><dd>{size(sys.free)}</dd></div>
                {sys.purgeable !== undefined && sys.purgeable > 0 && <div><dt>Liberável pelo sistema</dt><dd>{size(sys.purgeable)}</dd></div>}
                <div><dt>Total</dt><dd>{size(sys.total)}</dd></div>
              </dl>
            </div>
          ) : disks.failed
            ? <p className="muted" role="status">Não deu para ler o disco agora.</p>
            : <p className="muted" role="status">{disks.data ? 'Nenhum disco encontrado.' : 'Lendo o disco…'}</p>}
          {sys && sys.total > 0 && (
            <p className="home-foot"><span>Espaço lido a cada minuto</span><span>{pct(diskPct)} ocupado</span></p>
          )}
        </article>

        {/* avisos */}
        <article className="card" aria-labelledby="home-warn-t">
          <div className="card-head">
            <h2 className="card-t" id="home-warn-t">Avisos{active.length > 0 && <span className="count">{active.length}</span>}</h2>
            <button type="button" className="link" onClick={() => go('avisos')}>ver todos</button>
          </div>
          {warnings.failed && !warnings.data && <p className="muted" role="status">Não deu para ler os avisos agora.</p>}
          {!warnings.failed && !warnings.data && <p className="muted" role="status">Lendo os avisos…</p>}
          {warnings.data && active.length === 0 && <p className="home-ok"><Check />Nenhum aviso ativo.</p>}
          {active.length > 0 && (
            <ul className="home-warns">
              {active.slice(0, 3).map(w => (
                <li key={w.id}>
                  <button type="button" className="home-warn" onClick={() => go(w.view ?? 'avisos')}>
                    <span className="home-sev" style={{ '--tone': SEV[w.severity].tone } as React.CSSProperties}>{SEV[w.severity].text}</span>
                    <span className="home-warn-text"><span className="home-warn-title">{w.title}</span><span className="home-warn-detail">{w.detail}</span></span>
                    <Chevron />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>

        {/* sugestões pendentes */}
        <article className="card" aria-labelledby="home-sug-t">
          <div className="card-head">
            <h2 className="card-t" id="home-sug-t">Sugestões pendentes{pending.length > 0 && <span className="count">{pending.length}</span>}</h2>
            <button type="button" className="link" onClick={() => go('assistente')}>Assistente</button>
          </div>
          {suggestions.failed && !suggestions.data && <p className="muted" role="status">Não deu para ler as sugestões agora.</p>}
          {!suggestions.failed && !suggestions.data && <p className="muted" role="status">Lendo as sugestões…</p>}
          {suggestions.data && pending.length === 0 && (
            <p className="home-ok"><Check />Nada pendente. O assistente propõe aqui o que dá para limpar.</p>
          )}
          {pending.length > 0 && (
            <ul className="home-sugs">
              {pending.slice(0, 3).map(s => <li key={s.id}><SuggestionCard s={s} compact /></li>)}
            </ul>
          )}
          {pending.length > 3 && <p className="home-foot"><span>{plural(pending.length - 3, 'outra', 'outras')} no Assistente</span></p>}
        </article>
      </div>
    </section>
  );
}
