// Assistente (F-18, D14): conversa com o Claude ou o GPT pelas assinaturas. O agente só lê e propõe;
// cada sugestão vira um cartão que o usuário aprova (R20–R24). Fica montada mesmo escondida (App.tsx).
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentProvider, ChatMessage, MemoryState, Suggestion, View } from '../../src/types';
import { getConversation, getSuggestions, onEvent, resetAgent, sendToAgent, stopAgent } from './api';
import { SuggestionCard } from './SuggestionCard';
import './styles/assistente.css';

const NAMES: Record<AgentProvider, string> = { claude: 'Claude', gpt: 'GPT' };
const TOOL_TEXT: Record<string, string> = {
  ver_memoria: 'consultou: memória',
  ver_avisos: 'consultou: avisos',
  ver_disco: 'consultou: disco',
  procurar_arquivos_parados: 'procurou arquivos parados',
  ver_limpeza_rapida: 'consultou: limpeza rápida',
  ver_dados_dos_apps: 'consultou: dados dos apps',
  ver_inicializacao: 'consultou: inicialização',
  ver_sugestoes: 'consultou: sugestões',
  ver_registro: 'consultou: registro',
};
const toolText = (t: string) => TOOL_TEXT[t] ?? `consultou: ${t.replace(/^ver_/, '').replaceAll('_', ' ')}`;
const QUICK = [
  'Quais arquivos eu não abro há meses?',
  'O que está pesando na memória agora?',
  'Tem algum aviso importante?',
  'Sugira uma limpeza segura',
];

// ---- markdown simples, sem innerHTML: o React escapa todo texto do modelo ----
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((p, i) => {
    if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.length > 2 && p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}
const ITEM = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/;

function Markdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) code.push(lines[i]!);
      i++;
      out.push(<pre key={out.length}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const first = ITEM.exec(line);
    if (first) {
      const ordered = first[2] !== undefined;
      const items: ReactNode[] = [];
      for (let m: RegExpExecArray | null = first; m; m = i < lines.length ? ITEM.exec(lines[i]!) : null) {
        items.push(<li key={items.length}>{inline(m[3]!)}</li>);
        i++;
      }
      out.push(ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) { out.push(<p key={out.length}><strong>{inline(line.replace(/^#{1,6}\s+/, ''))}</strong></p>); i++; continue; }
    const par: ReactNode[] = [];
    for (; i < lines.length && lines[i]!.trim() && !ITEM.test(lines[i]!) && !lines[i]!.trimStart().startsWith('```'); i++) {
      if (par.length) par.push(<br key={`b${i}`} />);
      par.push(<Fragment key={i}>{inline(lines[i]!)}</Fragment>);
    }
    out.push(<p key={out.length}>{par}</p>);
  }
  return <div className="as-md">{out}</div>;
}

type Live = { tools: string[]; text: string };

export function Assistente({ state, ask }: {
  state: MemoryState | null; go: (v: View, prompt?: string) => void; ask?: { text: string; n: number } | null;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [convProvider, setConvProvider] = useState<AgentProvider | null>(null);
  const [provider, setProvider] = useState<AgentProvider>(state?.settings.agentProvider ?? 'claude');
  const picked = useRef(false);
  const [live, setLive] = useState<Live | null>(null);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // o padrão é o ajuste do app, até o usuário escolher ou já existir uma conversa
  const settingsProvider = state?.settings.agentProvider;
  useEffect(() => { if (!picked.current && settingsProvider) setProvider(settingsProvider); }, [settingsProvider]);

  const sync = useCallback(async () => {
    try {
      const c = await getConversation();
      setMessages(c.messages);
      setBusy(c.busy);
      setConvProvider(c.messages.length ? c.provider : null);
      if (c.messages.length) { picked.current = true; setProvider(c.provider); }
      if (!c.busy) setLive(null);
    } catch { /* o servidor reconecta sozinho; a próxima ação tenta de novo */ }
  }, []);

  useEffect(() => {
    void sync();
    getSuggestions().then(setSugs).catch(() => {});
    const offS = onEvent('suggestions', setSugs);
    const offA = onEvent('agent', ev => {
      if (ev.type === 'start') { setBusy(true); setLive(l => l ?? { tools: [], text: '' }); void sync(); }
      else if (ev.type === 'tool') setLive(l => ({ text: l?.text ?? '', tools: l?.tools.includes(ev.tool) ? l.tools : [...(l?.tools ?? []), ev.tool] }));
      else if (ev.type === 'text') setLive(l => ({ tools: l?.tools ?? [], text: ev.text }));
      else { void sync(); getSuggestions().then(setSugs).catch(() => {}); }   // done ou error: a verdade está no servidor
    });
    return () => { offS(); offA(); };
  }, [sync]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  // "Resolver" em Início: manda o pedido sozinho. Se já houver um turno rodando, deixa escrito para o usuário enviar.
  const asked = useRef(0);
  useEffect(() => {
    if (!ask || ask.n === asked.current) return;
    asked.current = ask.n;
    if (busy) setInput(ask.text);
    else void send(ask.text);
  }, [ask, busy]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setErr(null);
    setInput('');
    const tmp: ChatMessage = { id: `tmp-${Date.now()}`, role: 'user', text: t, t: Date.now() };
    setMessages(m => (convProvider && convProvider !== provider ? [tmp] : [...m, tmp]));
    setBusy(true);
    setLive({ tools: [], text: '' });
    try {
      await sendToAgent(provider, t);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'não consegui enviar');
      setInput(t);
      setBusy(false);
      setLive(null);
      void sync();
    }
  }

  async function reset() {
    try { const c = await resetAgent(); setMessages(c.messages); setBusy(false); setLive(null); setConvProvider(null); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'não consegui reiniciar'); }
  }

  const choose = (p: AgentProvider) => { picked.current = true; setProvider(p); };
  const byId = new Map(sugs.map(s => [s.id, s]));
  const switching = convProvider !== null && convProvider !== provider && messages.length > 0;

  return (
    <section className="as" aria-labelledby="as-title">
      <header className="as-head">
        <div>
          <h1 className="page-title" id="as-title">Assistente</h1>
          <div className="as-who">
            <div className="as-seg" role="radiogroup" aria-label="Quem responde">
              {(['claude', 'gpt'] as const).map(p => (
                <button key={p} type="button" role="radio" aria-checked={provider === p} disabled={busy} onClick={() => choose(p)}>{NAMES[p]}</button>
              ))}
            </div>
            <span className="muted as-legend">{switching ? 'Trocar de assistente começa uma conversa nova.' : 'pela sua assinatura'}</span>
          </div>
        </div>
        <button type="button" className="as-ghost" onClick={reset} disabled={!messages.length && !busy}>Nova conversa</button>
      </header>

      <div className="as-list" ref={listRef} role="log" aria-label="Conversa com o assistente" aria-live="polite" aria-relevant="additions text">
        {!messages.length && !busy && (
          <div className="as-empty">
            <p className="muted">Pergunte sobre memória, arquivos parados, limpeza ou avisos. Eu só olho e sugiro; quem aprova é você.</p>
            <div className="as-quick">
              {QUICK.map(q => <button key={q} type="button" className="as-chip-btn" onClick={() => void send(q)}>{q}</button>)}
            </div>
          </div>
        )}

        {messages.map(m => m.role === 'user' ? (
          <div key={m.id} className="as-user"><p>{m.text}</p></div>
        ) : (
          <article key={m.id} className="as-bot" data-error={m.error || undefined}>
            <span className="as-name">{m.provider ? NAMES[m.provider] : 'Assistente'}</span>
            {m.error ? <p className="as-error">{m.text}</p> : <Markdown text={m.text} />}
            {!!m.tools?.length && <p className="as-used">{m.tools.map(toolText).join(' · ')}</p>}
            {m.suggestionIds?.map(id => { const s = byId.get(id); return s ? <SuggestionCard key={id} s={s} /> : null; })}
            {m.rejected?.map((r, i) => <p key={i} className="as-rejected">Não virou cartão: {r}</p>)}
          </article>
        ))}

        {busy && (
          <div className="as-bot as-live">
            <span className="as-name">{NAMES[provider]}</span>
            <div className="as-tools">
              {live?.tools.map(t => <span key={t} className="as-tool">{toolText(t)}</span>)}
              <span className="as-thinking">pensando…</span>
            </div>
            {live?.text && <p className="as-draft">{live.text.trim()}</p>}
          </div>
        )}
      </div>

      <footer className="as-foot">
        <p className="set-err" role="alert">{err}</p>
        <form className="as-compose" onSubmit={e => { e.preventDefault(); void send(input); }}>
          <label className="as-sr" htmlFor="as-input">Mensagem para o assistente</label>
          <textarea
            id="as-input" rows={2} maxLength={4000} value={input} placeholder="Escreva aqui. Enter envia, Shift+Enter quebra a linha."
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }}
          />
          {busy
            ? <button type="button" className="as-stop" onClick={() => void stopAgent().catch(() => {})}>Parar</button>
            : <button type="submit" className="pill" disabled={!input.trim()}>Enviar</button>}
        </form>
      </footer>
    </section>
  );
}
