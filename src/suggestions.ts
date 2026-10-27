// F-17: sugestões propostas pelo agente ou pela tela e aprovadas pelo usuário (R20–R24, D19).
// O que o modelo manda é só um pedido: os itens são MONTADOS aqui a partir do disco e do estado (R23), e na
// aprovação tudo é revalidado de novo (R21). Quem executa é sempre approve(), que só roda com o clique do usuário.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathKey, type Files } from './files.ts';
import type { ReleaseError } from './release.ts';
import type { createAppData } from './appdata.ts';
import type {
  AppReason, Emit, MemoryState, QuickCleanCategory, ReleaseResponse, Suggestion, SuggestionDraft, SuggestionItem, SuggestionKind,
} from './types.ts';

export type SuggestionsDeps = {
  dataDir: string;
  files: Files;
  getState: () => MemoryState | null;
  release: (keys: string[]) => Promise<ReleaseResponse | ReleaseError>;
  emit: Emit;
  appData?: Pick<ReturnType<typeof createAppData>, 'preview' | 'clean'>;
  now?: () => number;   // só para testes
};
export type SuggestionError = { erro: string; status: number };

const KEEP = 100;
const MAX_FILES = 500;
const MAX_APPS = 100;
const KINDS: readonly SuggestionKind[] = ['lixeira', 'limpeza_rapida', 'liberar_memoria', 'dados_apps'];
const DAY = 86_400_000;
const TTL = 3_600_000;   // M5: cartão pendente vale 1 h
/** Motivo gravado em quem expirou. O vigia usa para saber que ninguém disse "não" (R30). */
export const EXPIRED = 'expirou depois de 1 h; peça de novo';
// bidi (U+202A–202E, U+2066–2069) esconde o fim do nome do arquivo; fora de título e motivo
const BAD_TITLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const BAD_REASON = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

const err = (erro: string, status = 400): SuggestionError => ({ erro, status });
const plural = (n: number, one: string, many: string) => `${nf0.format(n)} ${n === 1 ? one : many}`;
export function size(b: number) {
  if (b >= 1024 ** 3) return `${nf1.format(b / 1024 ** 3)} GB`;
  if (b >= 1024 ** 2) return `${nf0.format(b / 1024 ** 2)} MB`;
  if (b >= 1024) return `${nf0.format(b / 1024)} KB`;
  return `${nf0.format(b)} B`;
}
function since(ms: number) {
  const d = Math.floor(Math.max(0, ms) / DAY);
  if (d < 1) return 'menos de 1 dia';
  if (d < 60) return plural(d, 'dia', 'dias');
  if (d < 730) return plural(Math.floor(d / 30), 'mês', 'meses');
  return plural(Math.floor(d / 365), 'ano', 'anos');
}
const REASON: Record<AppReason, string> = {
  foreground: 'em primeiro plano agora', audio: 'tocando áudio', busy: 'usando o processador', recent: 'usado há pouco',
  multi_window: 'navegador com várias janelas: fechar faria ele reabrir só a última', idle: 'parado, sem uso recente', no_window: 'sem janela aberta', system: 'do sistema', never_close: 'marcado para nunca fechar',
  self: 'é o próprio Folga', other_session: 'de outra sessão do Windows',
};
// pasta do arquivo sem depender de path.dirname em caminhos com barra mista
const folderOf = (p: string) => dirname(p);

export function createSuggestions(deps: SuggestionsDeps) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, 'suggestions.json');
  let items: Suggestion[] = [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (Array.isArray(raw)) items = (raw as Suggestion[]).filter(s => s && typeof s.id === 'string').slice(0, KEEP);
  } catch { /* primeira execução ou arquivo ilegível: começa vazio */ }

  // gravação atômica (.tmp + rename), uma por vez
  let writing: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    const body = JSON.stringify(items);
    writing = writing.then(async () => {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, file);
    }).catch(() => {});
    return writing;
  }
  const publish = () => deps.emit('suggestions', list());
  const running = new Set<string>();
  const isExpired = (s: Suggestion) => s.status === 'pendente' && !running.has(s.id) && now() - s.t > TTL;
  /** Marca como ignorada o que passou de 1 h pendente. Devolve se mudou algo (quem chama grava). */
  function expire(): boolean {
    let changed = false;
    for (const s of items) if (isExpired(s)) { s.status = 'ignorada'; s.result = EXPIRED; s.doneAt = now(); changed = true; }
    return changed;
  }
  function list(): Suggestion[] {
    if (expire()) void persist();
    return items.map(s => ({ ...s }));
  }

  // ---------- montagem dos itens (R21, R23) ----------
  async function buildFiles(paths: string[]): Promise<SuggestionItem[] | SuggestionError> {
    if (paths.length === 0) return err('nenhum arquivo na sugestão');
    if (paths.length > MAX_FILES) return err(`são arquivos demais (o máximo é ${MAX_FILES})`);
    const scan = deps.files.last();   // M5: só vale o que a última busca de arquivos parados achou
    if (!scan) return err('faça uma busca de arquivos parados antes');
    const found = new Set(scan.files.map(f => pathKey(f.path)));
    const checked = await deps.files.inspect(paths);
    const out: SuggestionItem[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < checked.length; i++) {
      const c = checked[i]!;
      // um item inválido recusa a sugestão inteira (R21); a mensagem não repete o caminho (R17)
      if ('erro' in c) return err(`o item ${i + 1} foi recusado: ${c.erro}`);
      const key = pathKey(c.path);
      if (!found.has(key)) return err(`o item ${i + 1} foi recusado: não está na última busca de arquivos parados`);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: c.path, label: basename(c.path),
        detail: `${folderOf(c.path)} · último uso há ${since(now() - c.lastUsed)}`, bytes: c.size, lastUsed: c.lastUsed,
      });
    }
    return out;
  }
  function buildApps(keys: string[], source: Suggestion['source']): SuggestionItem[] | SuggestionError {
    if (keys.length === 0) return err('nenhum app na sugestão');
    if (keys.length > MAX_APPS) return err('são apps demais');
    const state = deps.getState();
    if (!state) return err('ainda lendo a memória', 503);
    const out: SuggestionItem[] = [];
    for (const key of new Set(keys)) {
      const a = state.apps.find(x => x.key === key);
      if (!a) return err('um dos apps não está aberto');
      if (a.state === 'protected') return err(`${a.name} é protegido e não pode ser fechado`);
      // B2: proposta de máquina (assistente, vigia) só vale para app parado, e isso é conferido de novo no
      // clique: um cartão de meia hora atrás não pode fechar o que voltou a ser usado. Na tela, quem escolhe
      // é o usuário olhando a lista ao vivo, então ali qualquer não protegido vale.
      if (source !== 'folga' && a.state !== 'idle') return err(`${a.name} não está parado agora`);
      out.push({ id: a.key, label: a.name, detail: REASON[a.reason] ?? a.reason, bytes: a.privateWorkingSet });
    }
    return out;
  }
  async function buildClean(): Promise<SuggestionItem[] | SuggestionError> {
    const out: SuggestionItem[] = [];
    for (const c of await deps.files.quickCleanPreview()) {
      if (!c.actionable || c.bytes <= 0 && c.files <= 0) continue;
      out.push({ id: c.category, label: c.label, detail: `${plural(c.files, 'arquivo', 'arquivos')}${c.note ? ` · ${c.note}` : ''}`, bytes: c.bytes });
    }
    return out.length ? out : err('não há nada para limpar agora', 409);
  }

  /** Dados dos apps: cada id tem de ser item ACIONÁVEL do preview do servidor (allowlist recalculada das regras). */
  async function buildAppData(ids: string[]): Promise<SuggestionItem[] | SuggestionError> {
    if (ids.length === 0) return err('nenhum cache na sugestão');
    if (ids.length > MAX_APPS) return err('são caches demais');
    if (!deps.appData) return err('dados dos apps indisponível', 503);
    const scan = await deps.appData.preview();
    const byId = new Map(scan.entries.flatMap(e => e.items).map(i => [i.id, i]));
    const out: SuggestionItem[] = [];
    const seen = new Set<string>();
    for (let n = 0; n < ids.length; n++) {
      const it = byId.get(ids[n]!);
      // a mensagem não repete o id pedido (R17)
      if (!it) return err(`o item ${n + 1} foi recusado: não é um cache que o Folga limpa`);
      if (!it.actionable) return err(`o item ${n + 1} foi recusado: ${it.note ?? 'não pode ser limpo agora'}`);
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({ id: it.id, label: it.label, detail: `${it.path} · ${plural(it.files, 'arquivo', 'arquivos')}`, bytes: it.bytes });
    }
    return out;
  }

  // ---------- add ----------
  async function add(draft: SuggestionDraft, source: Suggestion['source']): Promise<Suggestion | SuggestionError> {
    const d = draft as Partial<SuggestionDraft> | null;
    if (!d || typeof d !== 'object') return err('pedido inválido');
    if (!KINDS.includes(d.kind as SuggestionKind)) return err('tipo de sugestão inválido');
    const kind = d.kind as SuggestionKind;
    const title = typeof d.title === 'string' ? d.title.trim() : '';
    const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
    if (!title || title.length > 120) return err('o título precisa ter de 1 a 120 caracteres');
    if (reason.length > 500) return err('o motivo pode ter no máximo 500 caracteres');
    // sem caracteres de controle (no motivo só se admite quebra de linha e tabulação)
    if (BAD_TITLE.test(title) || BAD_REASON.test(reason)) return err('o texto tem caracteres inválidos');
    if (kind !== 'limpeza_rapida' && (!Array.isArray(d.items) || d.items.some(x => typeof x !== 'string'))) return err('a lista de itens é inválida');
    const given = (kind === 'limpeza_rapida' ? [] : d.items) as string[];
    // decisão 11: tela e assistente propõem; o vigia não propõe apagar dados de app
    if (kind === 'dados_apps' && source === 'vigia') return err('o vigia não propõe limpeza de dados dos apps');

    const built = kind === 'lixeira' ? await buildFiles(given) : kind === 'liberar_memoria' ? buildApps(given, source)
      : kind === 'dados_apps' ? await buildAppData(given) : await buildClean();
    if (!Array.isArray(built)) return built;

    const s: Suggestion = {
      id: randomUUID(), t: now(), source, kind, title, reason, items: built,
      bytes: built.reduce((a, i) => a + i.bytes, 0), status: 'pendente',
    };
    items = [s, ...items].slice(0, KEEP);
    await persist();
    publish();
    return { ...s };
  }

  // ---------- approve ----------
  async function approve(id: string): Promise<Suggestion | SuggestionError> {
    const s = items.find(x => x.id === id);
    if (!s) return err('sugestão não encontrada', 404);
    if (isExpired(s)) { expire(); await persist(); publish(); return err(`essa sugestão ${EXPIRED}`, 409); }
    if (s.status !== 'pendente' || running.has(id)) return err('essa sugestão já foi decidida', 409);
    running.add(id);
    try {
      let status: 'feita' | 'falhou';
      let result: string;
      try {
        ({ status, result } = s.kind === 'lixeira' ? await runFiles(s) : s.kind === 'liberar_memoria' ? await runApps(s)
          : s.kind === 'dados_apps' ? await runAppData(s) : await runClean(s));
      } catch {
        status = 'falhou'; result = 'Algo deu errado e nada foi feito.';   // sem detalhe interno (R17)
      }
      s.status = status; s.result = result; s.doneAt = now();
      await persist();
      publish();
      return { ...s };
    } finally { running.delete(id); }
  }
  type Outcome = { status: 'feita' | 'falhou'; result: string };

  async function runFiles(s: Suggestion): Promise<Outcome> {
    // R21: tudo de novo pelo disco; um item que mudou recusa a sugestão inteira e nada é enviado
    const checked = await deps.files.inspect(s.items.map(i => i.id));
    const bad = checked.findIndex(c => 'erro' in c);
    if (bad !== -1) {
      const why = (checked[bad] as { erro: string }).erro;
      return { status: 'falhou', result: `Nada foi enviado: o item ${bad + 1} mudou desde a sugestão (${why}).` };
    }
    const good = checked as Array<{ path: string; size: number; lastUsed: number }>;
    // M5: arquivo que mudou de tamanho ou foi usado depois da sugestão não vai (sem caminho na mensagem: só o nome)
    const changed = s.items.findIndex((it, i) => good[i]!.size !== it.bytes || good[i]!.lastUsed > (it.lastUsed ?? -Infinity));
    if (changed !== -1) return { status: 'falhou', result: `Nada foi enviado: o arquivo ${s.items[changed]!.label} foi usado ou mudou depois da sugestão.` };
    const r = await deps.files.recycle(good.map(g => g.path));
    const okSet = new Set(r.ok.map(p => pathKey(p)));
    const moved = good.filter(g => okSet.has(pathKey(g.path)));
    const bytes = moved.reduce((a, g) => a + g.size, 0);
    const parts: string[] = [];
    if (moved.length) {
      // M4: o disco diz o que saiu da pasta; a Lixeira diz quantos de fato entraram
      const gone = plural(moved.length, 'arquivo', 'arquivos');
      if (r.inTrash === null) parts.push(`${gone} saíram da pasta · ${size(bytes)} (não deu para conferir a Lixeira)`);
      else if (r.inTrash >= moved.length) parts.push(`${gone} na Lixeira · ${size(bytes)}`);
      else parts.push(`${plural(moved.length, 'arquivo saiu', 'arquivos saíram')} da pasta; só ${nf0.format(r.inTrash)} ${r.inTrash === 1 ? 'apareceu' : 'apareceram'} na Lixeira (${process.platform === 'darwin' ? 'o macOS não confirmou os outros' : 'o Windows pode ter pedido para apagar de vez'})`);
    }
    if (r.failed.length) parts.push(`${plural(r.failed.length, 'arquivo não pôde', 'arquivos não puderam')} ir para a Lixeira`);
    return { status: moved.length ? 'feita' : 'falhou', result: parts.join('. ') };
  }

  async function runApps(s: Suggestion): Promise<Outcome> {
    const keys = s.items.map(i => i.id);
    const check = buildApps(keys, s.source);   // candidato agora? (R09, R21)
    if (!Array.isArray(check)) return { status: 'falhou', result: `Nada foi fechado: ${check.erro}.` };
    const r = await deps.release(keys);
    if ('erro' in r) return { status: 'falhou', result: `Nada foi fechado: ${r.erro}.` };
    const closed = r.results.filter(x => x.outcome === 'fechou' || x.outcome === 'encerrado' || x.outcome === 'bandeja').length;
    if (!closed) return { status: 'falhou', result: 'Nenhum app fechou (talvez estejam pedindo para salvar).' };
    const freed = r.availAfter - r.availBefore;
    return { status: 'feita', result: `${closed} de ${plural(r.results.length, 'app', 'apps')} fechou${closed === 1 ? '' : 'ram'}${freed > 0 ? ` · liberou ${size(freed)}` : ''}` };
  }

  async function runClean(s: Suggestion): Promise<Outcome> {
    // R21: cada categoria do cartão ainda tem que ser acionável agora (ex.: o navegador não pode ter sido aberto)
    const now_ = await deps.files.quickCleanPreview({ fresh: true });   // sem cache: o navegador pode ter sido aberto
    const cats = s.items.map(i => i.id as QuickCleanCategory);
    const bad = cats.find(c => !now_.some(p => p.category === c && p.actionable));
    if (bad) return { status: 'falhou', result: 'Nada foi apagado: uma das categorias não pode mais ser limpa agora (o navegador foi aberto?).' };
    const r = await deps.files.quickClean({ categories: cats });   // só as categorias que o cartão mostrava
    const kept = r.skipped ? ` · ${plural(r.skipped, 'em uso ficou', 'em uso ficaram')}` : '';
    return { status: 'feita', result: `${plural(r.files, 'arquivo apagado', 'arquivos apagados')} · ${size(r.bytes)}${kept}` };
  }

  async function runAppData(s: Suggestion): Promise<Outcome> {
    // R21, para qualquer origem: o clean recalcula os alvos das regras e rejulga cada um (id forjado, app aberto → pulado);
    // sem preview novo, que mediria a Library inteira só para conferir o que o clean já confere
    // decisão 11 vale também para cartão vindo do arquivo (adulterado): o vigia nunca apaga dados de app
    if (s.source === 'vigia') return { status: 'falhou', result: 'Nada foi apagado: o vigia não propõe limpeza de dados dos apps.' };
    if (!deps.appData) return { status: 'falhou', result: 'Nada foi apagado: dados dos apps indisponível.' };
    const ids = [...new Set(s.items.map(i => i.id))];   // o clean conta os pulados sobre ids sem repetição
    const r = await deps.appData.clean(ids);
    if (r.skipped >= ids.length) return { status: 'falhou', result: 'Nada foi apagado: um dos apps foi aberto ou o cache mudou.' };
    const kept = r.skipped ? ` · ${plural(r.skipped, 'cache ficou', 'caches ficaram')}` : '';
    return { status: 'feita', result: `${plural(r.files, 'arquivo apagado', 'arquivos apagados')} · ${size(r.bytes)}${kept}` };
  }

  // ---------- ignore ----------
  function ignore(id: string): Suggestion | SuggestionError {
    const s = items.find(x => x.id === id);
    if (!s) return err('sugestão não encontrada', 404);
    if (s.status !== 'pendente' || running.has(id)) return err('essa sugestão já foi decidida', 409);
    s.status = 'ignorada'; s.doneAt = now();
    void persist();
    publish();
    return { ...s };
  }

  return { list, add, approve, ignore, flush: () => writing };
}
export type Suggestions = ReturnType<typeof createSuggestions>;
