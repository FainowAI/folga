// Cartão de sugestão (R20, R23): mostra a lista REAL de itens que o servidor montou e só executa no clique em "Aprovar".
// Usado nas telas Início, Arquivos e Assistente.
import { useState } from 'react';
import type { Suggestion } from '../../src/types';
import { approveSuggestion, ignoreSuggestion } from './api';
import { MB, NB, nf0, plural, size } from './format';
import './styles/sugestoes.css';

// B3: bidi (U+202A–202E, U+2066–2069) esconde o fim do nome de um arquivo; sai de tudo que o cartão mostra
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
const clean = (s: string) => s.replace(BIDI, '');

/** Como `size`, mas sem "0 MB" para arquivos pequenos. */
export const sizeFine = (b: number) =>
  b >= MB ? size(b) : b >= 1024 ? `${nf0.format(b / 1024)}${NB}KB` : `${nf0.format(Math.max(0, b))}${NB}B`;

const WHAT: Record<Suggestion['kind'], { noun: [string, string]; promise: string }> = {
  lixeira: { noun: ['arquivo', 'arquivos'], promise: 'Vai para a Lixeira: dá para restaurar.' },
  limpeza_rapida: { noun: ['categoria', 'categorias'], promise: 'Apaga de vez: não vai para a Lixeira.' },
  dados_apps: { noun: ['cache', 'caches'], promise: 'Apaga de vez: o app recria sozinho.' },
  liberar_memoria: { noun: ['app', 'apps'], promise: 'Fecha do jeito normal; um app pode pedir para salvar.' },
};
const STATUS: Record<Exclude<Suggestion['status'], 'pendente'>, { text: string; tone: string }> = {
  feita: { text: 'Feita', tone: 'ok' },
  falhou: { text: 'Não foi feita', tone: 'bad' },
  ignorada: { text: 'Ignorada', tone: 'quiet' },
};

export function SuggestionCard({ s, compact = false }: { s: Suggestion; compact?: boolean }) {
  const [local, setLocal] = useState<Suggestion | null>(null);   // resposta do servidor, até o evento 'suggestions' chegar
  const [busy, setBusy] = useState<'aprovar' | 'ignorar' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const cur = s.status === 'pendente' && local?.id === s.id ? local : s;
  const what = WHAT[cur.kind];
  const pending = cur.status === 'pendente';
  const titleId = `sug-${cur.id}`;

  async function decide(action: 'aprovar' | 'ignorar') {
    setBusy(action); setError('');
    try { setLocal(await (action === 'aprovar' ? approveSuggestion : ignoreSuggestion)(cur.id)); }
    catch (e) { setError(e instanceof Error ? e.message : 'não deu certo'); }
    finally { setBusy(null); setConfirm(false); }
  }
  const approve = () => ((cur.kind === 'limpeza_rapida' || cur.kind === 'dados_apps') && !confirm ? setConfirm(true) : decide('aprovar'));

  return (
    <article className="sug-card" data-compact={compact || undefined} data-status={cur.status} aria-labelledby={titleId}>
      <header className="sug-head">
        <span className="sug-origin" data-source={cur.source}>{cur.source === 'agente' ? 'do assistente' : 'do Folga'}</span>
        <h3 id={titleId} className="sug-title">{clean(cur.title)}</h3>
      </header>
      {cur.reason && <p className="sug-reason">{clean(cur.reason)}</p>}

      {!compact && (
        <ul className="sug-items" aria-label="O que vai acontecer">
          {cur.items.map(i => (
            <li key={i.id} className="sug-item" title={clean(cur.kind === 'lixeira' ? i.id : i.detail)}>
              <span className="sug-item-name">{clean(i.label)}</span>
              <span className="sug-item-size">{sizeFine(i.bytes)}</span>
              <span className="sug-item-detail">{clean(i.detail)}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="sug-total">
        <strong>{plural(cur.items.length, what.noun[0], what.noun[1])}</strong> · {sizeFine(cur.bytes)}
        {compact && <span className="sug-promise"> · {what.promise}</span>}
      </p>
      {!compact && <p className="sug-promise">{what.promise}</p>}

      {pending ? (
        confirm ? (
          <div className="sug-confirm" role="group" aria-label="Confirmar apagar de vez">
            <p><strong>Apagar de vez?</strong> Isso não vai para a Lixeira.</p>
            <div className="sug-actions">
              <button type="button" className="pill sug-danger" onClick={() => decide('aprovar')} disabled={busy !== null} aria-busy={busy === 'aprovar'}>
                {busy === 'aprovar' ? 'apagando…' : 'Sim, apagar'}
              </button>
              <button type="button" className="sug-link" onClick={() => setConfirm(false)} disabled={busy !== null}>Voltar</button>
            </div>
          </div>
        ) : (
          <div className="sug-actions">
            <button type="button" className="pill" onClick={approve} disabled={busy !== null} aria-busy={busy === 'aprovar'}>
              {busy === 'aprovar' ? 'fazendo…' : 'Aprovar'}
            </button>
            <button type="button" className="sug-link" onClick={() => decide('ignorar')} disabled={busy !== null}>Ignorar</button>
          </div>
        )
      ) : (
        <p className="sug-status" role="status" data-tone={STATUS[cur.status as keyof typeof STATUS].tone}>
          <strong>{STATUS[cur.status as keyof typeof STATUS].text}</strong>
          {cur.result ? ` · ${cur.result}` : ''}
        </p>
      )}
      {error && <p className="sug-error" role="alert">{error}</p>}
    </article>
  );
}
