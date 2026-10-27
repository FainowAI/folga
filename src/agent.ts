// Agente no chat (F-18, ADR 0006): Claude ou GPT pelos CLIs já logados nas assinaturas, um processo por turno.
// O agente só lê (ferramentas MCP readOnly, src/mcp.ts) e propõe ações num bloco ```folga-sugestao; o servidor
// valida e vira cartão que o usuário aprova na tela (R20–R24). Um turno por vez, teto de 120 s (R25).
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { createInterface } from 'node:readline';
import type { SuggestionError } from './suggestions.ts';
import type {
  AgentEvent, AgentProvider, ChatMessage, Conversation, Emit, Suggestion, SuggestionDraft, SuggestionKind,
} from './types.ts';

export type Launch = { cmd: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string };
export type TurnInput = { provider: AgentProvider; prompt: string; sessionId: string | null; system: string; mcpFile: string };
export type AgentDeps = {
  dataDir: string;
  port: number;
  emit: Emit;
  addSuggestion: (draft: SuggestionDraft) => Promise<Suggestion | SuggestionError>;
  selfPids: Set<number>;     // o processo do CLI entra como "__self" enquanto vive (R05)
  // opcionais, para testes
  turnTimeoutMs?: number;                       // padrão 120 s (R25)
  launch?: (t: TurnInput) => Launch;            // troca o comando do provedor (script fake)
  killTree?: (pid: number) => void;             // troca o taskkill (teste confere quando ele é chamado)
  disclaim?: (l: Launch) => Launch;             // troca o embrulho do --disclaim (teste do código 126)
  findCli?: (p: AgentProvider) => string | null; // troca a busca do binário do CLI
  turnOpen?: () => string | void;               // o servidor cria o agent-token só durante o turno
  turnClose?: (t: string | void) => void;       // recebe o que o turnOpen daquele turno devolveu
};
export type SendResult = { ok: true } | { erro: string; status: number };

const TURN_TIMEOUT_MS = 120_000;
const MAX_MESSAGES = 200;
const MAX_SUGGESTIONS_PER_MESSAGE = 5;
const TOOL_PREFIX = 'mcp__folga__';
const FENCE = /```folga-sugestao[ \t]*\r?\n([\s\S]*?)```/g;
const KINDS: readonly SuggestionKind[] = ['lixeira', 'limpeza_rapida', 'liberar_memoria', 'dados_apps'];
const KIND_BY_TIPO: Record<string, SuggestionKind> = { lixeira: 'lixeira', limpeza_rapida: 'limpeza_rapida', liberar_memoria: 'liberar_memoria', dados_apps: 'dados_apps' };

// ---------------------------------------------------------------------------------------------------
// Binários dos CLIs (ADR 0006): caminho absoluto, shell:false
// ---------------------------------------------------------------------------------------------------
const CLAUDE_EXE = process.env.FOLGA_CLAUDE_EXE ?? join(homedir(), '.local', 'bin', 'claude.exe');
const CODEX_EXE = process.env.FOLGA_CODEX_EXE ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
const WIN_EXE: Record<AgentProvider, string> = { claude: CLAUDE_EXE, gpt: CODEX_EXE };
const MISSING: Record<AgentProvider, string> = { claude: 'Claude Code não encontrado', gpt: 'Codex não encontrado' };
const WHERE_MAC = ' (procurei em ~/.local/bin, no nvm e no Homebrew)';
export const missing = (p: AgentProvider, platform: NodeJS.Platform = process.platform) => MISSING[p] + (platform === 'darwin' ? WHERE_MAC : '');

// Mach-O fino (64/32 bits, nas duas ordens de byte) e universal (fat e fat64)
const MACHO = new Set(['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const writableByOthers = (st: { uid: number; mode: number }, uid: number) => (st.uid !== uid && st.uid !== 0) || (st.mode & 0o022) !== 0;

/** Caminho real do binário se ele é seguro de executar: absoluto, arquivo comum Mach-O (script nunca), com bit de execução,
 *  do usuário ou do root e sem escrita para grupo/outros — ele e a pasta onde mora. Senão null. */
export function safeExe(p: string, uid: number): string | null {
  if (!isAbsolute(p)) return null;
  try {
    const real = realpathSync(p);
    const st = lstatSync(real);
    if (!st.isFile() || (st.mode & 0o111) === 0 || writableByOthers(st, uid) || writableByOthers(statSync(dirname(real)), uid)) return null;
    const head = Buffer.alloc(4);
    const fd = openSync(real, 'r');
    try { if (readSync(fd, head, 0, 4, 0) !== 4) return null; } finally { closeSync(fd); }
    return MACHO.has(head.toString('hex')) ? real : null;
  } catch { return null; }
}

const CODEX_JS = '/@openai/codex/bin/codex.js';
const CODEX_ARCH: Record<string, [string, string]> = { arm64: ['arm64', 'aarch64'], x64: ['x64', 'x86_64'] };
/** O `codex` do npm é um script (codex.js) que lança o binário do vendor: o Folga roda o binário direto. Só Mac (posix). */
export function codexNative(real: string, arch: string): string {
  const a = CODEX_ARCH[arch];
  if (!a || !real.endsWith(CODEX_JS)) return real;
  return posix.join(real.slice(0, -'/bin/codex.js'.length), 'node_modules', '@openai', `codex-darwin-${a[0]}`, 'vendor', `${a[1]}-apple-darwin`, 'bin', 'codex');
}

const nodeVersion = (v: string) => v.slice(1).split('.').map(Number);
function nvmBins(home: string): string[] {
  const root = join(home, '.nvm', 'versions', 'node');
  let vs: string[];
  try { vs = readdirSync(root).filter(v => /^v\d+(\.\d+)*$/.test(v)); } catch { return []; }
  vs.sort((x, y) => { const a = nodeVersion(x), b = nodeVersion(y); for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0); return 0; });
  return vs.map(v => join(root, v, 'bin'));
}

/** Instalador nativo do Claude Code: ~/.local/bin/claude é link para ~/.local/share/claude/versions/<x.y.z>; o nome real é a versão. */
function nativeVersion(exe: string, home: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(basename(exe))) return false;
  try { return dirname(exe) === realpathSync(join(home, '.local', 'share', 'claude', 'versions')); } catch { return false; }
}

/** Binário do CLI por lista fechada de lugares (nunca o PATH nem o cwd). No Mac: o override do env (se houver, só ele),
 *  ~/.local/bin, o nvm do maior para o menor, Homebrew e /usr/local/bin; o primeiro que passa no safeExe ganha.
 *  O nvm vem antes do Homebrew: aqui o claude do Homebrew estava velho (2.1.187) e o validado no ADR 0006 é o do nvm. */
export function findCli(provider: AgentProvider, o: { home: string; uid: number; arch: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; system?: string[] }): string | null {
  const override = o.env[provider === 'claude' ? 'FOLGA_CLAUDE_EXE' : 'FOLGA_CODEX_EXE'];
  if ((o.platform ?? process.platform) !== 'darwin') { const p = override ?? WIN_EXE[provider]; return existsSync(p) ? p : null; }
  const name = provider === 'claude' ? 'claude' : 'codex';
  const cands = override ? [override]
    : [join(o.home, '.local', 'bin'), ...nvmBins(o.home), ...(o.system ?? ['/opt/homebrew/bin', '/usr/local/bin'])].map(d => join(d, name));
  for (const c of cands) {
    if (!isAbsolute(c)) continue;
    let real: string;
    try { real = realpathSync(c); } catch { continue; }
    const exe = safeExe(name === 'codex' ? codexNative(real, o.arch) : real, o.uid);
    // o nome REAL do binário: um link chamado claude para /bin/zsh não passa
    if (exe && (['claude', 'claude.exe', 'codex'].includes(basename(exe)) || (name === 'claude' && nativeVersion(exe, o.home)))) return exe;
  }
  return null;
}
const findCliHere = (p: AgentProvider) => findCli(p, { home: homedir(), uid: process.getuid?.() ?? -1, arch: process.arch, env: process.env });

/** Pasta vazia onde os CLIs rodam: a pasta de dados guarda ui-token, ajustes, registro e sugestões, e o agente não deve vê-los. */
export const agentCwd = (dataDir: string) => join(dataDir, 'agent-cwd');

// Id de sessão vai para --resume / exec resume: só o formato que cada CLI gera (Claude: UUID; Codex: letras, números e hífens)
const SESSION_ID: Record<AgentProvider, RegExp> = { claude: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, gpt: /^[A-Za-z0-9-]{1,64}$/ };
export const validSessionId = (provider: AgentProvider, v: unknown): string | null => (typeof v === 'string' && SESSION_ID[provider].test(v) ? v : null);

const fwd = (p: string) => p.replaceAll('\\', '/');
const toml = (s: string) => JSON.stringify(s);   // string TOML básica = string JSON
// Codex 0.157 no Mac (spike do ADR 0006, 22/10): recursos novos que dão ao agente outro jeito de agir. Fora fica o
// code_mode_host: desligado, o MCP do Folga para de funcionar (o code mode falha fechado).
export const CODEX_DISABLE_MAC = ['unified_exec', 'multi_agent', 'memories', 'workspace_dependencies', 'skill_mcp_dependency_install',
  'in_app_local_automation', 'worktrees'];
const API_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

/** Ambiente do CLI. Windows: o do servidor sem as chaves de API (a cota vem da assinatura). Mac: montado do zero — nada de
 *  NODE_*, DYLD_*, chave de API ou PATH do usuário. O PATH fixo basta: os dois CLIs são nativos, o shell está desligado e o
 *  MCP vai por caminho absoluto (process.execPath); o bin do bundle não entra para o CLI não achar o node do app pelo nome. */
export function cliEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform !== 'darwin') {
    const clean = { ...base };
    for (const k of API_KEYS) delete clean[k];
    return clean;
  }
  const user = userInfo().username;
  return {
    HOME: homedir(), USER: user, LOGNAME: user, ...(base.LANG && /^[A-Za-z0-9_.@-]{1,64}$/.test(base.LANG) ? { LANG: base.LANG } : {}),
    TMPDIR: base.TMPDIR ?? tmpdir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  };
}

const CODEX_DISABLE = ['shell_tool', 'plugins', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
  'in_app_browser', 'hooks', 'tool_suggest', 'skill_search', 'goals', 'view_image'];

/**
 * Dentro do Folga.app (Mac) o CLI roda por `probe-mac --disclaim`: responde pelas próprias permissões e não herda o
 * Acesso Total ao Disco do app. Fora do app (ou no Windows) não há o que herdar: volta o mesmo Launch.
 */
export function disclaimed(l: Launch, platform: NodeJS.Platform, insideApp: boolean, helper: string): Launch {
  if (platform !== 'darwin' || !insideApp) return l;
  return { ...l, cmd: helper, args: ['--disclaim', l.cmd, ...l.args] };
}
const PROBE_MAC = join(import.meta.dirname, '..', 'probe', 'bin', 'probe-mac');
/** probe-mac --disclaim sai 125 sem executar quando o macOS não tem a API (e o probe-mac pode faltar no bundle): o assistente
 *  não roda no app (fail closed). 125 é só do disclaim; um 126 do próprio CLI continua a mensagem comum. */
export const DISCLAIM_UNAVAILABLE = 125;
export const CODEX_INCOMPATIVEL = 'A versão do Codex instalada não é compatível com o Folga.';
export const DISCLAIM_FAIL = 'O assistente não roda dentro do app Folga neste macOS: não deu para isolá-lo do app. Nada foi executado.';

/** Comando real de cada provedor, com as flags exatas do spike (ADR 0006). */
export function realLaunch(t: TurnInput, dataDir: string, port: number, exe = WIN_EXE[t.provider], platform = process.platform): Launch {
  // a cota vem da assinatura: chave de API no ambiente trocaria o faturamento sem o Antônio saber
  const clean = cliEnv(process.env, platform);
  // texto que começa com "-" viraria opção do CLI
  const prompt = t.prompt.startsWith('-') ? ' ' + t.prompt : t.prompt;

  if (t.provider === 'claude') {
    const home = fwd(homedir());
    return {
      cmd: exe,
      args: [
        '-p', prompt, '--output-format', 'stream-json', '--verbose',
        ...(t.sessionId ? ['--resume', t.sessionId] : []),
        '--tools', '', '--mcp-config', t.mcpFile, '--strict-mcp-config',
        '--allowedTools', 'mcp__folga', '--permission-mode', 'dontAsk',
        '--setting-sources', 'project,local', '--disable-slash-commands',
        '--system-prompt', t.system,
        // crossSessionInbound + HARBOR_KITE=0: mensagem de outra sessão do Claude Code não entra no agente (wiki: achado N1 do Play.me)
'--settings', JSON.stringify({ disableAllHooks: true, crossSessionInbound: 'refuse', claudeMdExcludes: ['**/CLAUDE.md', `${home}/.claude/CLAUDE.md`] }),
      ],
      env: { ...clean, CLAUDE_CODE_HARBOR_KITE: '0' },
      cwd: agentCwd(dataDir),
    };
  }
  const mcpRoot = fwd(join(import.meta.dirname, 'mcp.ts'));
  const common = [
    '--json', '--skip-git-repo-check', '--ignore-user-config',
    '-c', 'sandbox_mode="read-only"',
    ...(platform === 'darwin' ? ['-c', 'web_search="disabled"'] : []),   // web__run abriria qualquer URL: injeção de prompt vazaria nomes de arquivo/app
    '-c', `mcp_servers.folga.command=${toml(fwd(process.execPath))}`,
    '-c', `mcp_servers.folga.args=[${toml('--no-warnings')},${toml(mcpRoot)}]`,
    '-c', `mcp_servers.folga.env={FOLGA_PORT=${toml(String(port))},FOLGA_DATA_DIR=${toml(fwd(dataDir))}}`,
    '-c', `developer_instructions=${toml(t.system)}`,
    ...(platform === 'darwin' ? [...CODEX_DISABLE, ...CODEX_DISABLE_MAC] : CODEX_DISABLE).flatMap(f => ['--disable', f]),
  ];
  // `exec resume` não aceita --sandbox nem -C (por isso sandbox_mode vai por -c e a pasta é o cwd do processo)
  return {
    cmd: exe,
    args: t.sessionId ? ['exec', 'resume', ...common, '--', t.sessionId, prompt] : ['exec', ...common, '--', prompt],
    env: clean,
    cwd: agentCwd(dataDir),
  };
}

// ---------------------------------------------------------------------------------------------------
// Leitura do stream (JSONL) dos dois CLIs. Pura, para testar com fixtures reais.
// ---------------------------------------------------------------------------------------------------
export type Acc = {
  sessionId: string | null;
  tools: string[];          // nomes na ordem de chamada, sem prefixo
  texts: string[];          // blocos de texto vistos
  finalText: string | null; // resposta final
  error: string | null;     // erro explícito do turno (turn.failed, is_error)
  softError: string | null; // erro solto (só vale se não houver resposta)
  done: boolean;
  seen: Set<string>;        // ids de ferramentas já contadas (Codex repete started/completed)
};
export const newAcc = (): Acc => ({ sessionId: null, tools: [], texts: [], finalText: null, error: null, softError: null, done: false, seen: new Set() });
export type StreamEvent = { type: 'tool'; tool: string } | { type: 'text'; text: string };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

export function feed(provider: AgentProvider, line: string, acc: Acc): StreamEvent[] {
  let j: Record<string, unknown>;
  try { j = rec(JSON.parse(line)); } catch { return []; }
  const out: StreamEvent[] = [];
  const tool = (name: string) => { const n = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name; acc.tools.push(n); out.push({ type: 'tool', tool: n }); };
  const text = (t: string) => { acc.texts.push(t); out.push({ type: 'text', text: t }); };

  if (provider === 'claude') {
    if (j.type === 'system' && j.subtype === 'init') acc.sessionId = validSessionId('claude', j.session_id) ?? acc.sessionId;
    else if (j.type === 'assistant') {
      const content = rec(j.message).content;
      for (const c of Array.isArray(content) ? content : []) {
        const b = rec(c);
        if (b.type === 'text' && str(b.text)) text(b.text as string);
        else if (b.type === 'tool_use' && str(b.name)) tool(b.name as string);
      }
    } else if (j.type === 'result') {
      acc.sessionId = validSessionId('claude', j.session_id) ?? acc.sessionId;
      acc.done = true;
      if (j.is_error === true || (j.subtype !== undefined && j.subtype !== 'success')) acc.error = str(j.result) ?? `o Claude terminou com ${String(j.subtype ?? 'erro')}`;
      else acc.finalText = typeof j.result === 'string' ? j.result : null;
    }
    return out;
  }

  // Codex
  const item = rec(j.item);
  if (j.type === 'thread.started') acc.sessionId = validSessionId('gpt', j.thread_id) ?? acc.sessionId;
  else if ((j.type === 'item.started' || j.type === 'item.completed') && item.type === 'mcp_tool_call' && str(item.tool)) {
    const id = str(item.id) ?? `${acc.tools.length}:${item.tool as string}`;
    if (!acc.seen.has(id)) { acc.seen.add(id); tool(item.tool as string); }
  } else if (j.type === 'item.completed' && item.type === 'agent_message' && str(item.text)) {
    text(item.text as string);
    acc.finalText = item.text as string;
  } else if (j.type === 'item.completed' && item.type === 'error') {
    // avisos como "recurso experimental" chegam aqui; só viram erro se não houver resposta
    acc.softError = str(item.message) ?? acc.softError;
  } else if (j.type === 'turn.completed') acc.done = true;
  else if (j.type === 'turn.failed') { acc.done = true; acc.error = str(rec(j.error).message) ?? 'o Codex não conseguiu responder'; }
  else if (j.type === 'error') acc.softError = str(j.message) ?? acc.softError;
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Blocos ```folga-sugestao (R20, R24): o modelo escreve, o servidor valida.
// ---------------------------------------------------------------------------------------------------
export type Extracted = { text: string; drafts: SuggestionDraft[]; rejected: string[] };

export function extractSuggestions(raw: string): Extracted {
  const drafts: SuggestionDraft[] = [];
  const rejected: string[] = [];
  let n = 0;
  const text = raw.replace(FENCE, (_all, body: string) => {
    n++;
    if (n > MAX_SUGGESTIONS_PER_MESSAGE) { if (n === MAX_SUGGESTIONS_PER_MESSAGE + 1) rejected.push(`Mais de ${MAX_SUGGESTIONS_PER_MESSAGE} sugestões numa resposta: o resto foi ignorado.`); return ''; }
    let j: Record<string, unknown>;
    try { j = rec(JSON.parse(body)); } catch { rejected.push(`Sugestão ${n} ignorada: o JSON do bloco é inválido.`); return ''; }
    const kind = typeof j.tipo === 'string' ? KIND_BY_TIPO[j.tipo] : undefined;
    const itens = j.itens;
    if (!kind || !KINDS.includes(kind)) rejected.push(`Sugestão ${n} ignorada: tipo desconhecido.`);
    else if (typeof j.titulo !== 'string' || !j.titulo.trim() || j.titulo.length > 160) rejected.push(`Sugestão ${n} ignorada: título ausente ou longo demais.`);
    else if (typeof j.motivo !== 'string' || j.motivo.length > 600) rejected.push(`Sugestão ${n} ignorada: motivo ausente ou longo demais.`);
    else if (!Array.isArray(itens) || itens.length === 0 || itens.length > 200 || !itens.every(i => typeof i === 'string' && i.length > 0 && i.length <= 600)) rejected.push(`Sugestão ${n} ignorada: a lista de itens é inválida.`);
    else drafts.push({ kind, title: j.titulo.trim(), reason: j.motivo.trim(), items: itens as string[] });
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), drafts, rejected };
}

// ---------------------------------------------------------------------------------------------------
// Agente
// ---------------------------------------------------------------------------------------------------
type Stored = { id: string; provider: AgentProvider; sessionId: string | null; messages: ChatMessage[] };

const SO_TEXTO: Record<'win32' | 'darwin', Record<string, string>> = {
  win32: {
    SO: 'Windows', O_USUARIO: 'o Antônio', DO_USUARIO: 'do Antônio', AO_USUARIO: 'ao Antônio', DO_PC: 'do PC',
    EXEMPLO_CAMINHO: 'C:\\\\Users\\\\Antônio\\\\Downloads\\\\setup-antigo.exe', NOTA_BARRAS: ' Dentro do JSON, barras invertidas em dobro.',
    PASTAS_SISTEMA: 'Windows, Program Files, ProgramData, AppData fora dos temporários e caches das ferramentas',
  },
  // o app é do Vittorio, mas o código vai para o Antônio no PR: nome próprio fica fora do texto do Mac
  darwin: {
    SO: 'Mac (macOS)', O_USUARIO: 'o usuário', DO_USUARIO: 'do usuário', AO_USUARIO: 'ao usuário', DO_PC: 'do computador',
    EXEMPLO_CAMINHO: '/Users/voce/Downloads/instalador-antigo.dmg', NOTA_BARRAS: '',
    PASTAS_SISTEMA: '/System, /Library, /Applications, ~/Library fora dos caches que as ferramentas mostram',
  },
};
let promptModelo: string | undefined;
export function promptFor(platform: NodeJS.Platform): string {
  promptModelo ??= readFileSync(join(import.meta.dirname, 'agent-prompt.md'), 'utf8').trim();
  const t = SO_TEXTO[platform === 'darwin' ? 'darwin' : 'win32'];
  return fillPrompt(promptModelo, t);
}
export function fillPrompt(model: string, t: Record<string, string>): string {
  return model.replace(/\{\{(\w+)\}\}/g, (_, k: string) => { if (!(k in t)) throw new Error(`marcador {{${k}}} sem valor no prompt`); return t[k]!; });
}

export function killTree(pid: number, platform = process.platform) {
  if (platform === 'darwin') {
    // só o grupo que o spawn detached criou (pgid == pid do filho): nunca 0/1/negativo nem o nosso próprio grupo
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
    // ponytail: servidor morto por SIGKILL deixa o CLI terminar o turno sozinho (o MCP sai quando o stdin fecha); pegar esse caso pediria um vigia de fora.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* ESRCH: já morreu */ }
    return;
  }
  const r = spawnSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000, stdio: 'ignore' });
  if (r.status !== 0) { try { process.kill(pid); } catch { /* já morreu */ } }
}

const dateBR = () => new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export function createAgent(deps: AgentDeps) {
  const file = join(deps.dataDir, 'agent.json');
  const mcpFile = join(deps.dataDir, 'agent-mcp.json');
  const cwd = agentCwd(deps.dataDir);
  const kill = deps.killTree ?? killTree;
  const timeoutMs = deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;

  const fresh = (provider: AgentProvider): Stored => ({ id: randomUUID(), provider, sessionId: null, messages: [] });
  function load(): Stored {
    try {
      const j = rec(JSON.parse(readFileSync(file, 'utf8')));
      if (str(j.id) && (j.provider === 'claude' || j.provider === 'gpt') && Array.isArray(j.messages)) {
        // sessão gravada em outra pasta (antes do agent-cwd) não é achada pelo --resume: começa uma nova, o histórico fica
        const sessionId = j.cwd === cwd ? validSessionId(j.provider, j.sessionId) : null;
        return { id: j.id as string, provider: j.provider, sessionId, messages: (j.messages as ChatMessage[]).slice(-MAX_MESSAGES) };
      }
    } catch { /* sem conversa salva */ }
    return fresh('claude');
  }
  let conv = load();
  let busy = false;
  // live: o processo do CLI ainda existe. Depois que ele sai o Windows pode reaproveitar o PID, então ninguém mais manda taskkill nele.
  type Turn = { pid: number | null; convId: string; killed: 'stop' | 'timeout' | null; live: boolean };
  let current: Turn | null = null;

  const save = () => {
    conv.messages = conv.messages.slice(-MAX_MESSAGES);
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ ...conv, cwd }));
    renameSync(tmp, file);
  };
  const emit = (e: AgentEvent) => deps.emit('agent', e);
  const view = (): Conversation => ({ ...conv, busy });

  function writeMcpConfig() {
    const cfg = { mcpServers: { folga: { command: process.execPath, args: ['--no-warnings', join(import.meta.dirname, 'mcp.ts')], env: { FOLGA_PORT: String(deps.port), FOLGA_DATA_DIR: deps.dataDir } } } };
    writeFileSync(mcpFile, JSON.stringify(cfg));
  }
  function systemPrompt(): string {
    return `${promptFor(process.platform)}\n\nHoje é ${dateBR()}.`;
  }

  /** Fecha o turno: grava a resposta (ou o erro) e avisa a tela. Ignora se a conversa já foi trocada (reset). */
  async function conclude(convId: string, provider: AgentProvider, acc: Acc, why: 'stop' | 'timeout' | null, exitCode: number | null, stderr: string) {
    if (conv.id !== convId) return;
    if (acc.sessionId) conv.sessionId = acc.sessionId;

    const reply = acc.error === null && !why ? (acc.finalText ?? (acc.texts.length ? acc.texts.join('\n\n') : null)) : null;
    let msg: ChatMessage;
    if (reply === null || !reply.trim()) {
      // R17: o chat só mostra texto fixo; o detalhe do CLI (pode ter caminho e dado interno) vai só para o console
      const nome = provider === 'claude' ? 'O Claude' : 'O GPT';
      const motivo = why === 'timeout' ? 'Tempo esgotado: parei a resposta.'
        : why === 'stop' ? 'Resposta interrompida.'
        : acc.error === DISCLAIM_FAIL ? DISCLAIM_FAIL   // texto fixo nosso, não do CLI
        : provider === 'gpt' && /Unknown feature flag/.test(stderr) ? CODEX_INCOMPATIVEL   // --disable de nome que essa versão não tem
        : `${nome} não respondeu agora. Tente de novo.`;
      if (!why) console.error('[agente] turno sem resposta:', provider, `código ${exitCode}:`, (acc.error ?? acc.softError ?? stderr.trim().split(/\r?\n/).slice(-2).join(' ')).slice(0, 400));
      msg = { id: randomUUID(), role: 'assistant', text: motivo, t: Date.now(), provider, tools: acc.tools.length ? [...new Set(acc.tools)] : undefined, error: true };
      conv.messages.push(msg);
      save();
      emit({ type: 'error', conversation: convId, error: msg.text });
      return;
    }

    const ex = extractSuggestions(reply);
    const ids: string[] = [];
    const rejected = [...ex.rejected];
    for (const d of ex.drafts) {
      try {
        const r = await deps.addSuggestion(d);
        if ('erro' in r) rejected.push(`${d.title}: ${r.erro}`);
        else ids.push(r.id);
      } catch { rejected.push(`${d.title}: não consegui registrar a sugestão.`); }
    }
    if (conv.id !== convId) return;
    msg = {
      id: randomUUID(), role: 'assistant', t: Date.now(), provider,
      text: ex.text || (ids.length ? 'Preparei uma sugestão para você revisar abaixo.' : 'Não consegui montar uma resposta.'),
      tools: acc.tools.length ? [...new Set(acc.tools)] : undefined,
      suggestionIds: ids.length ? ids : undefined,
      rejected: rejected.length ? rejected : undefined,
    };
    conv.messages.push(msg);
    save();
    emit({ type: 'done', conversation: convId, message: msg });
  }

  // busy só cai depois da mensagem gravada (validar sugestões leva tempo); um turno velho (após reset) não mexe no novo
  async function finish(turn: Turn | null, convId: string, provider: AgentProvider, acc: Acc, why: 'stop' | 'timeout' | null, exitCode: number | null, stderr: string) {
    try { await conclude(convId, provider, acc, why, exitCode, stderr); }
    catch { if (conv.id === convId) emit({ type: 'error', conversation: convId, error: 'não consegui guardar a resposta' }); }
    finally { if (current === turn) { busy = false; current = null; } }
  }

  function runTurn(provider: AgentProvider, prompt: string, exe: string | undefined) {
    const convId = conv.id;
    const acc = newAcc();
    const input: TurnInput = { provider, prompt, sessionId: conv.sessionId, system: systemPrompt(), mcpFile };
    const raw = deps.launch ? deps.launch(input) : realLaunch(input, deps.dataDir, deps.port, exe);
    const l = deps.disclaim ? deps.disclaim(raw) : disclaimed(raw, process.platform, process.env.FOLGA_APP === '1', PROBE_MAC);
    const turn: Turn = { pid: null, convId, killed: null, live: false };
    const killLive = () => { if (turn.live && turn.pid) kill(turn.pid); };
    current = turn;

    let stderr = '';
    let closed = false;
    const done = (code: number | null) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      killLive();   // o CLI demora a sair depois da resposta; não precisamos esperar
      deps.turnClose?.(turnToken);
      turn.live = false;
      if (turn.pid) deps.selfPids.delete(turn.pid);
      void finish(turn, convId, provider, acc, turn.killed, code, stderr);
    };

    mkdirSync(cwd, { recursive: true });
    const turnToken = deps.turnOpen?.();
    const child = spawn(l.cmd, l.args, { cwd: l.cwd ?? cwd, env: l.env ?? process.env, shell: false, windowsHide: true, detached: process.platform === 'darwin', stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) { turn.pid = child.pid; turn.live = true; deps.selfPids.add(child.pid); }
    const timer = setTimeout(() => { turn.killed = 'timeout'; killLive(); }, timeoutMs);

    createInterface({ input: child.stdout }).on('line', line => {
      for (const e of feed(provider, line, acc)) emit({ ...e, conversation: convId });
      if (acc.done && !closed) setTimeout(() => done(0), 200);   // resposta completa: fecha já
    });
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += String(d); });
    child.on('error', e => {
      if (l !== raw) acc.error = acc.error ?? DISCLAIM_FAIL;   // probe-mac fora do bundle: mesma mensagem fixa, não o ENOENT cru
      acc.error = acc.error ?? `não consegui iniciar o ${provider === 'claude' ? 'Claude' : 'Codex'}: ${(e as NodeJS.ErrnoException).code ?? 'erro'}`;
      done(null);
    });
    // espera o stdout esvaziar um instante depois da saída (o readline pode ter linhas pendentes)
    child.on('exit', code => {
      turn.live = false;
      if (code === DISCLAIM_UNAVAILABLE && l !== raw) acc.error = acc.error ?? DISCLAIM_FAIL;
      setTimeout(() => done(code), 300);
    });
  }

  function stop(): void {
    if (!current?.live) return;   // sem turno, ou o CLI já saiu (só falta gravar a resposta): nada a matar
    current.killed ??= 'stop';
    if (current.pid) kill(current.pid);
  }

  return {
    conversation(): Conversation { return view(); },

    async send(provider: AgentProvider, text: string): Promise<SendResult> {
      if (busy) return { erro: 'já estou respondendo', status: 409 };
      // achado de novo a cada turno: instalar o CLI depois não exige reiniciar (custo: alguns stat)
      // ponytail: entre o safeExe e o spawn há uma janela de microssegundos; quem consegue trocar o binário nela já escreve na pasta do usuário e venceria de qualquer jeito.
      const exe = deps.launch ? undefined : (deps.findCli ?? findCliHere)(provider) ?? null;
      if (exe === null) return { erro: missing(provider), status: 503 };
      if (conv.provider !== provider) {
        // sessões não passam de um provedor para o outro: conversa nova (R25/D14)
        if (conv.messages.length) console.log(`[agente] provedor mudou de ${conv.provider} para ${provider}: conversa nova`);
        conv = fresh(provider);
      }
      try { writeMcpConfig(); } catch { return { erro: 'não consegui preparar o assistente', status: 500 }; }
      const userMsg: ChatMessage = { id: randomUUID(), role: 'user', text, t: Date.now() };
      conv.messages.push(userMsg);
      save();
      busy = true;
      emit({ type: 'start', conversation: conv.id, provider });
      try { runTurn(provider, text, exe); }
      catch (e) {
        void finish(current, conv.id, provider, { ...newAcc(), error: `não consegui iniciar: ${e instanceof Error ? e.message : 'erro'}` }, null, null, '');
      }
      return { ok: true };
    },

    reset(): Conversation {
      stop();
      current = null;
      busy = false;
      conv = fresh(conv.provider);
      save();
      return view();
    },

    stop,
  };
}
export type Agent = ReturnType<typeof createAgent>;
