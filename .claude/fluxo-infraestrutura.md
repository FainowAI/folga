# Infraestrutura — stack, peças e contrato

## Stack (a do Play.me, com menos peças)
- Node v24.13.0, npm 11.6.2, TypeScript strict. O servidor roda `.ts` direto: `node --no-warnings src/server.ts`.
- `node:http` puro com SSE. Sem express, Agent SDK, MCP ou banco.
- React 19 + Vite 8 + `@vitejs/plugin-react`, com CSS de tokens em `web/src/tokens.css` (D08).
- Sonda nativa: C# em um arquivo, compilado por
  `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, que já vem no Windows.
  **Mac:** Swift em um arquivo (`probe/probe-mac.swift`), compilado com `swiftc -O` das Command Line Tools (sem Xcode).
- Testes sem framework: `node --no-warnings src/tests/x.test.ts` com `node:assert`. `npm test` encadeia todos.
- Um único `package.json` na raiz, sem workspaces. O Vite usa `web/` como root.

## Peças (C4 nível container)
```
[Usuário] → janela Edge --app (perfil próprio) → http://127.0.0.1:4780
                                                     │
                                  ┌──────────────────┴──────────────────┐
                                  │ Node: src/server.ts                 │
                                  │  HTTP + SSE + token + estáticos     │
                                  │  classify.ts (regras R03–R06)       │
                                  │  release.ts (R07–R09) · autocare.ts │
                                  │  settings.json · log.jsonl          │
                                  └──────────────────┬──────────────────┘
                                         stdin/stdout, uma linha JSON por mensagem
                                  ┌──────────────────┴──────────────────┐
                                  │ probe.exe (C#): GlobalMemoryStatusEx,│
                                  │ processos, janelas, foreground, CPU, │
                                  │ WM_CLOSE                             │
                                  └──────────────────────────────────────┘
```

## Árvore de arquivos planejada
```
package.json  tsconfig.json  vite.config.ts  .gitignore
probe/probe.cs                 F-01  sonda nativa
scripts/build-probe.mjs        F-01  compila com csc.exe → probe/bin/probe.exe (gitignored)
scripts/probe-smoke.mjs        F-01  sobe a sonda, imprime 3 leituras e o top 10 por memória
scripts/launch.mjs             F-08  sobe o servidor escondido e abre a janela
src/types.ts                   F-00  contrato (abaixo), escrito antes de tudo
src/classify.ts                F-02  função pura: (leitura, histórico, ajustes, agora) → grupos
src/probe.ts                   F-03  spawn da sonda, parse de linhas, reinício se morrer
src/server.ts                  F-03  HTTP, SSE, token, estáticos
src/release.ts                 F-04  liberar (R07–R09) e gravar o registro (R14)
src/autocare.ts                F-06  gatilho, freio (R10–R13)
src/tests/*.test.ts            um por módulo com lógica
web/index.html  web/src/{main,App,Memory,AutoCare,Log}.tsx  web/src/tokens.css
```
Dados em `%LOCALAPPDATA%\Folga\`:
- `settings.json`, `log.jsonl`, `ui-token` e `edge-profile\`;
- desde a v2: `agent-token` (só para a busca, lido pelo MCP), `suggestions.json`, `agent.json`,
  `agent-mcp.json` e `agent-cwd\` (pasta vazia, diretório de trabalho dos CLIs).

v2: servidor MCP do agente em `src/mcp.ts`, assistente em `src/agent.ts` (ADR 0006), avisos em
`src/warnings.ts`, arquivos e limpeza em `src/files.ts`, sugestões em `src/suggestions.ts`.

v3: o vigia em `src/watch.ts` (R30, D21) e o aviso do Windows em `src/notify.ts` (R31).
Ele só chama `suggestions.add(draft, 'vigia')`; executar continua
sendo `suggestions.approve`, que só roda no clique. Testes: `FOLGA_WATCH_MS` encurta o ciclo, e a sonda falsa
aceita `FAKE_AVAIL_GB` e `FAKE_NOTEPAD_MB`.

## Contrato (`src/types.ts`, F-00)
Desde o F-00 a fonte é o `src/types.ts`, que também exporta `DEFAULT_SETTINGS`, `SYSTEM_PROCESSES` e
`ReleaseResponse`. Este bloco é o resumo.
```ts
// sonda → Node (uma linha por leitura)
export type ProbeProcess = {
  pid: number; ppid: number; name: string; description: string; session: number;
  privateWorkingSet: number;   // bytes (R02)
  cpuTimeMs: number;           // acumulado; o Node calcula o delta (R04)
  hasVisibleWindow: boolean;   // janela de topo visível, sem dono (Mac: app com activationPolicy .regular)
  windowCount?: number;        // quantas dessas janelas (R29); sondas antigas não mandam. Mac: camada 0, opacas, ≥ 50×50, só na tela
  accessible: boolean;         // OpenProcess com o token do usuário funcionou (Mac: consegui ler o processo)
};
export type MemPressure = 'normal' | 'warn' | 'critical';
export type ProbeSnapshot = {
  type: 'snapshot'; t: number; memLoad: number; totalPhys: number; availPhys: number;
  foregroundPid: number | null;
  audioPids?: number[];        // pids com sessão de áudio ativa no dispositivo padrão (F-11); ausente = sonda antiga
  diskActive?: number | null;  // tempo de atividade do disco em %, como no Gerenciador de Tarefas; null na 1ª leitura
  memPressure?: MemPressure;   // só no Mac (kern.memorystatus_vm_pressure_level); ausente = sonda do Windows
  swapUsed?: number;           // bytes de swap em uso (só no Mac)
  processes: ProbeProcess[];
};
// Node → sonda
export type ProbeCommand =
  | { type: 'close'; id: string; pids: number[]; key?: string }   // WM_CLOSE em todas as janelas visíveis; Mac: terminate (Cmd+Q), key = só pid desse bundle id
  | { type: 'kill'; id: string; pids: number[] };   // só para apps em mayForceQuit (P03)
export type ProbeReply = { type: 'reply'; id: string; ok: boolean; windowsClosed: number };

// Node → interface
export type AppState = 'idle' | 'in_use' | 'protected';
export type AppReason = 'foreground' | 'audio' | 'busy' | 'recent' | 'multi_window' | 'idle'
  | 'no_window' | 'system' | 'never_close' | 'self' | 'other_session';
export type AppGroup = {
  key: string; name: string; pids: number[]; privateWorkingSet: number;
  cpuPercent: number; state: AppState; reason: AppReason;
  lastFocusedAt: number | null;   // epoch ms; null = nunca visto em primeiro plano
  windows?: number;               // janelas de topo visíveis do grupo
  parents?: { key: string; bytes: number }[];   // R36: só em 'no_window'; dono dos processos, maior primeiro
};
export type Outcome = 'fechou' | 'ficou_aberto' | 'bandeja' | 'encerrado' | 'recusado';
export type ReleaseResult = { key: string; name: string; outcome: Outcome };
export type LogEntry = {
  t: number; origin: 'manual' | 'auto'; availBefore: number; availAfter: number;
  results: ReleaseResult[];
};
export type Settings = {
  idleMinutes: number; busyCpuPercent: number; sampleSeconds: number;
  autoCareEnabled: boolean; autoCareThreshold: number; autoCareCooldownMinutes: number;
  autoCareTrigger: 'percent' | 'pressure';   // Mac: pressão; Windows e arquivo antigo: percentual
  autoCarePressure: 'warn' | 'critical';     // a partir de qual pressão dispara (modo pressure)
  neverClose: string[]; mayForceQuit: string[];
  warningsLevel: 'todos' | 'criticos'; staleDays: number; staleMinMB: number;   // v2: R27, D16
  agentProvider: AgentProvider; watchEnabled: boolean;                          // v2: D14, R30
};
export type MemoryState = {
  t: number; memLoad: number; totalPhys: number; availPhys: number;
  apps: AppGroup[]; freed: ReleaseResult[]; settings: Settings; startedAt: number;
  autoCare: { nextEligibleAt: number | null; lastRunAt: number | null };   // preenchido no F-06
  memPressure?: MemPressure; swapUsed?: number;   // só no Mac
  samples?: Sample[];   // últimos 60 s para os gráficos do Início; ausente = servidor antigo
};
export type Sample = { t: number; mem: number; disk: number | null };
```

## Mac (port de 2026-10; spec em `docs/superpowers/specs/2026-10-20-folga-mac-design.md`, ADR 0007)
```
Folga.app (Swift AppKit + WKWebView, ícone na barra, sem Xcode)  ← mac/Folga.swift, montado por scripts/mac-app.mjs
   ├─ sobe e supervisiona o servidor Node que vai DENTRO do bundle (Contents/Resources/folga/, com o próprio node)
   │     └─ src/server.ts → http://127.0.0.1:4780  (a janela WebKit aponta para ele, com o token)
   └─ probe-mac (Swift): sonda contínua, filha do servidor; mesma linha JSON da sonda C#
```
- **Dados** em `~/Library/Application Support/Folga` (mesmos arquivos do Windows); `FOLGA_DATA_DIR` sobrepõe. Gravação 0600.
- **Camada de plataforma** `src/platform.ts`: `dataDir`, `writePrivate`/`readPrivate`, `defaultSettings` (Mac: `neverClose` por
  bundle id e `autoCareTrigger: 'pressure'`), `userFolders`. `process.platform` escolhe; sem framework de plugins.
  Lógica pura (`classify`, `release`, `autocare`, `watch`) é única; as peças de sistema (`appdata.ts`, `files.ts`,
  `warnings.ts`, `notify.ts`, `window.ts`) trazem o ramo do Mac ao lado do Windows.
- **Sonda:** `probe/bin/probe-mac` (gitignored, `build-probe.mjs` escolhe `swiftc` ou `csc`). Sem `Add-Type` nem `.exe` no Mac.
- **Modos pontuais do `probe-mac`** (um processo por chamada, JSON em stdin/stdout, fora do modo contínuo):
  `--meta` (Spotlight: último uso e data de chegada, arquivo só na nuvem), `--trash` (`trashItem`, revalida o caminho no
  último instante), `--size` (soma alocada, sem seguir link), `--volume` (capacidade e "purgeable"), `--responsible`
  (quem o TCC cobra pelas leituras) e `--disclaim` (roda o CLI do assistente sem herdar permissões do app; sai 125 se
  indisponível).
- **Contrato, diferenças no Mac:** `memLoad` = (app + wired + comprimida) ÷ total, a conta do Monitor de Atividade;
  `availPhys` = total − usada (R08 usa esse número); `memPressure` vem de `kern.memorystatus_vm_pressure_level` e
  `swapUsed` de `vm.swapusage`, ambos ausentes no Windows. `privateWorkingSet` = `ri_phys_footprint`. `windowCount`
  só serve à regra de navegador com várias janelas (R29): janela minimizada ou de outro Espaço não conta. O grupo é o
  bundle (`key` = bundle id), não o nome do executável. `close` = `terminate()`; `kill` só para `mayForceQuit`.

## API (127.0.0.1:4780, `FOLGA_PORT`)
| Rota | O quê |
|---|---|
| `GET /api/token` | Devolve o token. Sem CORS, então outro site não lê a resposta; o `Host` é checado (R15). No Mac, dentro do app, só com o cookie da janela (toda `/api/` pede token; ADR 0007). |
| `GET /api/state` | `MemoryState` |
| `GET /api/events` | SSE, evento `state` a cada leitura |
| `POST /api/release` `{keys}` | `{availBefore, availAfter, results}` (R07–R09) |
| `GET /api/settings` · `PUT /api/settings` | `Settings` |
| `GET /api/log?limit=100` | `LogEntry[]`, mais novo primeiro |

Vite de desenvolvimento em `127.0.0.1:5180 --strictPort`, com proxy de `/api` para 4780.

## Armadilhas de Windows (do second-brain)
- `spawn` da sonda e do `csc.exe` com **caminho absoluto** e `shell: false`. Nada de `.cmd` sem shell.
- O caminho do usuário tem acento (`C:\Users\Antônio`): não usar `fs.cpSync` recursivo; usar
  `fs.promises.cp` ou copiar arquivo a arquivo.
- Arquivos gravados por PowerShell 5.1: `Set-Content -Encoding utf8` grava BOM. Gravar pelo Node.
- Encerrar o servidor fecha a sonda junto (`child.kill()` no `exit`/`SIGINT`). Ao matar na mão, use
  `taskkill /PID <pid> /T` e confira o `CommandLine` antes, para não derrubar outro projeto na mesma porta.
- Usar `process.exitCode = n` em vez de `process.exit()` depois de saída grande.
- Depois de reiniciar, conferir o PID dono da porta: um 200 pode vir do servidor antigo.

## Armadilhas do Mac
- O Bash do sandbox do Claude Code não enxerga os processos do usuário: sonda, `ps` e `lsof` voltam incompletos. Testar fora dele.
- O mesmo bundle id (`local.folga.mac`; era `local.folga.app`, trocado porque o macOS guardou recusa de notificação para ele, ADR 0007) registrado em duas cópias (build/ e ~/Applications) confunde o LaunchServices e as
  notificações. Manter uma só.
- Assinatura ad-hoc (ADR 0007, ramo B): o requisito é o hash do app, então depois de reinstalar o macOS pode pedir de novo
  as permissões de pasta. Cada pedido de pasta é atribuído ao `Folga.app`; quem constrói nunca responde no lugar do usuário.
- APFS não guarda hora de acesso confiável: o último uso vem do Spotlight (`kMDItemLastUsedDate`), com `kMDItemDateAdded` e
  a data de modificação de reserva (D16 no Mac).
- Matar o assistente é por grupo de processos (`detached` + `kill(-pid)`), não por árvore como o `taskkill /T`.
