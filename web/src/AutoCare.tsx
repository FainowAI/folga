import { useEffect, useState } from 'react';
import type { MemoryState } from '../../src/types';
import { putSettings } from './api';
import { NB, ago as since, autoCareAt } from './format';

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const ago = (ms: number) => `há ${since(ms)}`;

export function AutoCare({ state }: { state: MemoryState | null }) {
  const threshold = state?.settings.autoCareThreshold;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // acompanha o valor salvo (inclusive mudanças feitas em Ajustes)
  useEffect(() => { if (threshold !== undefined) setDraft(String(threshold)); }, [threshold]);

  if (!state) {
    return <section className="page"><h1 className="page-title">Auto Care</h1><p className="muted" role="status">Lendo…</p></section>;
  }
  const { settings, autoCare, t } = state;
  const pressure = settings.autoCareTrigger === 'pressure';

  async function save(patch: Parameters<typeof putSettings>[0]) {
    setSaving(true);
    setError('');
    try { await putSettings(patch); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não deu para salvar.'); setDraft(String(settings.autoCareThreshold)); }
    finally { setSaving(false); }
  }

  function commitThreshold() {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isInteger(n) || n < 50 || n > 99) {
      setError('Use um número inteiro de 50 a 99.');
      return;
    }
    if (n !== settings.autoCareThreshold) void save({ autoCareThreshold: n });
    else setError('');
  }

  return (
    <section className="page ac" aria-labelledby="ac-title">
      <h1 className="page-title" id="ac-title">Auto Care</h1>
      <p className="muted">Roda enquanto o Folga estiver ligado, mesmo com a janela fechada. Cada execução vai para o Registro.</p>

      <div className="ac-card">
        <div className="ac-row">
          <span className="ac-dot" aria-hidden="true" />
          <div className="ac-text">
            <label className="ac-name" htmlFor="ac-switch">Memória</label>
            <span className="ac-hint" id="ac-hint">{autoCareAt(settings).replace(/^./, (c) => c.toUpperCase())}</span>
          </div>
          <input id="ac-switch" className="ac-switch" type="checkbox" role="switch" aria-describedby="ac-hint"
            checked={settings.autoCareEnabled} disabled={saving}
            onChange={(e) => void save({ autoCareEnabled: e.target.checked })} />
        </div>

        {/* gatilho por pressão só existe com a sonda do Mac (o servidor recusa no Windows) */}
        {(state.memPressure !== undefined || pressure) && (
          <div className="ac-row ac-field">
            <label className="ac-name" htmlFor="ac-trigger">Começa pela</label>
            <select id="ac-trigger" className="ac-input ac-select" value={settings.autoCareTrigger} disabled={saving}
              onChange={(e) => void save({ autoCareTrigger: e.target.value as typeof settings.autoCareTrigger })}>
              <option value="percent">Percentual</option>
              <option value="pressure">Pressão de memória</option>
            </select>
          </div>
        )}

        {pressure ? (
          <div className="ac-row ac-field">
            <label className="ac-name" htmlFor="ac-pressure">Começa quando a pressão ficar</label>
            <select id="ac-pressure" className="ac-input ac-select" value={settings.autoCarePressure} disabled={saving}
              onChange={(e) => void save({ autoCarePressure: e.target.value as typeof settings.autoCarePressure })}>
              <option value="warn">Amarela</option>
              <option value="critical">Vermelha</option>
            </select>
          </div>
        ) : (
        <div className="ac-row ac-field">
          <label className="ac-name" htmlFor="ac-threshold">Começa quando a memória chegar a (%)</label>
          <input id="ac-threshold" className="ac-input" type="number" inputMode="numeric" min={50} max={99} step={1}
            value={draft} disabled={saving} aria-invalid={error !== ''} aria-describedby="ac-error"
            onChange={(e) => setDraft(e.target.value)} onBlur={commitThreshold}
            onKeyDown={(e) => { if (e.key === 'Enter') commitThreshold(); }} />
        </div>
        )}

        <p className="ac-error" id="ac-error" role="alert" aria-live="assertive">{error}</p>
      </div>

      <ul className="ac-status">
        <li>{autoCare.lastRunAt ? `Última execução: ${ago(t - autoCare.lastRunAt)}` : 'Ainda não rodou.'}</li>
        {autoCare.nextEligibleAt !== null && autoCare.nextEligibleAt > t && (
          <li>Pode rodar de novo em {minutes(autoCare.nextEligibleAt - t)}{NB}min</li>
        )}
      </ul>
    </section>
  );
}
