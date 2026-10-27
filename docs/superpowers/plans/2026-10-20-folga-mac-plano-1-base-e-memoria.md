# Folga no Mac — Plano 1: base e memória (fases 0–3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O Folga roda no Mac com a tela Memória lendo o sistema de verdade, libera apps parados com Cmd+Q e tem Auto Care por pressão de memória — sem quebrar o Windows, provado por CI nos dois sistemas.

**Architecture:** `process.platform` escolhe o pouco que muda (pasta de dados, padrões de ajustes, binário da sonda, desfecho de liberar) num arquivo só, `src/platform.ts`, mais dois `if` pontuais. Uma sonda Swift (`probe/probe-mac.swift`) fala o MESMO contrato de linhas JSON da `probe.cs`: no Mac, `name` de processo dentro de um `.app` é o bundle id do `.app` mais de fora e `description` é o nome exibido, então `classify` agrupa por bundle sem mudar. Lógica pura (`classify`, `release`, `autocare`, `watch`) continua única.

**Tech Stack:** Node 24 (type stripping, `node:assert`), TypeScript 7 (`tsc --noEmit`), Swift 6 via `swiftc -O` das Command Line Tools (AppKit, CoreAudio, IOKit, Darwin), GitHub Actions.

**Spec:** docs/superpowers/specs/2026-10-20-folga-mac-design.md

## Global Constraints
- Nenhuma dependência npm nova; `package.json` não muda (os scripts existentes bastam).
- Só `swiftc` das Command Line Tools; nenhum `.xcodeproj`. Binário em `probe/bin/probe-mac` (já no `.gitignore` via `probe/bin/`).
- Windows intacto: todo teste que roda hoje no Windows continua rodando lá; pular só fora do Windows, com motivo impresso.
- Pasta de dados: darwin `~/Library/Application Support/Folga`; win32 `%LOCALAPPDATA%\Folga` (inalterado); `FOLGA_DATA_DIR` ganha dos dois.
- `src/types.ts` é importado pela interface (`web/src/mock.ts`): nada de `process`/`node:*` nele.
- Chaves de app são minúsculas (`appKey` e `mergeSettings` já baixam a caixa): bundle id entra como `com.apple.textedit`.
- Pressão: `kern.memorystatus_vm_pressure_level` 1 → `normal`, 2 → `warn`, 4 → `critical`.
- Memória do Mac: usada = (internal − purgeable + wired + compressor) × `host_page_size` (16384 no M2); disponível = total − usada; `memLoad` = round(usada/total × 100).
- CPU do Mac: `ri_user_time + ri_system_time` em ticks × `numer/denom` de `mach_timebase_info` (125/3 no M2) = ns; ÷ 1e6 = ms.
- Auto Care: `autoCareTrigger` padrão `percent` no win32, `pressure` no darwin; `autoCarePressure` padrão `warn`; arquivo de ajustes sem `autoCareTrigger` = `percent`.
- Liberar no Mac: `close` = `terminate()` só em `NSRunningApplication` com `activationPolicy == .regular`; `kill` = `forceTerminate()` (ou `SIGKILL` sem `NSRunningApplication`), e só chega lá pelo caminho `mayForceQuit` que já existe.
- Push só para o remoto `fork` (`vittoriofbrun-blip/folga`), nunca `origin`.
- Commits terminam com a linha `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **`null` sumindo do JSON da sonda Swift.** `JSONEncoder` omite opcional `nil`, e `foregroundPid`/`diskActive` são chaves obrigatórias do contrato (a 1ª leitura de disco é `null`). Fixado: `snapshotErrors` exige as chaves presentes (Task 3) e a sonda serializa com `JSONSerialization` + `NSNull` (Task 4).
2. **Unidade errada em CPU e memória.** Ticks tratados como ns subestimam CPU 41× (nada fica "ocupado"); páginas de 4 KB no lugar de 16 KB subestimam memória 4×. Fixado: o smoke sobe um filho `node` que gira 100 % de CPU com 200 MB preenchidos e exige 70–130 % e ≥ 190 MB (Task 4).
3. **Agrupamento por bundle furado.** Helper aninhado (`Google Chrome Helper (Renderer).app` dentro de `Google Chrome.app`) tem que somar no `.app` de fora, e o WebKit do Safari roda em `.xpc` fora do `Safari.app` — sem ligar ao Safari, o Safari tocando som vira "parado" e é encerrado (anti-objetivo). Fixado: smoke falha se algum `name` casar `/ Helper \(/` (Task 4); verificação manual de áudio no Safari (Task 5).
4. **`frontmostApplication` congelado sem run loop.** Num executável de linha de comando, `NSWorkspace` só atualiza com o `RunLoop.main` girando; sem isso o app em primeiro plano nunca muda e o app em uso vira "parado". Fixado: `probe-smoke --textedit` abre o TextEdit e exige que `foregroundPid` vire o dele (Task 5).
5. **Gatilho por pressão sem pressão.** Sonda do Windows (ou antiga) não manda `memPressure`; com `autoCareTrigger: 'pressure'` o Auto Care e o vigia têm de ficar quietos, não disparar com `undefined`. Fixado: casos em `autocare.test.ts` e `watch.test.ts` (Task 8).

---

## File Structure
- `.github/workflows/ci.yml` (novo) — CI: windows-latest + macos-latest, Node 24, `npm ci`, typecheck, testes; no macOS também compila e roda a sonda.
- `src/platform.ts` (novo) — a camada de plataforma: `dataDir()` e `defaultSettings()`.
- `src/tests/platform.test.ts` (novo) — regras da camada de plataforma.
- `scripts/contract.mjs` (novo) — `snapshotErrors`/`replyErrors`: o contrato da sonda como checagem executável.
- `src/tests/contract.test.ts` (novo) — as duas sondas falsas cumprem o contrato; quebras conhecidas são pegas.
- `probe/probe-mac.swift` (novo) — sonda do Mac.
- `scripts/build-probe.mjs` — escolhe `csc` (win32) ou `swiftc` (darwin).
- `scripts/probe-smoke.mjs` — sonda real dos dois sistemas + contrato + filho de carga + `--textedit` no Mac.
- `src/tests/fake-probe.mjs` — ganha `FAKE_MAC=1` (bundle ids, uid 501, pressão).
- `src/types.ts` — `MemPressure`, `memPressure?`/`swapUsed?` na leitura e no estado, ajustes do gatilho, chaves de sistema do Mac.
- `src/server.ts` — pasta de dados, padrões, sonda do Mac, legado = percentual, repasse da pressão.
- `src/mcp.ts`, `scripts/launch.mjs` — pasta de dados pela camada de plataforma.
- `src/release.ts` — desfecho do Mac (`ficou_aberto` no lugar de `bandeja`).
- `src/autocare.ts`, `src/watch.ts` — linha por pressão.
- `.claude/fluxo-infraestrutura.md` — bloco do contrato acompanha `types.ts`.
- Testes tocados: `files.test.ts`, `suggestions.test.ts`, `http.test.ts`, `classify.test.ts`, `release.test.ts`, `autocare.test.ts`, `watch.test.ts`, `autocare-server.test.ts`.

---

### Task 1: CI nos dois sistemas e suíte verde no Mac

**Files:** Create `.github/workflows/ci.yml` · Modify `src/tests/files.test.ts` (logo após os imports, antes do `mkdtempSync` da linha 15), `src/tests/suggestions.test.ts` (antes do `mkdtempSync` da linha 15), `src/tests/http.test.ts:146-151` (bloco P04)
**Interfaces:** Consumes: `npm test` (`scripts/test.mjs`), `npm run typecheck`. Produces: workflow `ci` com job `test` em matriz `os: [windows-latest, macos-latest]`.

- [ ] **Step 1: Write the failing test** — a suíte atual já é o teste. Hoje no Mac falham 3 suítes: `files` (R21 só aceita `C:\…`), `suggestions` (mesmo validador) e `http` (P04 cria `.lnk` pelo PowerShell).
- [ ] **Step 2: Run test to verify it fails** Run: `npm test` Expected: `14/17 suítes verdes`, `[FAIL]` em `files.test.ts`, `http.test.ts`, `suggestions.test.ts`.
- [ ] **Step 3: Implement os pulos e o workflow**
  - `files.test.ts` e `suggestions.test.ts`, primeira linha executável:
    ```ts
    if (process.platform !== 'win32') { console.log('files: pulado fora do Windows — o validador R21 só aceita caminho com letra de unidade; a versão POSIX vem no plano do armazenamento'); process.exit(0); }
    ```
    (em `suggestions.test.ts` o prefixo é `suggestions:`).
  - `http.test.ts`: só as duas linhas que ligam o atalho (`PUT … { on: true }` → `true` e `existsSync(… 'Folga.lnk')`) ficam sob `if (process.platform === 'win32')`; o GET inicial, o 403 sem token e o desligar continuam rodando nos dois.
  - `ci.yml`: `on: [push, pull_request]`; `strategy.fail-fast: false`; passos `actions/checkout@v4`, `actions/setup-node@v4` com `node-version: 24` e `cache: npm`, `npm ci`, `npm run typecheck`, `npm test`.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test` Expected: `17/17 suítes verdes`, com as linhas "pulado fora do Windows" de `files` e `suggestions`. Depois `npm ci && npm run typecheck` sem erro. Depois `git push fork mac-port` e `gh run watch --repo vittoriofbrun-blip/folga` Expected: os dois jobs verdes. Se o job do Windows falhar, PARE e leve o caso ao humano: o Windows é a referência, não se pula teste do Windows para ficar verde.
- [ ] **Step 5: Commit**
  ```bash
  git add .github/workflows/ci.yml src/tests/files.test.ts src/tests/suggestions.test.ts src/tests/http.test.ts
  git commit -m "ci: Windows e Mac a cada push; testes presos ao Windows pulam no Mac com motivo

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 2: Camada de plataforma, pasta de dados e padrões do Mac

**Files:** Create `src/platform.ts`, `src/tests/platform.test.ts` · Modify `src/server.ts:19,23,54,64,82` (import, `DATA_DIR`, `loadSettings`, `mergeSettings` continua checando `DEFAULT_SETTINGS`), `src/mcp.ts:12`, `scripts/launch.mjs:10`, `src/types.ts:154-158` (`SYSTEM_PROCESSES`), `src/tests/http.test.ts:67`, `src/tests/classify.test.ts` (caso novo no fim)
**Interfaces:** Consumes: `DEFAULT_SETTINGS`, `Settings` de `types.ts`. Produces:
`dataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string` ·
`defaultSettings(platform: NodeJS.Platform = process.platform): Settings` ·
`MAC_NEVER_CLOSE: readonly string[]`.

- [ ] **Step 1: Write the failing test** — `platform.test.ts` (estilo `caso`/`ok` dos outros):
  ```ts
  assert.equal(dataDir('darwin', {}, '/Users/v'), '/Users/v/Library/Application Support/Folga');
  assert.equal(dataDir('win32', { LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }, 'x'), join('C:\\Users\\A\\AppData\\Local', 'Folga'));
  assert.equal(dataDir('darwin', { FOLGA_DATA_DIR: '/tmp/f' }, '/Users/v'), '/tmp/f');
  assert.deepEqual(defaultSettings('win32'), DEFAULT_SETTINGS);
  const mac = defaultSettings('darwin');
  assert.deepEqual(mac.neverClose, MAC_NEVER_CLOSE);
  assert.ok(mac.neverClose.includes('com.apple.terminal') && mac.neverClose.includes('com.anthropic.claudefordesktop'));
  assert.ok(mac.neverClose.every(k => k === k.toLowerCase()));
  assert.deepEqual({ ...mac, neverClose: DEFAULT_SETTINGS.neverClose }, DEFAULT_SETTINGS);   // só neverClose muda (por ora)
  ```
  E em `classify.test.ts`, caso `'Mac: helpers somam no bundle; Dock é sistema; Terminal nunca fecha'`:
  ```ts
  const chrome = proc('com.google.Chrome', { description: 'Google Chrome', session: 501 });
  const helper = proc('com.google.Chrome', { description: 'Google Chrome', session: 501, hasVisibleWindow: false, ppid: chrome.pid });
  const r = classify(snapOf([chrome, helper, proc('com.apple.dock', { description: 'Dock', session: 501 }),
    proc('com.apple.Terminal', { description: 'Terminal', session: 501 })], T0 + 60 * MIN),
    emptyHistory(), defaultSettings('darwin'), ctxAt(T0 + 60 * MIN, { userSession: 501 }));
  assert.deepEqual(find(r, 'com.google.chrome').pids, [chrome.pid, helper.pid]);
  assert.equal(find(r, 'com.google.chrome').name, 'Google Chrome');
  assert.equal(find(r, 'com.google.chrome').state, 'idle');
  assert.equal(find(r, 'com.apple.dock').reason, 'system');
  assert.equal(find(r, 'com.apple.terminal').reason, 'never_close');
  ```
  `http.test.ts:67` passa a comparar com `defaultSettings()` (import de `../platform.ts`).
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/platform.test.ts` Expected: erro de módulo `../platform.ts` não encontrado. `node --no-warnings src/tests/classify.test.ts` Expected: falha em `reason` do Dock (`idle` ≠ `system`).
- [ ] **Step 3: Implement `dataDir`, `defaultSettings` em `src/platform.ts`** — `FOLGA_DATA_DIR` ganha; darwin = `join(home, 'Library', 'Application Support', 'Folga')`; senão `join(env.LOCALAPPDATA ?? <raiz do repo>, 'Folga')` (raiz = `join(import.meta.dirname, '..')`, o mesmo fallback que o servidor usa hoje). `MAC_NEVER_CLOSE = ['com.apple.terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'dev.warp.warp-stable', 'com.microsoft.vscode', 'com.todesktop.230313mzl4w4u92', 'com.anthropic.claudefordesktop', 'com.openai.codex', 'com.apple.dt.xcode']` (Terminal, VS Code, Claude e Codex conferidos neste Mac com `osascript -e 'id of app "X"'`; os outros são os ids públicos). `defaultSettings` devolve cópia de `DEFAULT_SETTINGS`, no darwin com `neverClose: [...MAC_NEVER_CLOSE]`. Servidor: `const DATA_DIR = dataDir()` e `const DEFAULTS = defaultSettings()` no lugar de `DEFAULT_SETTINGS` em `loadSettings` (linhas 54 e 64); `mcp.ts` e `launch.mjs` usam `dataDir()` (o `.mjs` importa `../src/platform.ts`; o Node 24 tira os tipos). `SYSTEM_PROCESSES` ganha, abaixo dos do Windows e com comentário "Mac: bundle id ou nome do executável, minúsculos": `'launchd', 'windowserver', 'com.apple.loginwindow', 'com.apple.dock', 'com.apple.finder', 'com.apple.systemuiserver', 'com.apple.controlcenter', 'com.apple.notificationcenterui', 'com.apple.spotlight', 'com.apple.windowmanager'`. Lista única de propósito (`// ponytail: nomes do Windows e do Mac não colidem; uma lista evita process.platform num arquivo que a interface importa`).
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck` Expected: `18/18 suítes verdes`, typecheck limpo.
- [ ] **Step 5: Commit**
  ```bash
  git add src/platform.ts src/tests/platform.test.ts src/server.ts src/mcp.ts scripts/launch.mjs src/types.ts src/tests/http.test.ts src/tests/classify.test.ts
  git commit -m "plataforma: pasta de dados e padrões do Mac; processos de sistema do Mac (R05)

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 3: Contrato executável e sonda falsa do Mac

**Files:** Create `scripts/contract.mjs`, `src/tests/contract.test.ts` · Modify `src/types.ts:12-18` (`ProbeSnapshot`), `src/tests/fake-probe.mjs`, `.claude/fluxo-infraestrutura.md` (bloco "Contrato")
**Interfaces:** Consumes: `ProbeSnapshot`, `ProbeReply`. Produces:
`export type MemPressure = 'normal' | 'warn' | 'critical'` e, em `ProbeSnapshot`, `memPressure?: MemPressure; swapUsed?: number` (bytes; ausente = sonda do Windows) ·
`snapshotErrors(s: unknown, opts?: { mac?: boolean; prev?: object }): string[]` · `replyErrors(r: unknown, id: string): string[]` (JS puro, sem tipos, para o smoke importar) ·
`fake-probe.mjs` com `FAKE_MAC=1` e `FAKE_PRESSURE` (`normal` padrão).

- [ ] **Step 1: Write the failing test** — `contract.test.ts`: sobe `fake-probe.mjs` duas vezes (padrão e `FAKE_MAC=1`, `FAKE_INTERVAL_MS=50`), lê 2 snapshots de cada e:
  ```ts
  assert.deepEqual(snapshotErrors(win2, { prev: win1 }), []);
  assert.deepEqual(snapshotErrors(mac2, { mac: true, prev: mac1 }), []);
  assert.ok(mac2.processes.some(p => p.name === 'com.google.Chrome' && !p.hasVisibleWindow));   // helper
  // quebras conhecidas
  const { foregroundPid, ...semFg } = mac2;
  assert.match(snapshotErrors(semFg, { mac: true }).join('\n'), /foregroundPid/);
  assert.match(snapshotErrors({ ...mac2, memLoad: 5 }, { mac: true }).join('\n'), /memLoad/);
  assert.match(snapshotErrors({ ...mac2, memPressure: 'amarelo' }, { mac: true }).join('\n'), /memPressure/);
  assert.match(snapshotErrors({ ...win2, processes: [{ ...win2.processes[0], windowCount: 0, hasVisibleWindow: true }] }).join('\n'), /windowCount/);   // Windows: janela = windowCount > 0
  assert.deepEqual(snapshotErrors({ ...mac2, processes: mac2.processes.map(p => p.name === 'com.apple.Preview' ? { ...p, windowCount: 0, hasVisibleWindow: true } : p) }, { mac: true }), []);   // Mac: app do Dock sem janela é válido
  assert.match(snapshotErrors(mac2, { mac: true, prev: { ...mac1, processes: mac1.processes.map(p => ({ ...p, cpuTimeMs: p.cpuTimeMs + 1e9 })) } }).join('\n'), /cpuTimeMs/);
  assert.match(snapshotErrors(win2, { mac: true }).join('\n'), /memPressure/);   // sonda do Windows não passa como Mac
  assert.deepEqual(replyErrors({ type: 'reply', id: 'a', ok: true, windowsClosed: 0 }, 'a'), []);
  assert.match(replyErrors({ type: 'reply', id: 'b', ok: true }, 'a').join('\n'), /id|windowsClosed/);
  ```
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/contract.test.ts` Expected: erro de módulo `scripts/contract.mjs` não encontrado.
- [ ] **Step 3: Implement `snapshotErrors`, `replyErrors` em `scripts/contract.mjs`** — uma mensagem por regra violada:
  `type === 'snapshot'`; `t` inteiro a menos de 60 s de `Date.now()`; `totalPhys` inteiro > 0; `0 < availPhys < totalPhys`; `memLoad` inteiro 0–100 e a ±2 de `100 × (total − avail) / total`; chave `foregroundPid` presente, `null` ou inteiro; `diskActive`, se presente, `null` ou 0–100; `audioPids`, se presente, array de inteiros; `processes` array não vazio, `pid` inteiro > 0 e único, `ppid` inteiro ≥ 0, `name` string não vazia, `description` string, `session` inteiro, `privateWorkingSet` e `cpuTimeMs` ≥ 0, `hasVisibleWindow` e `accessible` booleanos, `windowCount` se presente inteiro ≥ 0; sem `mac`, `hasVisibleWindow === windowCount > 0` (no Mac `hasVisibleWindow` quer dizer "app do Dock" e pode valer com 0 janelas — decisão do Vittorio, 2026-10-20). Com `mac`: chaves `diskActive` e `audioPids` presentes, `memPressure` em `normal|warn|critical`, `swapUsed` ≥ 0, `windowCount` presente em todo processo. Com `prev`: para cada pid nos dois, `cpuTimeMs` não diminui e o delta ≤ `(t − prev.t) × nº de núcleos × 1,1`.
  `fake-probe.mjs` com `FAKE_MAC=1`: mesmos mecanismos (stdin, `close`/`kill`, avail cresce), processos `session: 501` com `windowCount`: os dois `node` do teste (sem janela), `com.apple.TextEdit`/"TextEdit" (janela), `com.apple.Preview`/"Preview" (app do Dock com 0 janelas: `windowCount: 0`, `hasVisibleWindow: true`, parado, CPU zero), `com.example.menubar`/"Barra" (`windowCount: 0`, `hasVisibleWindow: false`), `com.google.Chrome`/"Google Chrome" principal (janela) + helper (sem janela, `ppid` = principal), `com.apple.dock`/"Dock" (janela), `com.apple.Terminal`/"Terminal" (janela), `launchd` pid 1 `session: 0` `accessible: false`; snapshot com `diskActive: null`, `audioPids: []`, `memPressure: process.env.FAKE_PRESSURE ?? 'normal'`, `swapUsed: 2 GB`, total 8 GB. No `close` do modo Mac, fechar um pid com janela tira também os outros processos de mesmo `name` (Cmd+Q leva os helpers). Sem `FAKE_MAC` o comportamento atual não muda.
  Contrato em `fluxo-infraestrutura.md`: as duas linhas novas de `ProbeSnapshot` e o `MemPressure`, iguais a `types.ts`.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck` Expected: `19/19 suítes verdes`.
- [ ] **Step 5: Commit**
  ```bash
  git add scripts/contract.mjs src/tests/contract.test.ts src/types.ts src/tests/fake-probe.mjs .claude/fluxo-infraestrutura.md
  git commit -m "contrato da sonda como checagem executável; sonda falsa do Mac

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 4: Sonda do Mac — memória e processos

**Files:** Create `probe/probe-mac.swift` · Modify `scripts/build-probe.mjs` (todo), `scripts/probe-smoke.mjs` (todo)
**Interfaces:** Consumes: contrato (`types.ts`), `snapshotErrors`/`replyErrors`. Produces: `probe/bin/probe-mac --interval N [--debug]`, mesmas mensagens da `probe.cs`.

- [ ] **Step 1: Write the failing test** — `probe-smoke.mjs` passa a ser dos dois sistemas: darwin roda `probe/bin/probe-mac --interval 1`; win32 fica como está. Antes de subir a sonda, sobe um filho de carga:
  `spawn(process.execPath, ['-e', 'const b = Buffer.alloc(200e6, 1); for (;;) b[0]++'])`. Depois de 3 snapshots:
  ```js
  for (const [i, s] of snaps.entries()) { const e = snapshotErrors(s, { mac: isMac, prev: snaps[i - 1] }); if (e.length) fail(e.join('; ')); }
  const a = snaps[1].processes.find(p => p.pid === load.pid), b = snaps[2].processes.find(p => p.pid === load.pid);
  const cpu = (b.cpuTimeMs - a.cpuTimeMs) / (snaps[2].t - snaps[1].t) * 100;
  if (cpu < 70 || cpu > 130) fail(`CPU do filho de carga ${cpu.toFixed(0)} % (esperado ~100): unidade errada?`);
  if (b.privateWorkingSet < 190e6) fail(`memória do filho de carga ${b.privateWorkingSet} < 190 MB: unidade errada?`);
  if (isMac) { const h = s.processes.find(p => / Helper \(/.test(p.name)); if (h) fail(`helper fora do bundle: ${h.name}`); }
  ```
  e no fim `replyErrors` no reply do `close` vazio, mata o filho de carga, e imprime `memPressure`/`swapUsed` no Mac. O resumo "top 10" continua (no Mac a soma por `name` já é por bundle).
- [ ] **Step 2: Run test to verify it fails** Run: `node scripts/build-probe.mjs` Expected: "csc.exe nao encontrado" (exit 1). `node scripts/probe-smoke.mjs` Expected: `FALHOU` (spawn de `probe-mac` inexistente).
- [ ] **Step 3: Implement `probe/probe-mac.swift`** (leitura e protocolo; janelas, foco, áudio e disco ficam `false`/`0`/`null`/`[]` até a Task 5) e o ramo darwin de `build-probe.mjs`: `spawnSync('/usr/bin/xcrun', ['swiftc', '-O', src, '-o', out])` (sem `xcrun`: "instale as Command Line Tools: xcode-select --install"); win32 segue o `csc` de hoje.
  - Protocolo: `signal(SIGPIPE, SIG_IGN)`; uma `Thread` lê `readLine()` e manda cada linha ao `DispatchQueue.main`; EOF → `exit(0)`. Snapshot por `Timer` de `interval` s no `RunLoop.main` (mais um logo no início); `RunLoop.main.run()`. Saída: `JSONSerialization` com `NSNull()` para `nil` (mantém a chave) + `"\n"`, por `fputs`; `fflush(stdout) == EOF` → `exit(0)`. Toda escrita no main, então sem trava. Comando sem `id` é ignorado; `type`/`pids` inválidos → `reply ok:false`; nesta task `close`/`kill` respondem `ok:true, windowsClosed:0` sem agir.
  - Memória: `host_statistics64(HOST_VM_INFO64)`, `host_page_size`, `ProcessInfo.physicalMemory`, `sysctlbyname("kern.memorystatus_vm_pressure_level")` e `("vm.swapusage")` → fórmulas das Global Constraints.
  - Processos: `proc_listallpids`; por pid `proc_pidinfo(PROC_PIDTBSDINFO)` → `ppid`, `session` = `pbi_uid`; `proc_pidpath`; `proc_pid_rusage(RUSAGE_INFO_V4)` → `privateWorkingSet = ri_phys_footprint`, `cpuTimeMs` pela conversão das Global Constraints, `accessible` = rusage deu 0 (senão 0/0/false). Pid que some no meio é pulado.
  - Dono (cache por caminho do `.app`, vive entre leituras):
    ```swift
    // o .app mais de fora: o primeiro ".app/" do caminho (helpers moram em .app dentro do .app)
    if let r = path.range(of: ".app/") { let app = String(path[..<r.lowerBound]) + ".app"
      name = Bundle(path: app)?.bundleIdentifier ?? basename(app) sem ".app"
      description = NSRunningApplication.runningApplications(withBundleIdentifier: name).first?.localizedName
                    ?? FileManager.default.displayName(atPath: app) sem ".app" }
    else if path.contains(".xpc/"), let rp = responsible(pid), rp != pid, caminho de rp tem ".app/" { dono = o de rp }
    else { name = basename(path) (ou proc_name se o caminho veio vazio); description = "" }
    ```
    `responsible` = `responsibility_get_pid_responsible_for_pid` por `dlsym(dlopen(nil, RTLD_NOW), …)`; sem o símbolo, devolve `nil` (`// ponytail: API privada, a mesma que o Monitor de Atividade usa; só para .xpc (WebKit do Safari). Sem ela o Safari aparece sem os processos de página.`).
- [ ] **Step 4: Run test to verify it passes** Run: `node scripts/build-probe.mjs && node scripts/probe-smoke.mjs` Expected: `ok: …/probe/bin/probe-mac`, depois o resumo com o filho de carga dentro da faixa e `OK`. Confira à mão: `memLoad`/disponível batem com "Memória usada" do Monitor de Atividade a ±0,3 GB; Chrome (ou Claude) aparece uma vez só no top 10, pelo bundle id. `npm test` continua verde.
- [ ] **Step 5: Commit**
  ```bash
  git add probe/probe-mac.swift scripts/build-probe.mjs scripts/probe-smoke.mjs
  git commit -m "sonda do Mac: memória honesta, pressão, swap e processos agrupados por bundle

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 5: Sonda do Mac — janelas, primeiro plano, áudio e disco

**Files:** Modify `probe/probe-mac.swift`, `scripts/probe-smoke.mjs` (flag `--textedit`)
**Interfaces:** Consumes: o snapshot da Task 4. Produces: `hasVisibleWindow`, `windowCount`, `foregroundPid`, `audioPids`, `diskActive` reais; `node scripts/probe-smoke.mjs --textedit` (só darwin).

- [ ] **Step 1: Write the failing test** — com `--textedit`, o smoke roda `spawn('/usr/bin/open', ['-a', 'TextEdit'])`, espera até 10 s um snapshot em que `foregroundPid` é de um processo com `name.toLowerCase() === 'com.apple.textedit'`, `hasVisibleWindow === true` e `windowCount >= 1`; senão `fail('primeiro plano ou janela do TextEdit não apareceu')`. Sem a flag, o smoke também exige `snaps[0].diskActive === null` e `typeof snaps[2].diskActive === 'number'` no Mac.
- [ ] **Step 2: Run test to verify it fails** Run: `node scripts/build-probe.mjs && node scripts/probe-smoke.mjs --textedit` Expected: `FALHOU: primeiro plano ou janela do TextEdit não apareceu`.
- [ ] **Step 3: Implement os quatro campos em `probe/probe-mac.swift`**
  - Janelas: `CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID)`, conta por `kCGWindowOwnerPID` as de `kCGWindowLayer == 0`, `kCGWindowAlpha > 0` e `kCGWindowBounds` com largura e altura ≥ 50 (`.optionAll` mantém minimizada e de outro Espaço, como o Windows conta; o filtro de tamanho tira janela-fantasma). Sem título: não pede Gravação de Tela. `windowCount` = essa conta; `hasVisibleWindow = activationPolicy == .regular` no processo principal do bundle (o pid do `NSRunningApplication`), `false` nos helpers. **Decisão do Vittorio (2026-10-20):** app do Dock sem nenhuma janela e parado pode ser encerrado com Cmd+Q — é o desperdício de memória mais comum no Mac. App de barra de menus/agente (`.accessory`/`.prohibited`) segue "sem janela" → protegido (P03). Consequência: no Mac `mayForceQuit` só alcança app sem bandeira `.regular`, que já é protegido — forçar fica, na prática, desligado no Mac nesta fase.
  - Primeiro plano: `NSWorkspace.shared.frontmostApplication?.processIdentifier` (depende do `RunLoop.main` da Task 4).
  - Áudio: `kAudioHardwarePropertyProcessObjectList` no `kAudioObjectSystemObject`; por objeto, `kAudioProcessPropertyPID` e `kAudioProcessPropertyIsRunningOutput` ≠ 0 → pid na lista (`if #available(macOS 14.4, *)`, senão `[]`).
  - Disco: `IOServiceGetMatchingServices(…, IOServiceMatching("IOBlockStorageDriver"))`, `"Statistics"` → `"Total Time (Read)" + "Total Time (Write)"` (ns) por driver; `diskActive` = maior `Δns / Δrelógio_ns × 100` entre os drivers, limitado a 0–100; 1ª leitura `null`.
- [ ] **Step 4: Run test to verify it passes** Run: `node scripts/build-probe.mjs && node scripts/probe-smoke.mjs --textedit && node scripts/probe-smoke.mjs` Expected: `OK` nas duas. À mão: minimize o TextEdit e rode de novo sem a flag — ele segue com `hasVisibleWindow: true`; feche a janela dele no botão vermelho (o app fica no Dock) — segue `hasVisibleWindow: true` com `windowCount: 0`; toque um vídeo no Safari, troque de app e confira no smoke que um pid de `audioPids` tem `name` `com.apple.safari` (Review Focus 3).
- [ ] **Step 5: Commit**
  ```bash
  git add probe/probe-mac.swift scripts/probe-smoke.mjs
  git commit -m "sonda do Mac: janelas sem Gravação de Tela, primeiro plano, áudio e disco

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 6: Servidor sobe a sonda do Mac — tela Memória só leitura

**Files:** Modify `src/server.ts:161-171` (`probeArgs`), `scripts/launch.mjs` (checagem do binário), `.github/workflows/ci.yml` (passo do macOS)
**Interfaces:** Consumes: `probe/bin/probe-mac`, `IS darwin`. Produces: `probeArgs()` devolve `[join(ROOT, 'probe', 'bin', 'probe-mac'), ['--interval', interval]]` no darwin.

- [ ] **Step 1: Write the failing test** — passo novo no `ci.yml`, só `if: runner.os == 'macOS'`: `node scripts/build-probe.mjs && node scripts/probe-smoke.mjs`. E a verificação ao vivo: `npm run build && npm start` e `curl -s http://127.0.0.1:4780/api/state | node -e "const s=JSON.parse(require('fs').readFileSync(0));console.log(s.memLoad,s.apps.length,s.apps.filter(a=>a.reason==='system').map(a=>a.key))"`.
- [ ] **Step 2: Run test to verify it fails** Run: o `curl` acima com o servidor de pé Expected: falha de parse (sem leitura: o servidor tenta `powershell.exe` e não há estado).
- [ ] **Step 3: Implement o ramo darwin de `probeArgs` em `src/server.ts`** — antes do caminho do PowerShell: `if (process.platform === 'darwin') return [join(ROOT, 'probe', 'bin', 'probe-mac'), ['--interval', interval]];` (o `FOLGA_FAKE_PROBE` continua ganhando, então os testes não mudam). `launch.mjs`: no darwin, sem `probe/bin/probe-mac`, sai com "sonda do Mac não compilada: rode npm run build:probe", como já faz com o `dist`.
- [ ] **Step 4: Run test to verify it passes** Run: o `curl` acima Expected: `memLoad` igual ao do smoke ±2, dezenas de apps, `system` contendo `com.apple.dock` e `com.apple.finder`. Abra `http://127.0.0.1:4780` no Safari: a tela Memória lista apps por nome exibido (Google Chrome, TextEdit), parados/em uso/protegidos coerentes; NÃO clique em liberar (fase só leitura). `node scripts/footprint.mjs --minutes 2` Expected: Node + sonda ≤ 120 MB (reporte o número). `npm test` verde; `git push fork mac-port` e os dois jobs da CI verdes, com o smoke no macOS.
- [ ] **Step 5: Commit**
  ```bash
  git add src/server.ts scripts/launch.mjs .github/workflows/ci.yml
  git commit -m "servidor sobe a sonda Swift no Mac; CI do macOS compila e confere a sonda

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 7: Liberar com Cmd+Q

**Files:** Modify `probe/probe-mac.swift` (comandos), `src/release.ts:8-16,62-73`, `src/tests/release.test.ts` (casos novos), `scripts/probe-smoke.mjs` (`--textedit` fecha)
**Interfaces:** Consumes: `ReleaseDeps`. Produces: `ReleaseDeps.platform?: NodeJS.Platform` (padrão `process.platform`); no darwin, vivo depois do prazo = `ficou_aberto` (com ou sem janela), e só `!hasWindow && mayForceQuit.includes(key)` manda `kill` → `encerrado`.

- [ ] **Step 1: Write the failing test** — em `release.test.ts`, `setup` aceita `platform` e repassa a `createReleaser`; caso `'Mac: quem não saiu fica aberto; forçar só sem janela e em mayForceQuit'`:
  ```ts
  const before = mem([app('com.apple.textedit', [1]), app('com.apple.preview', [2]), app('com.spotify.client', [3, 4]), app('com.tinyapp', [5])], 200);
  const after = mem([app('com.apple.preview', [2]), app('com.spotify.client', [3], { state: 'protected', reason: 'no_window' }),
    app('com.tinyapp', [5], { state: 'protected', reason: 'no_window' })], 250);
  const { sent, releaser } = setup(before, after, mem(after.apps, 300), { ...DEFAULT_SETTINGS, mayForceQuit: ['com.tinyapp', 'com.apple.preview'] }, 'darwin');
  const r = await releaser.release(['com.apple.textedit', 'com.apple.preview', 'com.spotify.client', 'com.tinyapp'], 'manual');
  assert.deepEqual(r.results.map(x => [x.key, x.outcome]), [['com.apple.textedit', 'fechou'], ['com.apple.preview', 'ficou_aberto'],
    ['com.spotify.client', 'ficou_aberto'], ['com.tinyapp', 'encerrado']]);
  assert.deepEqual(sent.filter(c => c.type === 'kill'), [{ type: 'kill', pids: [5] }]);   // Preview tem janela: nunca forçado
  ```
  e os casos de `bandeja` já existentes passam a chamar `setup(…, 'win32')` explicitamente (o resultado do Windows não pode depender de onde o teste roda).
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/release.test.ts` Expected: no Mac, `deepEqual` falha com `bandeja` no lugar de `ficou_aberto` para o Spotify.
- [ ] **Step 3: Implement** — `release.ts`: `const mac = (deps.platform ?? process.platform) === 'darwin'`; `outcome = hasWindow || mac ? 'ficou_aberto' : 'bandeja'`; a condição do `kill` vira `!hasWindow && settings.mayForceQuit.includes(g.key)` (no Windows é a mesma de antes; falha do `kill` mantém o desfecho anterior). Sonda: `close` chama `terminate()` em cada `NSRunningApplication(processIdentifier:)` com `activationPolicy == .regular` (helpers e apps de barra de menus nunca; ADR 0003 no Mac = Cmd+Q) e responde `windowsClosed` = quantos `terminate()` devolveram `true`; `kill` chama `forceTerminate()` onde houver `NSRunningApplication` e `kill(pid, SIGKILL)` no resto, `ok` = todos deram certo. No smoke, `--textedit` termina mandando `close` com os pids do TextEdit e exige `windowsClosed === 1` e o pid fora da lista em até 8 s.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test` Expected: verde. `node scripts/build-probe.mjs && node scripts/probe-smoke.mjs --textedit` Expected: `OK` e o TextEdit saiu. À mão, pela interface: TextEdit com texto não salvo, aguarde ficar parado (ou `FOLGA_STARTED_AT` no passado), liberar → o TextEdit pergunta se salva; com a pergunta aberta o registro mostra `ficou_aberto`; nada é forçado.
- [ ] **Step 5: Commit**
  ```bash
  git add probe/probe-mac.swift src/release.ts src/tests/release.test.ts scripts/probe-smoke.mjs
  git commit -m "liberar no Mac é Cmd+Q; quem não sai fica aberto e forçar segue opt-in (ADR 0003)

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 8: Auto Care e vigia por pressão de memória

**Files:** Modify `src/types.ts` (`Settings`, `DEFAULT_SETTINGS`, `MemoryState`), `src/platform.ts` (`defaultSettings`), `src/server.ts:54,74-76,141-146` (legado, `ENUMS`, repasse), `src/autocare.ts:8-12`, `src/watch.ts:32-43`, `.claude/fluxo-infraestrutura.md` (contrato) · Test `src/tests/autocare.test.ts`, `src/tests/watch.test.ts`, `src/tests/platform.test.ts`, `src/tests/autocare-server.test.ts`
**Interfaces:** Consumes: `MemPressure`, `snap.memPressure`. Produces:
`Settings.autoCareTrigger: 'percent' | 'pressure'`, `Settings.autoCarePressure: 'warn' | 'critical'`; `MemoryState.memPressure?: MemPressure`, `MemoryState.swapUsed?: number` ·
`export function pressureAtLeast(p: MemPressure | undefined, min: MemPressure): boolean` (em `autocare.ts`) ·
`decide(mem, state: Pick<MemoryState, 'memLoad' | 'apps' | 'memPressure'>, settings, now)`.

- [ ] **Step 1: Write the failing test**
  `autocare.test.ts`:
  ```ts
  const pr: Settings = { ...on, autoCareTrigger: 'pressure', autoCarePressure: 'warn', autoCareThreshold: 99 };
  const at = (p?: MemPressure) => ({ memLoad: 60, apps, memPressure: p });
  assert.deepEqual(decide(decide(emptyAutoCare(), at('warn'), pr, 0).mem, at('critical'), pr, 1).keys, ['calc', 'notepad']);
  assert.equal(decide(decide(emptyAutoCare(), at('normal'), pr, 0).mem, at('normal'), pr, 1).keys, null);
  assert.equal(decide(decide(emptyAutoCare(), at(), pr, 0).mem, at(), pr, 1).keys, null);              // sem pressão: quieto
  assert.equal(decide(decide(emptyAutoCare(), at('warn'), { ...pr, autoCarePressure: 'critical' }, 0).mem, at('warn'), { ...pr, autoCarePressure: 'critical' }, 1).keys, null);
  assert.equal(pressureAtLeast(undefined, 'warn'), false);
  assert.equal(pressureAtLeast('critical', 'warn'), true);
  ```
  `watch.test.ts`: `memoryPlan({ ...mem(10, [app('chrome', 900)]), memPressure: 'warn' }, set({ autoCareTrigger: 'pressure' }))` não é `null` (memLoad baixo não importa); com `memPressure: 'normal'` e com ele ausente (`mem(99, …)`) é `null`; no modo `percent` nada muda.
  `platform.test.ts`: `defaultSettings('darwin').autoCareTrigger === 'pressure'`, `defaultSettings('win32').autoCareTrigger === 'percent'`, os dois com `autoCarePressure === 'warn'`; o `deepEqual` do darwin da Task 2 passa a ignorar também `autoCareTrigger`.
  `autocare-server.test.ts`: o `settings.json` passa a ser escrito sem os campos novos (`const { autoCareTrigger, autoCarePressure, ...legado } = DEFAULT_SETTINGS`) e o teste confere `GET /api/settings` → `autoCareTrigger === 'percent'` (legado = percentual, também no Mac). Um segundo servidor (porta própria, mesmas variáveis do primeiro, incluindo `FOLGA_STARTED_AT` há 2 h, mais `FAKE_MAC=1` e `FAKE_PRESSURE=warn`; ajustes `{ ...DEFAULT_SETTINGS, autoCareEnabled: true, autoCareTrigger: 'pressure', autoCarePressure: 'warn', autoCareThreshold: 99 }`) tem de rodar sozinho uma vez com `origin: 'auto'`, `results` ordenados por chave iguais a `[['com.apple.textedit', 'fechou'], ['com.google.chrome', 'fechou']]`, e `/api/state` com `memPressure === 'warn'`.
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/autocare.test.ts` Expected: erro de exportação `pressureAtLeast`; `npm run typecheck` Expected: `autoCareTrigger` não existe em `Settings`.
- [ ] **Step 3: Implement**
  - `types.ts`: os dois campos em `Settings` e em `DEFAULT_SETTINGS` (`'percent'`, `'warn'`); `memPressure?`/`swapUsed?` em `MemoryState`. `platform.ts`: darwin também com `autoCareTrigger: 'pressure'`.
  - `server.ts`: `ENUMS` ganha `autoCareTrigger: ['percent', 'pressure']` e `autoCarePressure: ['warn', 'critical']`; `loadSettings` faz `mergeSettings({ ...DEFAULTS, autoCareTrigger: 'percent' }, …)` com o comentário "arquivo sem o campo é de antes do Mac: percentual, sem migração (spec)"; o estado leva `memPressure: snap.memPressure, swapUsed: snap.swapUsed`.
  - `autocare.ts`: `RANK = { normal: 0, warn: 1, critical: 2 }`; `pressureAtLeast` = `p !== undefined && RANK[p] >= RANK[min]`; em `decide`, a condição "acima da linha" vira `settings.autoCareTrigger === 'pressure' ? pressureAtLeast(state.memPressure, settings.autoCarePressure) : state.memLoad >= settings.autoCareThreshold`. O resto (duas leituras, freio, só parados) não muda.
  - `watch.ts` `memoryPlan`: no modo `pressure` a linha é `pressureAtLeast(state.memPressure, 'warn')` (equivalente à R30 no Mac: propõe já na amarela, antes ou junto do Auto Care); no `percent`, `memoryLine` como hoje.
  - Contrato em `fluxo-infraestrutura.md`: os campos novos de `Settings` e `MemoryState`.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck` Expected: tudo verde. Ao vivo no Mac (pressão hoje em `warn`): `curl -s http://127.0.0.1:4780/api/state` mostra `memPressure` e `swapUsed`; com Auto Care ligado por `PUT /api/settings`, o registro ganha uma linha `auto` e o freio de 10 min segura a próxima. `git push fork mac-port` → os dois jobs verdes.
- [ ] **Step 5: Commit**
  ```bash
  git add src/types.ts src/platform.ts src/server.ts src/autocare.ts src/watch.ts .claude/fluxo-infraestrutura.md src/tests/autocare.test.ts src/tests/watch.test.ts src/tests/platform.test.ts src/tests/autocare-server.test.ts
  git commit -m "Auto Care e vigia por pressão de memória no Mac; ajuste antigo segue percentual

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

**Fica para os próximos planos (sem pintar o canto):** validador POSIX do R21 e as raízes do Mac (destrava `files`/`suggestions` no Mac — remover os dois pulos da Task 1), `systemDisk`/avisos do Mac, interface mostrando o gatilho por pressão (hoje `AutoCare.tsx` mostra só o percentual), `startup` por LaunchAgent (destrava o bloco P04 do `http.test`), janela WebKit e `footprint` com o app de barra.
