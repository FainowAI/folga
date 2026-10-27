// Arquivos que o usuário não abre mais (D16) e Limpeza rápida (D17). Nada é feito daqui: os botões só PREPARAM uma
// sugestão, que o usuário aprova no cartão (dois passos, R20).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AppDataScan, MemoryState, QuickCleanItem, StaleFile, StaleScan, Suggestion } from '../../src/types';
import { addSuggestion, getAppData, getQuickClean, getStale, getSuggestions, onEvent, scanStale } from './api';
import { MB, NB, nf1, plural } from './format';
import { SuggestionCard, sizeFine } from './SuggestionCard';
import './styles/arquivos.css';

const DAYS = [30, 90, 180, 365];
const MBS = [1, 10, 50, 100];
const dayLabel = (d: number) => (d === 365 ? '1 ano' : d === 180 ? '6 meses' : d === 90 ? '3 meses' : d === 30 ? '30 dias' : `${d} dias`);
const withValue = (list: number[], v: number) => (list.includes(v) ? list : [...list, v].sort((a, b) => a - b));

const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' });
function agoLong(ms: number) {
  const d = Math.floor(Math.max(0, ms) / 86_400_000);
  if (d >= 730) return `há ${plural(Math.floor(d / 365), 'ano', 'anos')}`;
  if (d >= 60) return `há ${plural(Math.floor(d / 30), 'mês', 'meses')}`;
  if (d >= 1) return `há ${plural(d, 'dia', 'dias')}`;
  return 'hoje';
}
const folderOf = (p: string) => p.slice(0, Math.max(0, p.search(/[\\/][^\\/]*$/)));
// Mesma regra do pathKey do servidor (src/files.ts), repetida porque a interface não importa módulos do Node:
// no Mac o APFS não distingue caixa nem NFC/NFD; no Windows só a caixa.
const pathKey = (p: string, mac: boolean) => (mac ? p.normalize('NFC') : p).toLowerCase();
const BASIS: Record<StaleFile['basis'], string> = {
  acesso: 'último acesso registrado pelo Windows',
  recentes: 'atalho na pasta Recentes do Windows',
  modificacao: 'data de modificação',
  spotlight: 'último uso registrado pelo Spotlight',
  adicionado: 'data em que chegou ao Mac',
};

type SortKey = 'name' | 'folder' | 'size' | 'lastUsed';
const SORT: Record<SortKey, (a: StaleFile, b: StaleFile) => number> = {
  name: (a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }),
  folder: (a, b) => folderOf(a.path).localeCompare(folderOf(b.path), 'pt-BR', { sensitivity: 'base' }),
  size: (a, b) => a.size - b.size,
  lastUsed: (a, b) => a.lastUsed - b.lastUsed,
};

export function Arquivos({ state }: { state: MemoryState | null }) {
  const uid = useId();
  const settings = state?.settings;
  const [days, setDays] = useState(settings?.staleDays ?? 180);
  const [minMB, setMinMB] = useState(settings?.staleMinMB ?? 10);
  const [scan, setScan] = useState<StaleScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'size', dir: -1 });
  const [preparing, setPreparing] = useState<'lixeira' | 'limpeza' | 'dados' | null>(null);
  const [prepError, setPrepError] = useState('');
  const [clean, setClean] = useState<QuickCleanItem[] | null>(null);
  const [cleanError, setCleanError] = useState(false);
  const [apps, setApps] = useState<AppDataScan | null>(null);
  const [appsError, setAppsError] = useState(false);
  const [appSel, setAppSel] = useState<Set<string>>(new Set());
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [created, setCreated] = useState<string | null>(null);   // cartão que acabei de preparar
  const reviewRef = useRef<HTMLElement>(null);
  const settingsApplied = useRef(false);

  // Ajustes chegam depois do primeiro desenho: usa-os como ponto de partida, uma vez
  useEffect(() => {
    if (settings && !settingsApplied.current) { settingsApplied.current = true; setDays(settings.staleDays); setMinMB(settings.staleMinMB); }
  }, [settings]);

  // última varredura guardada pelo servidor
  useEffect(() => {
    let live = true;
    getStale().then(s => {
      if (!live || !s) return;
      setScan(cur => cur ?? s);
      setDays(s.olderThanDays); setMinMB(Math.round(s.minBytes / MB));
      settingsApplied.current = true;
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  // limpeza rápida (a leitura demora alguns segundos: temporários e caches são contados de verdade)
  const loadClean = () => {
    setCleanError(false);
    getQuickClean().then(setClean).catch(() => { setClean(null); setCleanError(true); });
  };
  useEffect(loadClean, []);

  // dados dos apps (Mac e Windows: medição das pastas de dados dos apps, que demora alguns segundos)
  const mac = state?.memPressure !== undefined;
  const loadApps = () => {
    setAppsError(false);
    getAppData().then(setApps).catch(() => { setApps(null); setAppsError(true); });
  };
  useEffect(loadApps, []);

  // sugestões, inclusive as do assistente
  useEffect(() => {
    let live = true;
    getSuggestions().then(l => { if (live) setSugs(l); }).catch(() => {});
    const off = onEvent('suggestions', setSugs);
    return () => { live = false; off(); };
  }, []);

  // depois de uma limpeza aprovada, os números do cartão mudam
  const doneClean = sugs.filter(s => s.kind === 'limpeza_rapida' && s.status === 'feita').length;
  const firstClean = useRef(true);
  const doneApps = sugs.filter(s => s.kind === 'dados_apps' && s.status === 'feita').length;
  const firstApps = useRef(true);
  useEffect(() => { if (firstClean.current) { firstClean.current = false; return; } loadClean(); }, [doneClean]);
  useEffect(() => { if (firstApps.current) { firstApps.current = false; return; } setAppSel(new Set()); loadApps(); }, [doneApps]);

  async function search() {
    setScanning(true); setScanError(''); setSel(new Set());
    try { setScan(await scanStale({ olderThanDays: days, minMB })); }
    catch (e) { setScanError(e instanceof Error ? e.message : 'não deu para procurar agora'); }
    finally { setScanning(false); }
  }

  const rows = useMemo(() => {
    const l = [...(scan?.files ?? [])].sort(SORT[sort.key]);
    return sort.dir === 1 ? l : l.reverse();
  }, [scan, sort]);

  // arquivos que entraram numa sugestão de Lixeira já aprovada: ficam apagados da seleção e marcados
  const handled = useMemo(() => {
    const set = new Set<string>();
    for (const s of sugs) if (s.kind === 'lixeira' && s.status === 'feita') for (const i of s.items) set.add(pathKey(i.id, mac));
    return set;
  }, [sugs, mac]);
  const isHandled = (f: StaleFile) => handled.has(pathKey(f.path, mac));

  const selectable = rows.filter(f => !isHandled(f));
  const chosen = rows.filter(f => sel.has(f.path) && !isHandled(f));
  const chosenBytes = chosen.reduce((n, f) => n + f.size, 0);
  const allOn = selectable.length > 0 && chosen.length === selectable.length;
  const headRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headRef.current) headRef.current.indeterminate = chosen.length > 0 && !allOn; });

  const toggle = (p: string) => setSel(prev => { const n = new Set(prev); if (!n.delete(p)) n.add(p); return n; });
  const toggleAll = () => setSel(allOn ? new Set() : new Set(selectable.map(f => f.path)));
  const sortBy = (key: SortKey) => setSort(s => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' || key === 'folder' ? 1 : -1 }));

  const appItems = (apps?.entries ?? []).flatMap(e => e.items);
  const chosenApp = appItems.filter(i => appSel.has(i.id) && i.actionable && i.bytes > 0);
  const chosenAppBytes = chosenApp.reduce((n, i) => n + i.bytes, 0);
  const toggleApp = (id: string) => setAppSel(prev => { const n = new Set(prev); if (!n.delete(id)) n.add(id); return n; });

  async function prepare(kind: 'lixeira' | 'limpeza' | 'dados') {
    setPreparing(kind); setPrepError('');
    try {
      const s = kind === 'lixeira'
        ? await addSuggestion({
            kind: 'lixeira', items: chosen.map(f => f.path),
            title: `Mandar ${plural(chosen.length, 'arquivo parado', 'arquivos parados')} para a Lixeira`,
            reason: `Não são abertos há mais de ${dayLabel(scan?.olderThanDays ?? days)}; ficam ${sizeFine(chosenBytes)} livres. Dá para restaurar pela Lixeira.`,
          })
        : kind === 'dados'
        ? await addSuggestion({
            kind: 'dados_apps', items: chosenApp.map(i => i.id), title: 'Limpar cache de apps fechados',
            reason: 'Os apps recriam esses dados sozinhos. Conversas, logins e configurações ficam.',
          })
        : await addSuggestion({
            kind: 'limpeza_rapida', items: [], title: 'Limpeza rápida',
            reason: 'Temporários com mais de 7 dias e o cache de navegadores fechados. Esses dados se refazem sozinhos.',
          });
      setSugs(l => [s, ...l.filter(x => x.id !== s.id)]);
      setCreated(s.id);
      setTimeout(() => reviewRef.current?.focus(), 0);
    } catch (e) { setPrepError(e instanceof Error ? e.message : 'não deu para preparar agora'); }
    finally { setPreparing(null); }
  }

  const createdSug = created ? sugs.find(s => s.id === created) : undefined;
  const pending = sugs.filter(s => s.status === 'pendente' && s.id !== created);
  const tracking = scan ? scan.accessTracking : true;
  const sub = mac ? 'Pelo último uso que o Mac registra' : tracking ? 'Pelo último acesso registrado pelo Windows' : 'Pela data de modificação (o Windows não registra o acesso neste PC)';
  const cleanable = clean?.some(i => i.actionable && i.bytes > 0) ?? false;
  const th = (key: SortKey, label: string, cls = '') => (
    <th scope="col" className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="arq-sort" onClick={() => sortBy(key)}>
        {label}<span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</span>
      </button>
    </th>
  );

  return (
    <section className="arq" aria-labelledby={`${uid}-t`}>

      <div className="arq-body">
        <header className="arq-head">
          <h1 className="page-title" id={`${uid}-t`}>Arquivos que você não abre mais</h1>
          <p className="muted">{sub}. Nada é apagado sem a sua aprovação, e arquivos vão para a Lixeira.</p>
          <div className="arq-controls">
            <div className="arq-field">
              <label htmlFor={`${uid}-d`}>Não abertos há</label>
              <select id={`${uid}-d`} value={days} disabled={scanning} onChange={e => setDays(Number(e.target.value))}>
                {withValue(DAYS, days).map(d => <option key={d} value={d}>{dayLabel(d)}</option>)}
              </select>
            </div>
            <div className="arq-field">
              <label htmlFor={`${uid}-m`}>maiores que</label>
              <select id={`${uid}-m`} value={minMB} disabled={scanning} onChange={e => setMinMB(Number(e.target.value))}>
                {withValue(MBS, minMB).map(m => <option key={m} value={m}>{m}{NB}MB</option>)}
              </select>
            </div>
            <button type="button" className="pill" onClick={search} disabled={scanning} aria-busy={scanning}>
              {scanning ? 'procurando…' : 'Procurar'}
            </button>
            <p className="arq-result" role="status">
              {scanning ? (mac ? 'Olhando Downloads, Mesa, Documentos, Imagens, Filmes, Música…' : 'Olhando Downloads, Área de Trabalho, Documentos, Imagens, Vídeos e Músicas…')
                : scan ? `${plural(scan.files.length, 'arquivo', 'arquivos')}${scan.files.length >= 500 ? ' (os 500 maiores)' : ''} · ${sizeFine(scan.totalBytes)} · em ${nf1.format(scan.durationMs / 1000)}${NB}s${scan.truncated ? ' · parou no limite, pode haver mais' : ''}`
                : ''}
            </p>
          </div>
          {scanError && <p className="arq-error" role="alert">{scanError}</p>}
        </header>
        {createdSug && (
          <section className="arq-review" aria-labelledby={`${uid}-rv`} tabIndex={-1} ref={reviewRef}>
            <h2 className="arq-h" id={`${uid}-rv`}>
              {createdSug.status === 'pendente' ? 'Confira e aprove' : 'Resultado'}
              {createdSug.status !== 'pendente' && <button type="button" className="arq-link" onClick={() => setCreated(null)}>Fechar</button>}
            </h2>
            <SuggestionCard s={createdSug} />
          </section>
        )}

        <section aria-labelledby={`${uid}-tb`}>
          <h2 className="arq-h" id={`${uid}-tb`}>Parados há mais tempo</h2>
          {!scan ? (
            <p className="arq-empty">{scanning ? 'Procurando…' : 'Escolha o período e o tamanho e toque em Procurar.'}</p>
          ) : rows.length === 0 ? (
            <p className="arq-empty">Nenhum arquivo parado com esses filtros.</p>
          ) : (
            <div className="arq-scroll">
              <table className="arq-table">
                <thead>
                  <tr>
                    <th scope="col" className="arq-chk">
                      <input type="checkbox" ref={headRef} checked={allOn} onChange={toggleAll} aria-label="Selecionar todos" disabled={selectable.length === 0} />
                    </th>
                    {th('name', 'Nome')}
                    {th('folder', 'Pasta')}
                    {th('size', 'Tamanho', 'arq-num')}
                    {th('lastUsed', 'Último uso')}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(f => {
                    const done = isHandled(f);
                    return (
                      <tr key={f.path} data-on={sel.has(f.path) || undefined} data-done={done || undefined}>
                        <td className="arq-chk">
                          <input type="checkbox" checked={sel.has(f.path) && !done} disabled={done} onChange={() => toggle(f.path)} aria-label={`Selecionar ${f.name}`} />
                        </td>
                        <th scope="row" className="arq-name" title={f.name}>
                          <span>{f.name}</span>
                          {f.isApp && <span className="arq-tag">app</span>}
                          {done && <span className="arq-tag">enviado</span>}
                        </th>
                        <td className="arq-folder" title={folderOf(f.path)}>{folderOf(f.path)}</td>
                        <td className="arq-num">{sizeFine(f.size)}</td>
                        <td className="arq-when" title={`${dateFmt.format(f.lastUsed)} · ${BASIS[f.basis]}`}>{agoLong(Date.now() - f.lastUsed)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="arq-clean" aria-labelledby={`${uid}-da`}>
          <h2 className="arq-h" id={`${uid}-da`}>Dados dos apps</h2>
          <div className="arq-card">
            {apps === null && !appsError && <p className="arq-empty" role="status">Medindo os dados dos apps…</p>}
            {appsError && <p className="arq-empty">Não deu para medir agora. <button type="button" className="arq-link" onClick={loadApps}>Tentar de novo</button></p>}
            {apps && apps.entries.length === 0 && <p className="arq-empty">Nenhum app com dados grandes.</p>}
            {apps?.entries.map(e => (
              <div key={e.id} className="arq-app">
                <p className="arq-app-head"><strong>{e.name}</strong><span className="arq-cat-size">{sizeFine(e.bytes)}</span></p>
                <p className="arq-cat-note" title={e.where}>{e.where}</p>
                <ul className="arq-cats">
                  {e.items.map(i => (
                    <li key={i.id} data-info={!i.actionable || undefined}>
                      <span className="arq-cat-name">
                        {i.actionable && <input type="checkbox" className="arq-app-chk" checked={appSel.has(i.id)} disabled={i.bytes === 0} onChange={() => toggleApp(i.id)} aria-label={`Selecionar ${i.label}`} />}
                        {i.label}
                      </span>
                      <span className="arq-cat-size">{sizeFine(i.bytes)}</span>
                      <span className="arq-cat-note">{plural(i.files, 'arquivo', 'arquivos')}{i.note ? ` · ${i.note}` : ''}</span>
                    </li>
                  ))}
                  {e.notes.map(n => (
                    <li key={n.text} data-info>
                      <span className="arq-cat-name">{n.text}</span>
                      <span className="arq-cat-size">{sizeFine(n.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {apps?.truncated && <p className="arq-fine">Medição parcial: parou no limite, pode haver mais.</p>}
            <p className="arq-fine">
              {chosenApp.length === 0 ? 'Nenhum cache selecionado.' : `${plural(chosenApp.length, 'cache selecionado', 'caches selecionados')} · ${sizeFine(chosenAppBytes)}.`}
              {' '}Só apps fechados. Conversas, logins e configurações ficam. Apaga de vez, não vai para a Lixeira.
            </p>
            <button type="button" className="pill" onClick={() => prepare('dados')} disabled={chosenApp.length === 0 || preparing !== null} aria-busy={preparing === 'dados'}>
              {preparing === 'dados' ? 'preparando…' : 'Preparar limpeza'}
            </button>
          </div>
        </section>

        <section className="arq-clean" aria-labelledby={`${uid}-lr`}>
          <h2 className="arq-h" id={`${uid}-lr`}>Limpeza rápida</h2>
          <div className="arq-card">
            {clean === null && !cleanError && <p className="arq-empty" role="status">Medindo temporários e caches…</p>}
            {cleanError && <p className="arq-empty">Não deu para medir agora. <button type="button" className="arq-link" onClick={loadClean}>Tentar de novo</button></p>}
            {clean && (
              <ul className="arq-cats">
                {clean.map(i => (
                  <li key={i.category} data-info={!i.actionable || undefined}>
                    <span className="arq-cat-name">{i.label}</span>
                    <span className="arq-cat-size">{i.unknown ? '—' : sizeFine(i.bytes)}</span>
                    <span className="arq-cat-note">
                      {i.unknown ? '' : plural(i.files, 'arquivo', 'arquivos')}
                      {i.note ? `${i.unknown ? '' : ' · '}${i.note}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="arq-fine">Cookies e histórico ficam de fora, para você não sair dos sites. Estes dados são apagados de vez, não vão para a Lixeira.</p>
            <button type="button" className="pill" onClick={() => prepare('limpeza')} disabled={!cleanable || preparing !== null} aria-busy={preparing === 'limpeza'}>
              {preparing === 'limpeza' ? 'preparando…' : 'Preparar limpeza'}
            </button>
          </div>
        </section>

        <section aria-labelledby={`${uid}-sg`}>
          <h2 className="arq-h" id={`${uid}-sg`}>Sugestões{pending.length > 0 && <span className="arq-count">{pending.length}</span>}</h2>
          {pending.length === 0 ? (
            <p className="arq-empty">Nenhuma sugestão esperando. As do assistente e as que você preparar aparecem aqui.</p>
          ) : (
            <ul className="arq-sugs">
              {pending.map(s => <li key={s.id}><SuggestionCard s={s} /></li>)}
            </ul>
          )}
        </section>
      </div>

      <footer className="arq-foot">
        <p className="arq-sum" role="status">
          {chosen.length === 0 ? 'Nenhum arquivo selecionado' : `${plural(chosen.length, 'selecionado', 'selecionados')} · ${sizeFine(chosenBytes)}`}
          {prepError && <span className="arq-error" role="alert"> · {prepError}</span>}
        </p>
        <button type="button" className="pill" onClick={() => prepare('lixeira')} disabled={chosen.length === 0 || preparing !== null} aria-busy={preparing === 'lixeira'}>
          {preparing === 'lixeira' ? 'preparando…' : 'Preparar envio para a Lixeira'}
        </button>
      </footer>
    </section>
  );
}
