import { useEffect, useState } from 'react';
import type { MemoryState, Severity, StartupApp, View, Warning } from '../../src/types';
import { getStartupApps, getWarnings, onEvent } from './api';
import { ago, plural } from './format';
import './styles/avisos.css';

const GROUPS: { sev: Severity; label: string }[] = [
  { sev: 'critico', label: 'Crítico' }, { sev: 'atencao', label: 'Atenção' }, { sev: 'info', label: 'Informação' },
];
type Filter = 'todos' | Severity;
const FILTERS: { key: Filter; label: string }[] = [{ key: 'todos', label: 'Todos' }, ...GROUPS.map(g => ({ key: g.sev, label: g.label }))];

const IS_MAC = /Mac/.test(navigator.platform);
const SOURCE: Record<StartupApp['source'], string> = {
  registro_usuario: 'Registro · só este usuário',
  registro_maquina: 'Registro · todos os usuários',
  pasta_inicializar: 'Pasta Inicializar',
  launchagent_usuario: 'LaunchAgent · só você',
  launchagent_sistema: 'LaunchAgent · todos os usuários',
  launchdaemon: 'LaunchDaemon · sistema',
};

const Check = () => (
  <svg className="av-check" viewBox="0 0 56 56" fill="none" aria-hidden="true">
    <circle cx="28" cy="28" r="26" stroke="currentColor" strokeWidth="2" opacity="0.35" />
    <path d="M17 29l7 7 15-16" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function Avisos({ state, go }: { state: MemoryState | null; go: (v: View) => void }) {
  const [warnings, setWarnings] = useState<Warning[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('todos');
  const [apps, setApps] = useState<StartupApp[] | null>(null);
  const [appsFailed, setAppsFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Dados ao vivo: leitura inicial + evento 'warnings' (a lista inteira a cada mudança).
  useEffect(() => {
    let alive = true;
    const off = onEvent('warnings', l => { if (alive && Array.isArray(l)) setWarnings(l); });
    getWarnings()
      .then(l => { if (alive && Array.isArray(l)) setWarnings(prev => prev ?? l); })
      .catch(() => { if (alive) setFailed(true); });
    const tick = setInterval(() => setNow(Date.now()), 30_000);   // "há X min" anda sozinho
    return () => { alive = false; off(); clearInterval(tick); };
  }, []);

  // Apps de inicialização: ao abrir e ao voltar para a janela (o servidor guarda 5 min de cache).
  useEffect(() => {
    let alive = true;
    const load = () => getStartupApps()
      .then(l => { if (alive && Array.isArray(l)) { setApps(l); setAppsFailed(false); } })
      .catch(() => { if (alive) setAppsFailed(true); });
    load();
    window.addEventListener('focus', load);
    return () => { alive = false; window.removeEventListener('focus', load); };
  }, []);

  const all = (warnings ?? []).filter(w => w.active);
  const count = (f: Filter) => (f === 'todos' ? all.length : all.filter(w => w.severity === f).length);
  const shown = all.filter(w => filter === 'todos' || w.severity === filter);
  const onlyCritical = state?.settings.warningsLevel === 'criticos';

  const sorted = [...(apps ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, 'pt-BR'));
  const enabledApps = sorted.filter(a => a.enabled).length;

  return (
    <section className="av" aria-labelledby="av-title">
      <div className="page av-inner">
        <h1 className="page-title" id="av-title">Avisos</h1>
        <p className="muted">O que merece a sua atenção agora, do mais urgente ao menos.</p>

        <div className="av-chips" role="group" aria-label="Filtrar por gravidade">
          {FILTERS.map(f => (
            <button key={f.key} type="button" className="av-chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label} <span className="av-chip-n">{count(f.key)}</span>
            </button>
          ))}
        </div>

        <div className="av-list" aria-live="polite" aria-relevant="additions removals">
          {failed && warnings === null && <p className="av-error" role="alert">Não deu para ler os avisos agora.</p>}
          {warnings !== null && shown.length === 0 && (
            <div className="av-empty">
              <Check />
              <p className="av-empty-title">{all.length === 0 ? 'Tudo certo por aqui' : 'Nada nesse filtro'}</p>
              <p className="muted">{all.length === 0 ? 'Nenhum aviso no momento. Eu aviso quando algo precisar de você.' : 'Os outros avisos continuam em "Todos".'}</p>
            </div>
          )}
          {GROUPS.map(({ sev, label }) => {
            const items = shown.filter(w => w.severity === sev);
            if (!items.length) return null;
            return (
              <section key={sev} className={`av-group av-${sev}`} aria-labelledby={`av-g-${sev}`}>
                <h2 className="av-group-head" id={`av-g-${sev}`}>{label} · {plural(items.length, 'aviso', 'avisos')}</h2>
                <ul className="av-items">
                  {items.map(w => (
                    <li key={w.id} className="av-item">
                      <span className="av-dot" aria-hidden="true" />
                      <div>
                        <p className="av-title">{w.title}</p>
                        <p className="av-detail">{w.detail}</p>
                      </div>
                      <span className="av-time">há {ago(now - w.firstSeen)}</span>
                      {w.view && (
                        <button type="button" className="av-resolve" aria-label={`Resolver: ${w.title}`} onClick={() => go(w.view as View)}>Resolver</button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <p className="av-note">
          O ícone da barra mostra: {onlyCritical ? 'só os avisos críticos' : 'todos os avisos'}{' '}
          (<button type="button" onClick={() => go('ajustes')}>mude em Ajustes</button>).
        </p>

        <section className="av-startup" aria-labelledby="av-startup-title">
          <h2 className="av-startup-title" id="av-startup-title">{IS_MAC ? 'Apps que abrem com o Mac' : 'Apps que abrem com o Windows'}</h2>
          <p className="muted">
            {apps === null ? 'Lendo a lista… ' : `${plural(enabledApps, 'ativo', 'ativos')} de ${apps.length}. `}
            {IS_MAC
              ? 'Só leitura. Itens de login (Ajustes do Sistema › Geral › Itens de Início) não aparecem aqui: o macOS só os mostra com senha de administrador.'
              : 'Só leitura: para ligar ou desligar, use Configurações do Windows › Aplicativos › Inicialização.'}
          </p>
          {appsFailed && apps === null && <p className="av-error" role="alert">Não deu para ler os apps de inicialização agora.</p>}
          {apps !== null && apps.length === 0 && <p className="muted">Nenhum app configurado para abrir com o {IS_MAC ? 'Mac' : 'Windows'}.</p>}
          {sorted.length > 0 && (
            <ul className="av-startup-list">
              {sorted.map(a => (
                <li key={`${a.source}:${a.name}`} className={`av-app${a.enabled ? "" : " av-app-dim"}`}>
                  <span className="av-app-name" title={a.command}>{a.name}</span>
                  <span className="av-app-src">{SOURCE[a.source]}</span>
                  <span className={`av-app-state${a.enabled ? ' av-app-on' : ''}`}>{a.enabled ? 'Ativo' : 'Desativado'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
