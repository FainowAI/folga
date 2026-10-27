import { useEffect, useId, useState } from 'react';
import type { AgentProvider, AppGroup, MemoryState, Settings as SettingsData } from '../../src/types';
import { getSettings, getStartup, putSettings, putStartup } from './api';

// Faixas iguais às do servidor (RANGES em src/server.ts). Ajuste lá e aqui juntos.
const FIELDS = {
  idleMinutes: { label: 'Considerar parado depois de', unit: 'min', min: 5, max: 600 },
  busyCpuPercent: { label: 'Ocupado a partir de', unit: '% de um núcleo', min: 1, max: 100 },
  sampleSeconds: { label: 'Ler a memória a cada', unit: 's', min: 1, max: 60 },
} as const;
type NumKey = keyof typeof FIELDS;
const NUM_KEYS = Object.keys(FIELDS) as NumKey[];

// Escolhas fixas dos campos novos (v2). O servidor valida a faixa: staleDays 7–3650, staleMinMB 1–100000.
type Option = { value: string; label: string };
const WARNING_LEVELS: Option[] = [{ value: 'todos', label: 'Todos' }, { value: 'criticos', label: 'Só críticos' }];
const STALE_DAYS: Option[] = [30, 90, 180, 365].map(n => ({ value: String(n), label: `${n} dias` }));
const STALE_MB: Option[] = [1, 10, 50, 100].map(n => ({ value: String(n), label: `${n} MB` }));
const PROVIDERS: Option[] = [{ value: 'claude', label: 'Claude' }, { value: 'gpt', label: 'GPT' }];

type Form = Record<NumKey, string> & {
  neverClose: string[]; mayForceQuit: string[];
  warningsLevel: SettingsData['warningsLevel']; staleDays: string; staleMinMB: string; agentProvider: AgentProvider;
  watchEnabled: boolean;
};
const toForm = (s: SettingsData): Form => ({
  idleMinutes: String(s.idleMinutes), busyCpuPercent: String(s.busyCpuPercent), sampleSeconds: String(s.sampleSeconds),
  neverClose: s.neverClose, mayForceQuit: s.mayForceQuit,
  warningsLevel: s.warningsLevel, staleDays: String(s.staleDays), staleMinMB: String(s.staleMinMB), agentProvider: s.agentProvider,
  watchEnabled: s.watchEnabled,
});

function numError(k: NumKey, raw: string): string | null {
  const { label, min, max } = FIELDS[k];
  const n = raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? null : `${label}: use um número entre ${min} e ${max}.`;
}

// Mesma normalização do servidor: minúsculas, sem .exe.
const normalize = (s: string) => s.trim().toLowerCase().replace(/\.exe$/, '');

function NumberField({ id, k, value, error, onChange, hint }: {
  id: string; k: NumKey; value: string; error: string | null; onChange: (v: string) => void; hint?: string;
}) {
  const f = FIELDS[k];
  const described = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="set-field">
      <label htmlFor={id}>{f.label}</label>
      <div className="set-num">
        <input id={id} type="number" inputMode="numeric" min={f.min} max={f.max} value={value}
          aria-invalid={error ? true : undefined} aria-describedby={described} onChange={(e) => onChange(e.target.value)} />
        <span className="set-unit">{f.unit}</span>
      </div>
      {hint && <p className="set-hint" id={`${id}-hint`}>{hint}</p>}
      {error && <p className="set-err" id={`${id}-err`}>{error}</p>}
    </div>
  );
}

function SelectField({ id, label, value, options, hint, onChange }: {
  id: string; label: string; value: string; options: Option[]; hint?: string; onChange: (v: string) => void;
}) {
  // um valor salvo fora das escolhas (ex.: 7 dias, definido por outro caminho) continua aparecendo
  const all = options.some(o => o.value === value) ? options : [...options, { value, label: value }];
  return (
    <div className="set-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)}>
        {all.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint && <p className="set-hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

function AppList({ title, warning, danger, items, apps, onChange }: {
  title: string; warning: string; danger?: boolean; items: string[]; apps: AppGroup[]; onChange: (next: string[]) => void;
}) {
  const id = useId();
  const [pick, setPick] = useState('');
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const nameOf = (key: string) => apps.find((a) => a.key === key)?.name ?? key;
  // Só apps que um usuário poderia mesmo marcar (sistema, o próprio Folga e outras sessões ficam de fora).
  const options = apps.filter((a) => !['system', 'self', 'other_session'].includes(a.reason) && !items.includes(normalize(a.key)));

  function add(raw: string, clear: () => void) {
    const key = normalize(raw);
    if (!key) return;
    if (key.length >= 128) return setProblem('Nome comprido demais.');
    if (items.includes(key)) return setProblem(`${nameOf(key)} já está na lista.`);
    if (items.length >= 200) return setProblem('A lista chegou a 200 nomes.');
    setProblem(null);
    onChange([...items, key]);
    clear();
  }

  return (
    <section className="set-list" aria-labelledby={`${id}-t`}>
      <h2 className="set-h" id={`${id}-t`}>{title}</h2>
      <p className={`set-hint${danger ? ' set-danger' : ''}`} id={`${id}-w`}>{warning}</p>

      {items.length > 0 ? (
        <ul className={`set-chips${danger ? ' set-chips-danger' : ''}`} aria-label={title}>
          {items.map((key) => (
            <li className="set-chip" key={key}>
              <span>{nameOf(key)}</span>
              <button type="button" aria-label={`Remover ${nameOf(key)}`} onClick={() => onChange(items.filter((k) => k !== key))}>×</button>
            </li>
          ))}
        </ul>
      ) : <p className="set-hint">Nenhum app na lista.</p>}

      <div className="set-add">
        <div className="set-add-col">
          <label htmlFor={`${id}-s`}>Escolher entre os apps abertos</label>
          <div className="set-add-row">
            <select id={`${id}-s`} value={pick} aria-describedby={`${id}-w`} onChange={(e) => setPick(e.target.value)}>
              <option value="">{options.length ? 'Escolher um app…' : 'Nenhum app disponível'}</option>
              {options.map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
            </select>
            <button type="button" className="set-btn" disabled={!pick} onClick={() => add(pick, () => setPick(''))}>Adicionar</button>
          </div>
        </div>
        <div className="set-add-col">
          <label htmlFor={`${id}-i`}>Ou digitar o nome do executável</label>
          <div className="set-add-row">
            <input id={`${id}-i`} type="text" value={typed} placeholder="ex.: slack.exe" autoComplete="off" spellCheck={false}
              aria-describedby={problem ? `${id}-p` : `${id}-w`}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(typed, () => setTyped('')); } }} />
            <button type="button" className="set-btn" disabled={!typed.trim()} onClick={() => add(typed, () => setTyped(''))}>Adicionar</button>
          </div>
        </div>
      </div>
      <p className="set-err" id={`${id}-p`} role="status">{problem}</p>
    </section>
  );
}

type Status = { ok: boolean; text: string } | null;

export function Settings({ state }: { state: MemoryState | null }) {
  const uid = useId();
  const [form, setForm] = useState<Form | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  // O formulário começa uma vez só (da API ou, se ela não responder, do estado ao vivo)
  // para as leituras a cada poucos segundos não apagarem o que a pessoa está digitando.
  useEffect(() => {
    let alive = true;
    getSettings().then((s) => { if (alive && s && Array.isArray(s.neverClose)) setForm((f) => f ?? toForm(s)); }).catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (state) setForm((f) => f ?? toForm(state.settings)); }, [state]);

  if (!form) {
    return (
      <section className="page">
        <h1 className="page-title">Ajustes</h1>
        {loadFailed
          ? <p className="muted" role="alert">Não deu para ler os ajustes agora.</p>
          : <p className="muted" role="status">Carregando…</p>}
      </section>
    );
  }

  const edit = (patch: Partial<Form>) => { setForm((f) => f && { ...f, ...patch }); setStatus(null); };
  const errors = Object.fromEntries(NUM_KEYS.map((k) => [k, numError(k, form[k])])) as Record<NumKey, string | null>;
  const apps = state?.apps ?? [];

  async function save() {
    if (!form) return;
    if (NUM_KEYS.some((k) => errors[k])) return setStatus({ ok: false, text: 'Corrija os campos marcados.' });
    setSaving(true);
    try {
      const saved = await putSettings({
        idleMinutes: Number(form.idleMinutes), busyCpuPercent: Number(form.busyCpuPercent), sampleSeconds: Number(form.sampleSeconds),
        neverClose: form.neverClose, mayForceQuit: form.mayForceQuit,
        warningsLevel: form.warningsLevel, staleDays: Number(form.staleDays), staleMinMB: Number(form.staleMinMB),
        agentProvider: form.agentProvider, watchEnabled: form.watchEnabled,
      });
      setForm(toForm(saved));   // mostra o que o servidor guardou (nomes já normalizados)
      setStatus({ ok: true, text: 'Salvo' });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof TypeError ? 'Sem conexão com o Folga.' : `Não salvou: ${e instanceof Error ? e.message : 'falhou'}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page set" aria-labelledby={`${uid}-title`}>
      <h1 className="page-title" id={`${uid}-title`}>Ajustes</h1>
      <p className="muted">Quando um app conta como parado, o que nunca deve ser fechado e como o Folga avisa.</p>

      <form className="set-form" noValidate onSubmit={(e) => { e.preventDefault(); if (!saving) void save(); }}>
        <div className="set-nums">
          <NumberField id={`${uid}-idle`} k="idleMinutes" value={form.idleMinutes} error={errors.idleMinutes} onChange={(v) => edit({ idleMinutes: v })} />
          <NumberField id={`${uid}-busy`} k="busyCpuPercent" value={form.busyCpuPercent} error={errors.busyCpuPercent} onChange={(v) => edit({ busyCpuPercent: v })} />
          <NumberField id={`${uid}-sample`} k="sampleSeconds" value={form.sampleSeconds} error={errors.sampleSeconds} onChange={(v) => edit({ sampleSeconds: v })}
            hint="vale depois de reiniciar o Folga" />
        </div>

        <section className="set-list" aria-labelledby={`${uid}-more`}>
          <h2 className="set-h" id={`${uid}-more`}>Avisos, arquivos e assistente</h2>
          <div className="set-nums set-selects">
            <SelectField id={`${uid}-wl`} label="Avisos no ícone" value={form.warningsLevel} options={WARNING_LEVELS}
              hint="Em “Só críticos”, os avisos de atenção ficam na tela Avisos, mas não aparecem no ícone da barra."
              onChange={(v) => edit({ warningsLevel: v === 'criticos' ? 'criticos' : 'todos' })} />
            <SelectField id={`${uid}-sd`} label="Arquivos parados há" value={form.staleDays} options={STALE_DAYS}
              onChange={(v) => edit({ staleDays: v })} />
            <SelectField id={`${uid}-sm`} label="Ignorar arquivos menores que" value={form.staleMinMB} options={STALE_MB}
              onChange={(v) => edit({ staleMinMB: v })} />
            <SelectField id={`${uid}-ap`} label="Assistente padrão" value={form.agentProvider} options={PROVIDERS}
              onChange={(v) => edit({ agentProvider: v === 'gpt' ? 'gpt' : 'claude' })} />
          </div>
          <label className="set-startup">
            <input type="checkbox" role="switch" checked={form.watchEnabled} onChange={(e) => edit({ watchEnabled: e.target.checked })} />
            <span>Propor sozinho o que dá para liberar e limpar, quando a memória subir ou o disco apertar.
              A proposta espera o seu OK: o Folga não faz nada antes disso.</span>
          </label>
        </section>

        <AppList title="Nunca fechar" items={form.neverClose} apps={apps} onChange={(next) => edit({ neverClose: next })}
          warning="Terminais, editores e apps de agente (Claude, Codex) vêm aqui por padrão: fechar um deles derruba os agentes e servidores que rodam dentro." />
        <AppList title="Pode encerrar de vez" danger items={form.mayForceQuit} apps={apps} onChange={(next) => edit({ mayForceQuit: next })}
          warning="Só vale para app que foi para a bandeja. Encerrar de vez pode perder trabalho não salvo." />

        <div className="set-foot">
          <button type="submit" className="pill pill-accent" disabled={saving} aria-busy={saving}>{saving ? 'Salvando…' : 'Salvar'}</button>
          <p className={`set-status${status && !status.ok ? ' set-status-bad' : ''}`} role="status" aria-live="polite">{status?.text}</p>
        </div>
      </form>

      <Startup />
    </section>
  );
}

/** P04: atalho na pasta Inicializar que sobe só o servidor no logon. Aplica na hora, fora do formulário. */
function Startup() {
  const [on, setOn] = useState<boolean | null>(null);
  const [available, setAvailable] = useState(true);
  const [problem, setProblem] = useState('');
  const mac = /Mac/.test(navigator.platform);
  useEffect(() => { getStartup().then(r => { setOn(r.on); setAvailable(r.available); }, () => setProblem('Não deu para ler este ajuste.')); }, []);
  const toggle = async (next: boolean) => {
    setProblem('');
    try { setOn((await putStartup(next)).on); }
    catch (e) { setProblem(e instanceof Error ? e.message : 'Não salvou.'); }
  };
  return (
    <section className="set-list" aria-labelledby="startup-t">
      <h2 className="set-h" id="startup-t">{mac ? 'Abrir com o Mac' : 'Abrir com o Windows'}</h2>
      <label className="set-startup">
        <input type="checkbox" role="switch" checked={on ?? false} disabled={on === null || (!available && !on)}
          onChange={e => void toggle(e.target.checked)} />
        {/* ligado e indisponível (aberto fora do app): ainda dá para desligar, nunca fica preso */}
        <span>{!available ? 'Disponível pelo app Folga.'
          : mac ? 'Abrir o Folga quando você entrar no Mac. Só o ícone aparece na barra de menus; o Auto Care passa a valer o dia todo.'
          : 'Abrir o Folga quando você entrar no Windows. O Auto Care passa a valer o dia todo, com a janela aberta ou fechada.'}</span>
      </label>
      <p className="set-err" role="status">{problem}</p>
    </section>
  );
}
