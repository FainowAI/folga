import { useRef, useState } from 'react';
import type { AppGroup, MemoryState, ReleaseResponse, View } from '../../src/types';
import { protectedRows, type ProtectedRow } from '../../src/protegidos';
import type { Source } from './mock';
import { NB, OUTCOME, ago, autoCareAt, gb, pct, plural, pressureName, size } from './format';
import { Particles } from './Particles';
import { selection } from './selection';

function reasonText(a: AppGroup, s: MemoryState) {
  const since = () => ago(s.t - (a.lastFocusedAt ?? s.startedAt));
  switch (a.reason) {
    case 'idle': return `parado há ${since()}`;
    case 'foreground': return 'em primeiro plano';
    case 'audio': return 'tocando áudio';
    case 'busy': return `ocupado · ${pct(a.cpuPercent)} CPU`;
    case 'recent': return `usado há ${since()}`;
    case 'multi_window': return `${a.windows ?? 2} janelas · fechar faz o navegador reabrir só a última`;
    default: return '';
  }
}

type Result = { res: ReleaseResponse; total: number } | 'erro' | null;

function Avatar({ name }: { name: string }) {
  return <span className="avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>;
}

function Group({ cls, name, total, open, onToggle, children }: {
  cls: string; name: string; total: string; children?: React.ReactNode;
  open?: boolean; onToggle?: () => void;   // com os dois, a cabeça vira botão que abre e fecha
}) {
  const head = <><span className="g-name">{name}</span><span className="g-total">{total}</span></>;
  return (
    <section className={`group ${cls}`}>
      <h2 className="g-head">
        {onToggle
          ? <button type="button" className="g-toggle" aria-expanded={open} onClick={onToggle}>
              {head}<span className={`g-chev${open ? ' g-chev-open' : ''}`} aria-hidden="true" />
            </button>
          : head}
      </h2>
      {children}
    </section>
  );
}

// R36: só leitura. Nenhum protegido vira botão de fechar; o único próximo passo é a lista do usuário.
function ProtRow({ row, go }: { row: ProtectedRow; go?: (v: View) => void }) {
  return (
    <div className="row row-static">
      <span />
      <Avatar name={row.name} />
      <span className="row-text">
        <span className="row-name">{row.name}</span>
        <span className="row-reason">
          {row.words}
          {row.procs > 1 && ` · ${plural(row.procs, 'processo', 'processos')}`}
          {row.canUnprotect && go && (
            <> · <button type="button" className="link" onClick={() => go('ajustes')}>Tirar da lista</button></>
          )}
        </span>
      </span>
      <span className="row-size">
        {size(row.bytes)}
        {/* R36: o que este app segura em serviços sem janela, ao lado do próprio tamanho, para o
            usuário não somar de cabeça. Os dois separados: somar na coluna contaria duas vezes. */}
        {row.services > 0 && <span className="row-plus">+ {size(row.services)} em serviços</span>}
      </span>
    </div>
  );
}

function AppRow({ app, s, on, disabled, toggle }: {
  app: AppGroup; s: MemoryState; on: boolean; disabled: boolean; toggle: (k: string) => void;
}) {
  return (
    <label className="row">
      <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(app.key)} />
      <Avatar name={app.name} />
      <span className="row-text">
        <span className="row-name">{app.name}</span>
        <span className="row-reason">{reasonText(app, s)}</span>
      </span>
      <span className="row-size">{size(app.privateWorkingSet)}</span>
    </label>
  );
}

export function Memory({ state, source, go }: { state: MemoryState | null; source: Source; go?: (v: View) => void }) {
  // Marcas feitas à mão; o resto segue o padrão (R04, R06), recalculado a cada leitura.
  const [hand, setHand] = useState({ on: new Set<string>(), off: new Set<string>() });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [showList, setShowList] = useState(true);
  // R36: o grupo protegido abre e fecha. `null` = ninguém mexeu, então ele abre sozinho quando nada
  // está parado — é justo o caso em que a tela não tinha próximo passo nenhum para dar.
  const [showProt, setShowProt] = useState<boolean | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const sel = state ? selection(state.apps, hand.on, hand.off) : new Set<string>();

  const toggle = (k: string) =>
    setHand((h) => {
      const on = new Set(h.on), off = new Set(h.off);
      if (sel.has(k)) { on.delete(k); off.add(k); } else { off.delete(k); on.add(k); }
      return { on, off };
    });

  async function release() {
    setBusy(true);
    setResult(null);
    try {
      const res = await source.release([...sel]);
      setResult({ res, total: state?.totalPhys ?? 0 });
      setShowList(true);
    } catch {
      setResult('erro');
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return <section className="page"><h1 className="page-title">Liberar memória</h1><p className="muted" role="status">Lendo a memória…</p></section>;
  }

  const bySize = (a: AppGroup, b: AppGroup) => b.privateWorkingSet - a.privateWorkingSet;
  const idle = state.apps.filter((a) => a.state === 'idle').sort(bySize);
  const inUse = state.apps.filter((a) => a.state === 'in_use').sort(bySize);
  const prot = protectedRows(state.apps);
  const protProcs = prot.reduce((n, r) => n + r.procs, 0);
  const protBytes = prot.reduce((n, r) => n + r.bytes, 0);
  const protOpen = showProt ?? idle.length === 0;
  const biggest = prot[0];
  const sum = (l: AppGroup[]) => l.reduce((n, a) => n + a.privateWorkingSet, 0);
  const used = state.totalPhys - state.availPhys;
  const { settings } = state;

  let summary = '';
  if (busy) summary = 'Fechando do jeito normal e conferindo. Pode levar alguns segundos.';
  else if (result === 'erro') summary = 'Não deu para liberar agora. Tente de novo.';
  else if (result) {
    const back = result.res.availAfter - result.res.availBefore;   // R08: nunca a soma dos apps
    const now = `${gb(result.total - result.res.availAfter)} de ${gb(result.total)}${NB}GB em uso`;
    summary = back > 0 ? `✓ ${size(back)} liberados · ${now}` : `Nada voltou para a memória · ${now}`;
  }

  return (
    <section className="mem" aria-labelledby="mem-title">
      <header className="mem-head">
        <div>
          <h1 className="page-title" id="mem-title">Liberar memória</h1>
          <p className="muted">{!settings.autoCareEnabled ? 'Auto Care desligado'
            : settings.autoCareTrigger === 'pressure' ? `Auto Care ${autoCareAt(settings)}` : `Auto Care começa ${autoCareAt(settings)}`}</p>
          {state.memPressure && (
            <p className="muted">Pressão: {pressureName[state.memPressure]}{state.swapUsed !== undefined && ` · swap ${size(state.swapUsed)}`}</p>
          )}
        </div>
        <p className="mem-usage">{gb(used)} de {gb(state.totalPhys)}{NB}GB em uso · {pct(state.memLoad)}</p>
      </header>

      <div className="mem-body">
        <div className="meter-col">
          <Particles memLoad={state.memLoad} anchor={barRef} />
          <div className="meter" role="meter" aria-label="Memória usada" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(state.memLoad)} aria-valuetext={`${pct(state.memLoad)} em uso`}>
            <div className="meter-label"><span>Memória usada</span><strong>{pct(state.memLoad)}</strong></div>
            <div className="meter-bar" ref={barRef}>
              <div className="meter-fill" style={{ transform: `scaleY(${Math.min(100, state.memLoad) / 100})` }} />
              {settings.autoCareEnabled && settings.autoCareTrigger === 'percent' && (
                <div className="meter-tick" style={{ bottom: `${settings.autoCareThreshold}%` }} aria-hidden="true" />
              )}
            </div>
          </div>
        </div>

        <div className="mem-list">
          {result && result !== 'erro' && showList && (
            <section className="result" aria-labelledby="res-title">
              <h2 id="res-title" className="result-head">
                Resultado
                <button type="button" className="link" onClick={() => setShowList(false)}>Ocultar</button>
              </h2>
              <ul>
                {result.res.results.map((r) => (
                  <li key={r.key}>
                    <Avatar name={r.name} />
                    <span className="row-name">{r.name}</span>
                    <span className={`out out-${OUTCOME[r.outcome].tone}`}>{OUTCOME[r.outcome].text}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <Group cls="g-idle" name="Parados" total={idle.length ? `${plural(idle.length, 'app', 'apps')} · ${size(sum(idle))}` : ''}>
            {idle.length
              ? idle.map((a) => <AppRow key={a.key} app={a} s={state} on={sel.has(a.key)} disabled={busy} toggle={toggle} />)
              : <p className="empty">
                  Nada parado há mais de {settings.idleMinutes}{NB}min.
                  {biggest && <> Agora quem mais ocupa é <strong>{biggest.name}</strong> ({size(biggest.bytes)}), em Sistema e protegidos.</>}
                </p>}
          </Group>

          {inUse.length > 0 && (
            <Group cls="g-use" name="Em uso" total={`${plural(inUse.length, 'app', 'apps')} · ${size(sum(inUse))}`}>
              {inUse.map((a) => <AppRow key={a.key} app={a} s={state} on={sel.has(a.key)} disabled={busy} toggle={toggle} />)}
            </Group>
          )}

          <Group cls="g-sys" name="Sistema e protegidos" total={`${plural(protProcs, 'processo', 'processos')} · ${size(protBytes)}`}
            open={protOpen} onToggle={() => setShowProt(!protOpen)}>
            {protOpen && (prot.length > 0
              ? <>
                  {prot.map((r) => <ProtRow key={r.key} row={r} go={go} />)}
                  <p className="empty">Nada aqui é fechado pelo Folga (R05). Só a sua lista "nunca fechar" sai daqui, em Ajustes.</p>
                </>
              : <p className="empty">Nada protegido nesta leitura.</p>)}
          </Group>

          {state.freed.length > 0 && (
            <Group cls="g-freed" name="Liberados" total={plural(state.freed.length, 'app', 'apps')}>
              {state.freed.map((r) => (
                <div className="row row-static" key={r.key}>
                  <span />
                  <Avatar name={r.name} />
                  <span className="row-text"><span className="row-name">{r.name}</span></span>
                  <span className="row-reason">{OUTCOME[r.outcome].text}</span>
                </div>
              ))}
            </Group>
          )}
        </div>
      </div>

      <footer className="mem-foot">
        <p className="summary" role="status" aria-live="polite">{summary}</p>
        <button type="button" className="pill pill-accent" disabled={sel.size === 0 && !busy} aria-busy={busy}
          aria-disabled={busy} onClick={() => { if (!busy) void release(); }}>
          {busy ? 'Liberando…' : 'Liberar'}
        </button>
      </footer>
    </section>
  );
}
