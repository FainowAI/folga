# Folga no Mac — Plano 3: app na barra de menus (fase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Decisão 17 (2026-10-21, depois da revisão de segurança da Task 11): o Folga NÃO pede Acesso Total ao Disco.**
> Vale por cima deste plano: a Task 5 (menu "Liberar acesso ao disco…", painel dos Ajustes, `fdaNote(true)` com o
> caminho) foi desfeita; a nota é uma só ("o macOS protege esta pasta e o Folga não pede essa permissão"), e se a
> permissão aparecer ligada o menu e o `server.log` avisam para desligar (só texto). Os passos "o Vittorio liga o
> Folga no Acesso Total ao Disco" (Tasks 1, 5, 6 e 10) não existem mais. O `--disclaim` da Task 6 fica como defesa
> em profundidade. Motivo, o que se perde e o resíduo do `GET /api/token`: ADR 0007, seção "Acesso Total ao Disco:
> não pedido".

**Goal:** O Vittorio abre o `Folga.app` (em `~/Applications`, instalado por um comando que o controlador roda), vê memória e disco num texto curto na barra de menus, abre a mesma interface React numa janela WebKit, libera os apps parados pelo menu com uma confirmação, e libera o Acesso Total ao Disco **para o `Folga.app`** — com a Lixeira, o cache do Safari e o iCloud Drive passando a ser lidos — sem que o `node` solto, o Terminal ou o assistente ganhem essa permissão, e sem quebrar o Windows.

**Architecture:** Um binário Swift novo, `mac/Folga.swift` (AppKit + WebKit, `swiftc`, sem Xcode), montado num `.app` por `scripts/mac-app.mjs`. O `.app` leva dentro uma cópia do servidor (`Contents/Resources/folga/`: `src/`, `dist/`, `probe/bin/probe-mac`, `package.json`) e o caminho absoluto do `node` gravado na hora do build (`folga.json`), então não depende do `PATH` nem do que outra sessão deixou no repositório. O app é o **processo responsável** (TCC) pelo `node` e pela sonda que ele sobe: o Acesso Total ao Disco dado ao `Folga.app` vale para a árvore dele e para nenhum `node` de fora. O assistente (`claude`/`codex`) é lançado por `probe-mac --disclaim`, que corta essa herança. O token chega à página como hoje (`GET /api/token`, mesma origem); o app não injeta nada na página e a página não fala com o app. "Liberar parados" do menu usa a mesma `POST /api/release` com token que o botão da tela. Abrir com o Mac é um LaunchAgent escrito pelo Node (R33), desligado por padrão (P04). Avisos saem pelo próprio app (`Folga --notify`, `UNUserNotificationCenter`) com `osascript` de reserva.

**Tech Stack:** Swift 6 via `swiftc -O` (AppKit, WebKit, UserNotifications), `codesign`/`security`/`openssl` do sistema, Node 24 (type stripping, `node:assert`), TypeScript 7, React (Vite), GitHub Actions (windows-latest + macos-latest).

**Spec:** docs/superpowers/specs/2026-10-20-folga-mac-design.md (seções "Janela e ícone na barra", "Notificações", pegada; decisões 5 e 10; "Chamadas minhas")

## Global Constraints
- Nenhuma dependência npm nova; `package.json` não muda. Só `swiftc`; nenhum `.xcodeproj`. O app mora em `mac/Folga.swift` (um arquivo); a sonda continua em `probe/probe-mac.swift`.
- Windows intacto: toda mudança no Node é `if (process.platform === 'darwin')` ou atrás de `FOLGA_APP=1`; a CI dos dois sistemas é a prova.
- **Acesso Total ao Disco nunca para o `node`, o Terminal ou o servidor solto** (decisão 10). Nenhum texto, script ou ADR manda liberar outra coisa que não o `Folga.app`. O caminho dos Ajustes do Sistema só aparece quando o servidor roda dentro do app (`FOLGA_APP=1`); fora dele, a nota manda abrir pelo app.
- Aviso do macOS (Acesso Total ao Disco, notificações, item de segundo plano, chaveiro): quem constrói **nunca clica no lugar do Vittorio**. Apareceu → anota no relatório e segue; o que depende da resposta vira passo do controlador.
- **Login real intocado:** nada escreve em `~/Library/LaunchAgents` de verdade nem chama `launchctl` durante a construção. Teste de abrir com o Mac só com `FOLGA_STARTUP_DIR` em pasta `mktemp -d`; ligar de verdade e fazer logout/login é passo do controlador com o Vittorio.
- **Liberar ao vivo nunca fecha app real do Vittorio:** a confirmação do menu só é aceita se listar apenas o app de teste (TextEdit sem documento); listou outro → Cancelar e anotar.
- O sandbox do Bash esconde outros processos: `pgrep`, `ps`, `lsof` e as medições de pegada rodam com o sandbox desligado.
- Token: nunca em URL, argv, log ou `UserDefaults`. O app o lê como a interface lê (`GET /api/token`) só na hora do POST, e não guarda.
- Push só para o remoto `fork`. Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Janela virando porta.** Uma navegação para fora de `http://127.0.0.1:<porta>` (link, `window.open`, redirecionamento, `file://`, `127.0.0.1.evil.com`) poria uma página de fora dentro da janela do Folga (cara de Folga, pedindo coisas ao Vittorio); uma ponte JS→Swift daria a qualquer script da página o próprio app. Fixado: `allowedURL` testado no `Folga --selftest` com esses casos, e nenhum `WKScriptMessageHandler`/`addUserScript` no app (Task 3).
2. **Acesso Total ao Disco vazando.** Para o `node` de fora (texto de tela mandando liberar o Terminal) e, dentro do app, para o `codex` em modo só-leitura, que lê qualquer arquivo que o processo responsável lê. Fixado: pino do plano 2 mantido e estendido a `mac/`, `fdaNote(false)` sem caminho dos Ajustes (Task 5); `disclaimed()` em `agent.test.ts` e o smoke exigindo que `--disclaim` torne o filho responsável por si mesmo (Task 6).
3. **Assinatura que qualquer um imita.** Requisito designado só com `identifier "local.folga.app"` mantém a permissão entre builds, mas deixa qualquer binário ad-hoc com esse id herdar o Acesso Total ao Disco. Fixado: `requirementWeak()` em `macapp.test.ts` e `mac-app.mjs check` recusando requisito sem `certificate leaf`/`cdhash` em todo ramo (Task 1).
4. **Supervisão que deixa lixo ou mata o que não é dela.** Servidor órfão segurando a porta depois de o app cair, laço de reinício infinito, `Sair` matando processo alheio por pid reaproveitado, app adotando ou derrubando outro programa na 4780. Fixado: servidor com `FOLGA_APP=1` sai quando o stdin fecha (`app-host.test.ts`), `nextDelay` no `--selftest`, e verificação ao vivo de `kill -9`, porta ocupada e `Sair` (Task 2).
5. **"Liberar parados" por fora do caminho de sempre.** O menu fechando app em uso, protegido ou em primeiro plano, ou sem o token. Fixado: `idleApps` no `--selftest` (só `state == "idle"`), confirmação com a lista, `POST /api/release` com token revalidado pelo `releaser`, e o 403 sem token no `http.test.ts` continua de pé (Task 4).
6. **Abrir com o Mac ligado sozinho ou mexendo no login real.** Fixado: `GET /api/startup` → `on: false` num servidor novo, plist só com `FOLGA_APP=1` e caminho `.app` absoluto, XML escapado, testado em pasta temporária no `http.test.ts` (Task 7).

---

## File Structure
- `mac/Folga.swift` (novo) — o app: modos `--version`, `--selftest`, `--notify`; item da barra, menu, janela `WKWebView`, supervisor do servidor, checagem do Acesso Total ao Disco.
- `scripts/mac-app.mjs` (novo) — `build [--adhoc]`, `check`, `install`, `uninstall`; identidade local de assinatura; exporta `requirementWeak`.
- `src/tests/macapp.test.ts` (novo) — `requirementWeak`, roda nos dois sistemas.
- `src/tests/app-host.test.ts` (novo) — servidor dentro do app: stdin fechado encerra, processos do bundle contam como o próprio Folga.
- `probe/probe-mac.swift` — modos `--responsible` e `--disclaim`.
- `src/server.ts` — `FOLGA_APP`: fim do stdin encerra, self inclui o bundle, linha de log do acesso ao disco, `/api/startup` com `available`, janela no Mac.
- `src/files.ts` — `fdaNote()` no lugar da `FDA_NOTE` fixa.
- `src/agent.ts` — `disclaimed()`.
- `src/window.ts` — LaunchAgent do Mac. `src/notify.ts` — aviso do Mac.
- `scripts/footprint.mjs` — `--window`, alvo 150/120 MB. `scripts/launch.mjs` — no Mac abre o `Folga.app`. `scripts/probe-smoke.mjs`, `src/tests/fake-probe.mjs`.
- `web/src/Settings.tsx`, `web/src/api.ts`, `web/src/mock.ts` — "Abrir com o Mac" e a nota nova.
- `.github/workflows/ci.yml`, `.gitignore` (`build/`), `.claude/adr/0007-app-de-barra-webkit-no-mac.md` (novo).
- Testes tocados: `files.test.ts`, `agent.test.ts`, `http.test.ts`, `notify.test.ts`.

---

### Task 1: Bundle, assinatura estável e o `check`

**Files:** Create `mac/Folga.swift` (só `--version`/`--selftest`), `scripts/mac-app.mjs`, `src/tests/macapp.test.ts`, `.claude/adr/0007-app-de-barra-webkit-no-mac.md` · Modify `.github/workflows/ci.yml`, `.gitignore`
**Interfaces:** Produces: `node scripts/mac-app.mjs build [--adhoc] [--out <dir>]` → `<out>/Folga.app` (padrão `build/`) com `Info.plist` (`CFBundleIdentifier local.folga.app`, `CFBundleExecutable Folga`, `CFBundleShortVersionString` = versão do `package.json`, `LSUIElement true`, `LSMinimumSystemVersion 13.0`, `NSAppTransportSecurity.NSAllowsLocalNetworking true`), `Contents/MacOS/Folga`, `Contents/Resources/folga/{src,dist,probe/bin/probe-mac,package.json}`, `Contents/Resources/folga.json` `{ node: string; path: string }` (= `process.execPath` e `PATH` de quem rodou o build) · `node scripts/mac-app.mjs check <app> [--previous <arquivo-de-requisito>]` → sai 0/1 · `requirementWeak(dr: string): boolean` (puro, exportado; o CLI só roda sob `import.meta.main`, para o teste poder importar) · `Folga --version` → `folga <versão>` · `Folga --selftest` → sai 0/1.

- [ ] **Step 1: Write the failing test** — `macapp.test.ts` (nos dois sistemas):
  ```ts
  import { requirementWeak } from '../../scripts/mac-app.mjs';
  assert.equal(requirementWeak('designated => identifier "local.folga.app"'), true);            // qualquer ad-hoc com o id herdaria o TCC
  assert.equal(requirementWeak('designated => identifier "local.folga.app" or cdhash H"ab12"'), true);
  assert.equal(requirementWeak('designated => cdhash H"ab12"'), false);                        // ad-hoc: seguro, mas muda a cada build
  assert.equal(requirementWeak('designated => identifier "local.folga.app" and certificate leaf = H"9f00"'), false);
  assert.equal(requirementWeak(''), true);
  ```
  E o `check` (só Mac): `plutil -lint`; `LSUIElement` verdadeiro; `Folga --version` igual à do `package.json`; `Folga --selftest` sai 0; `codesign --verify --strict` no bundle e no `probe-mac` de dentro; `codesign -d -r-` passando em `requirementWeak` = falso; com `--previous`, `codesign --verify -R=<requisito do build anterior>` sai 0 (é a mesma conta que o TCC faz para manter a permissão depois de reinstalar).
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/macapp.test.ts` Expected: erro de importação (`scripts/mac-app.mjs` não existe).
- [ ] **Step 3: Implement**
  - `build`: exige `dist/index.html` e `probe/bin/probe-mac` (senão manda rodar `npm run build` / `npm run build:probe`); `xcrun swiftc -O mac/Folga.swift -o …/MacOS/Folga`; cópia com `cpSync` (só Mac; o aviso do `CLAUDE.md` é do Windows); `Info.plist` gerado pelo script (`plutil -convert xml1` de um JSON). Assina o `probe-mac` de dentro **antes** do bundle, com a mesma identidade.
  - **Spike de assinatura (decide e anota no ADR 0007):** (A) identidade "Folga Local" autoassinada (`/usr/bin/openssl req -x509 … -addext extendedKeyUsage=codeSigning`, 10 anos) num chaveiro só dela em `<dataDir>/assinatura/folga.keychain-db`, senha aleatória num arquivo 0600 ao lado, importada com `-T /usr/bin/codesign` e `set-key-partition-list` (sem janela de "permitir acesso"); `codesign --keychain … -s "Folga Local" -r='designated => identifier "local.folga.app" and certificate leaf = H"<sha1>"'`. Provar: build, guardar o requisito, rebuild, `check --previous` verde. (B) se o `codesign` recusar certificado não confiável ou pedir senha de administrador: ad-hoc puro (`cdhash`), `check --previous` vermelho de propósito, e o ADR diz "depois de cada reinstalação o Vittorio liga o Folga de novo no Acesso Total ao Disco". **Nunca** requisito só com `identifier`. `--adhoc` força (B) (CI). O chaveiro nunca entra na lista de busca do usuário.
  - ADR 0007 com: por que WebKit e não Edge/Chrome (decisão 5), por que o servidor vai copiado no bundle, a assinatura escolhida e seu limite honesto ("um programa já rodando como você consegue assinar com essa chave, como aconteceria com um certificado pago guardado no mesmo Mac"); as Tasks 5, 6 e 8 completam suas linhas.
  - CI (só macOS, sem segredo): `npm run build && node scripts/build-probe.mjs && node scripts/mac-app.mjs build --adhoc && node scripts/mac-app.mjs check build/Folga.app`.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck && node scripts/mac-app.mjs build && node scripts/mac-app.mjs check build/Folga.app` Expected: verde; repetir o build e rodar `check --previous` (verde em A). `git push fork mac-port` → os dois jobs verdes.
- [ ] **Step 5: Commit**
  ```bash
  git add mac/Folga.swift scripts/mac-app.mjs src/tests/macapp.test.ts .claude/adr/0007-app-de-barra-webkit-no-mac.md .github/workflows/ci.yml .gitignore
  git commit -m "Folga.app montado por script: Info.plist de app de barra, servidor dentro do bundle e assinatura que sobrevive ao rebuild

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 2: O app sobe, vigia e encerra o servidor

**Files:** Modify `mac/Folga.swift`, `src/server.ts` (`selfPids`, `shutdown`), `src/tests/fake-probe.mjs` · Create `src/tests/app-host.test.ts`
**Interfaces:** Consumes: `folga.json`. Produces: Swift `nextDelay(crashes: [Date], now: Date) -> TimeInterval?` (1, 2, 4, 8, 16 s; 6ª queda em 10 min → `nil` = desiste; queda depois de 5 min no ar zera) · `findNode(recorded: String) -> String?` (gravado → `/opt/homebrew/bin/node` → `/usr/local/bin/node`; exige executável e `--version` ≥ 24) · ambiente do filho: `FOLGA_APP=1`, `FOLGA_APP_PATH=<bundlePath>`, `PATH` do `folga.json`, `HOME`, `LANG` · `fake-probe` com `FAKE_APP_PID=<n>` acrescenta o processo `local.folga.app`.

- [ ] **Step 1: Write the failing test** — `app-host.test.ts` sobe `src/server.ts` (porta livre, `FOLGA_DATA_DIR` temporário, `FAKE_MAC=1`, `FAKE_APP_PID=9100`) com `FOLGA_APP=1` e stdin em pipe: em `/api/state`, o grupo `__self` contém 9100 e nenhum app tem a chave `local.folga.app`; `child.stdin.end()` → o processo sai com 0 em ≤ 3 s. Sem `FOLGA_APP` e stdin `'ignore'` (como o `launch.mjs`) → continua no ar depois de 3 s. `--selftest` ganha `nextDelay` (sequência, desistência, zerar) e `findNode` com caminho inexistente → `nil`.
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/app-host.test.ts` Expected: 9100 aparece como app próprio (não em `__self`) e o servidor não sai com o stdin fechado.
- [ ] **Step 3: Implement**
  - `server.ts`: `const IN_APP = process.platform === 'darwin' && process.env.FOLGA_APP === '1'`; com ele, `process.stdin.on('end', shutdown).resume()` (app caiu, até por `kill -9` → pipe fecha → servidor sai; sem órfão na 4780) e `selfPids` soma os pids cujo `name` minúsculo é `local.folga.app` — o app e os processos do WebKit dele, que a sonda já atribui ao `.app` responsável.
  - `Folga.swift`: `NSApplication` com política `.accessory`; instância única por `NSRunningApplication.runningApplications(withBundleIdentifier:)` (a segunda posta `local.folga.app.open` no `DistributedNotificationCenter` e sai; a primeira abre a janela — Task 3). Antes de subir: `GET /api/settings` em 127.0.0.1:4780 — recusou conexão → sobe; respondeu 200 → "Folga rodando fora do app" (não supervisiona, não mata; a janela usa esse servidor); qualquer outra coisa → "A porta 4780 está ocupada por outro programa" (não mata nada). `Process` com caminho absoluto do `node`, `['--no-warnings', <Resources>/folga/src/server.ts]`, stdin em `Pipe()` que o app nunca fecha, stdout/stderr em `<dataDir>/server.log` (acréscimo, zera acima de 1 MB, como o `launch.mjs`). `terminationHandler` → `nextDelay`; `nil` → item "O Folga parou — tentar de novo". Sem `node` → item de erro "O Folga precisa do Node 24. Peça para reinstalar." e nenhum laço. `Sair` e `SIGTERM` → `terminate()` no `Process` que o app criou (nunca por pid procurado), espera 3 s, `SIGKILL` só nesse mesmo `Process`.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && node scripts/mac-app.mjs build && build/Folga.app/Contents/MacOS/Folga --selftest` Expected: verde. Ao vivo (sandbox desligado): `open build/Folga.app` → `curl -s 127.0.0.1:4780/api/settings` 200; `kill -9` no `node` → de volta em ≤ 3 s; `kill -9` no app → `node` some em ≤ 3 s e a porta fica livre; com `npm start` já no ar → o app não sobe outro; com `nc -l 127.0.0.1 4780` → aviso de porta ocupada e o `nc` continua vivo; segundo `open` → um processo só.
- [ ] **Step 5: Commit**
  ```bash
  git add mac/Folga.swift src/server.ts src/tests/fake-probe.mjs src/tests/app-host.test.ts
  git commit -m "Folga.app vigia o servidor: caminho absoluto do node, reinício com espera crescente, sem órfão na porta e sem matar o que não é dele

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 3: Janela WebKit e o texto da barra

**Files:** Modify `mac/Folga.swift`, `src/server.ts` (`/api/window` no Mac)
**Interfaces:** Produces: Swift `allowedURL(_ url: URL, port: Int) -> Bool` · `statusText(memLoad: Int?) -> String` (padrão `"62%"`, só memória — decisão 18; servidor fora → `"Folga"`).

- [ ] **Step 1: Write the failing test** — no `--selftest`: `allowedURL` aceita `http://127.0.0.1:4780/`, `/#/arquivos`, `/assets/x.js`; recusa `http://localhost:4780/`, `http://127.0.0.1:4781/`, `https://127.0.0.1:4780/`, `http://127.0.0.1.evil.com:4780/`, `http://evil.com/?h=127.0.0.1:4780`, `file:///etc/hosts`, `javascript:alert(1)`, `about:blank`, `data:text/html,x`. `statusText(nil, nil) == "Folga"`, `statusText(62) == "62%"`.
- [ ] **Step 2: Run test to verify it fails** Run: `node scripts/mac-app.mjs build --adhoc && build/Folga.app/Contents/MacOS/Folga --selftest` Expected: falha de compilação (`allowedURL` não existe) e, com o esqueleto, os casos acima.
- [ ] **Step 3: Implement**
  - "Abrir Folga" (e a notificação distribuída da Task 2): `NSWindow` 1180×760 com `WKWebView` novo: `websiteDataStore = .nonPersistent()` (nada de cache nem do token em disco), `userContentController` vazio — **sem `WKScriptMessageHandler`, sem `addUserScript`**, `javaScriptCanOpenWindowsAutomatically = false`. `decidePolicyFor navigationAction`: `allowedURL` → `.allow`; `https:` fora → `.cancel` e `NSWorkspace.shared.open` (navegador padrão); resto → `.cancel`. `createWebViewWith` → `nil`. O token chega como hoje: a página faz `GET /api/token` na mesma origem — mesma exposição de agora a outros processos locais (que já podem fazer esse GET), nada a mais em URL, histórico ou disco. Falha de carga (servidor subindo) → texto "Abrindo…" e nova tentativa a cada 1 s por até 20 s.
  - Fechar a janela destrói o `WKWebView` e a janela (`isReleasedWhenClosed = false` + referências a `nil`) para o processo de conteúdo do WebKit sair — é o que segura os 120 MB em segundo plano (Task 9).
  - Texto da barra a cada 10 s: `memLoad` de `GET /api/state` (o mesmo número da tela Início) e disco livre por `volumeAvailableCapacityForImportantUsageKey` do volume do `HOME`, em `NSStatusItem.button.title` com fonte monoespaçada pequena.
  - `server.ts`: no Mac, `POST /api/window` responde 409 `"abra pelo app Folga na barra de menus"` em vez de procurar o Edge.
- [ ] **Step 4: Run test to verify it passes** Run: `build/Folga.app/Contents/MacOS/Folga --selftest && npm test` Expected: verde. Ao vivo: abrir o app → texto na barra; "Abrir Folga" → as telas carregam e um ajuste salvo pela janela vale (prova que o token chegou); fechar e reabrir funciona; Web Inspector desligado.
- [ ] **Step 5: Commit**
  ```bash
  git add mac/Folga.swift src/server.ts
  git commit -m "janela WebKit presa ao 127.0.0.1 do Folga, sem ponte para o app; memória e disco no texto da barra

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 4: "Liberar parados" pelo menu, pelo caminho de sempre

**Files:** Modify `mac/Folga.swift`
**Interfaces:** Consumes: `GET /api/state`, `GET /api/token`, `POST /api/release` (`ReleaseResponse`). Produces: Swift `idleApps(_ state: [String: Any]) -> [(key: String, name: String, bytes: Int64)]`.

- [ ] **Step 1: Write the failing test** — no `--selftest`, com um estado em JSON escrito no próprio teste: só entram apps com `state == "idle"`; `in_use`, `protected` (inclui `__self` e o app em primeiro plano, que o `classify` já marca) e chave ausente ficam fora; ordem por `privateWorkingSet` decrescente; estado sem `apps` → lista vazia.
- [ ] **Step 2: Run test to verify it fails** Run: `node scripts/mac-app.mjs build --adhoc && build/Folga.app/Contents/MacOS/Folga --selftest` Expected: falha por `idleApps` ausente.
- [ ] **Step 3: Implement** — item "Liberar parados…": lê `/api/state`; lista vazia → alerta "Nada parado agora". Senão `NSAlert` com os nomes e o total ("Fechar do jeito normal (como Cmd+Q): TextEdit, Prévia — cerca de 180 MB. Cada app pode perguntar se você quer salvar.") e os botões "Fechar" / "Cancelar" (Cancelar é o padrão do Esc). Só no "Fechar": `GET /api/token` (não guarda), `POST /api/release` com `content-type: application/json`, `x-folga-token` e `{ keys }`; o `releaser` revalida tudo (protegido → 409, como no botão da tela). Resultado em outro alerta, com a mesma frase de R08 que a tela usa ("Liberados X GB" = disponível depois − antes) ou o `erro` do servidor. Nenhum caminho novo de execução: é o mesmo POST da tela Memória.
- [ ] **Step 4: Run test to verify it passes** Run: `build/Folga.app/Contents/MacOS/Folga --selftest && npm test` Expected: verde (o `http.test.ts` segue exigindo 403 sem token em `/api/release`). Ao vivo: TextEdit aberto sem documento, `idleMinutes` em 5 pela tela (devolvido depois); quando parado, "Liberar parados…" → o alerta lista **só** o TextEdit (outro app na lista → Cancelar e anotar); "Cancelar" não fecha nada; "Fechar" fecha o TextEdit e o Registro mostra a liberação manual.
- [ ] **Step 5: Commit**
  ```bash
  git add mac/Folga.swift
  git commit -m "Liberar parados pelo menu: confirma com a lista e usa o mesmo POST com token da tela Memória

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 5: Acesso Total ao Disco para o `Folga.app`

**Files:** Modify `mac/Folga.swift`, `src/files.ts` (`FDA_NOTE` → `fdaNote`), `src/tests/files.test.ts`, `web/src/mock.ts`, `.claude/adr/0007-app-de-barra-webkit-no-mac.md`
**Interfaces:** Produces: `fdaNote(insideApp = process.platform === 'darwin' && process.env.FOLGA_APP === '1'): string` · Swift `hasFullDiskAccess() -> Bool` (listar `~/.Trash` sem `EPERM`).

- [ ] **Step 1: Write the failing test** — em `files.test.ts`, nos dois sistemas:
  ```ts
  assert.match(fdaNote(true), /Ajustes do Sistema › Privacidade e Segurança › Acesso Total ao Disco/);
  assert.match(fdaNote(true), /Folga/);
  assert.doesNotMatch(fdaNote(false), /Ajustes do Sistema|Privacy_AllFiles/);   // fora do app, o caminho levaria a liberar o Terminal
  for (const n of [fdaNote(true), fdaNote(false)]) assert.doesNotMatch(n, /\bnode\b|Terminal|execPath/i);
  ```
  O pino do plano 2 (varredura `git grep`) passa a incluir `mac` além de `src`, `web/src` e `scripts` (documentos e ADRs ficam fora: eles citam a regra "nunca para o `node`").
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/files.test.ts` Expected: `fdaNote` não exportado.
- [ ] **Step 3: Implement**
  - `fdaNote(true)` = `'Não deu para ler: falta liberar o Acesso Total ao Disco para o Folga. No ícone do Folga na barra, clique em "Liberar acesso ao disco…" (fica em Ajustes do Sistema › Privacidade e Segurança › Acesso Total ao Disco).'`; `fdaNote(false)` = `'Não deu para ler: o macOS guarda isto atrás do Acesso Total ao Disco. Abra o Folga pelo app Folga, na barra de menus, para liberar.'`. Os usos de `FDA_NOTE` em `files.ts` passam a chamar `fdaNote()`; `mock.ts` usa o texto de dentro do app.
  - `Folga.swift`: item "Liberar acesso ao disco…" visível só quando `hasFullDiskAccess()` é falso (reavaliado em `menuNeedsUpdate`). Clique → alerta em linguagem simples ("Para o Folga medir a Lixeira, o cache do Safari e o iCloud Drive, ligue o Folga na lista que vai abrir. Se ele não estiver lá, clique em + e escolha Folga em Aplicativos.") e "Abrir Ajustes" → `NSWorkspace.shared.open` do link do painel. **Spike:** testar `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles` e `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` no macOS 26 e ficar com o que abre o painel certo; anotar no ADR se o Folga já aparece na lista sozinho ou precisa do +.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck` Expected: verde. Ao vivo, **passo do controlador:** o Vittorio liga o Folga no Acesso Total ao Disco (anotar a data; quem constrói não clica). Depois, com o app reaberto: `GET /api/quickclean` → item `lixeira` sem `unknown` e a nota do Safari com MB em vez de `fdaNote`; varredura de arquivos parados lista o iCloud Drive sem `EPERM` no `server.log` (nada vai para a Lixeira; arquivo só na nuvem continua fora). Antes de ele liberar: a nota mostrada na tela é a de dentro do app.
- [ ] **Step 5: Commit**
  ```bash
  git add mac/Folga.swift src/files.ts src/tests/files.test.ts web/src/mock.ts .claude/adr/0007-app-de-barra-webkit-no-mac.md
  git commit -m "Acesso Total ao Disco pedido pelo Folga.app: menu leva ao painel, nota com o caminho só dentro do app

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 6: O assistente fica fora do Acesso Total ao Disco

**Files:** Modify `probe/probe-mac.swift` (`oneShot`), `scripts/probe-smoke.mjs`, `src/agent.ts` (`runTurn`), `src/tests/agent.test.ts`, `src/server.ts` (linha de início), `.claude/adr/0007-app-de-barra-webkit-no-mac.md`
**Interfaces:** Produces: `probe-mac --responsible` → `{ pid: number; responsible: number; path: string }` (caminho do executável responsável) · `probe-mac --disclaim <cmd> [args…]` (executa `cmd` como responsável por si mesmo; símbolo ausente → sai 126 sem executar) · `disclaimed(l: Launch, platform: NodeJS.Platform, insideApp: boolean, helper: string): Launch`.

- [ ] **Step 1: Write the failing test** — `agent.test.ts`: `disclaimed(l, 'win32', true, h)` e `disclaimed(l, 'darwin', false, h)` devolvem `l` igual; `disclaimed(l, 'darwin', true, '/x/probe-mac')` → `cmd === '/x/probe-mac'`, `args === ['--disclaim', l.cmd, ...l.args]`, `env`/`cwd` preservados. Smoke (Mac): `--responsible` devolve `responsible > 0`; `--disclaim <probe-mac> --responsible` devolve `responsible === pid` e o mesmo `pid` do processo lançado; `--disclaim /usr/bin/false` sai 1 (código repassado).
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/agent.test.ts && node scripts/build-probe.mjs && node scripts/probe-smoke.mjs` Expected: `disclaimed` não exportado; o smoke cai no modo contínuo.
- [ ] **Step 3: Implement**
  - `--disclaim`: `dlsym(…, "responsibility_spawnattrs_setdisclaim")` (mesma API privada que o Chromium usa; comentário `ponytail:` com o limite) + `posix_spawn` com `POSIX_SPAWN_SETEXEC`, para o pid, o stdio e o `kill` do Node continuarem os mesmos. **Spike:** se `SETEXEC` não cortar a responsabilidade (o smoke diz), cair para `posix_spawn` normal + `waitpid` + repasse de `SIGTERM`/`SIGINT` ao filho. Anotar o resultado no ADR.
  - `agent.ts`: `runTurn` passa o `Launch` por `disclaimed(l, process.platform, process.env.FOLGA_APP === '1', <ROOT>/probe/bin/probe-mac)`. Fora do app nada muda (sem Acesso Total ao Disco para herdar).
  - `server.ts`, dentro do app, uma linha no log de início (R32): `responsável <caminho do --responsible> · acesso ao disco: servidor sim|não · assistente não|SIM` — `macHelper(['--size'], ~/.Trash)` direto e via `--disclaim`; nunca caminho de arquivo do usuário. "assistente SIM" é bug.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && node scripts/build-probe.mjs && node scripts/probe-smoke.mjs` Expected: verde. Ao vivo: rebuild do app, abrir, `server.log` com `responsável …/Folga.app/Contents/MacOS/Folga` (via `--responsible` do servidor) e, depois do passo do controlador da Task 5, `servidor sim · assistente não`.
- [ ] **Step 5: Commit**
  ```bash
  git add probe/probe-mac.swift scripts/probe-smoke.mjs src/agent.ts src/tests/agent.test.ts src/server.ts .claude/adr/0007-app-de-barra-webkit-no-mac.md
  git commit -m "assistente lançado sem herdar o Acesso Total ao Disco do Folga.app (--disclaim); log diz quem tem acesso

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 7: Abrir com o Mac (LaunchAgent, desligado por padrão)

**Files:** Modify `src/window.ts` (`startupInstalled`, `setStartup`), `src/server.ts` (`/api/startup`), `src/tests/http.test.ts:160-170`, `web/src/Settings.tsx` (`Startup`), `web/src/api.ts`
**Interfaces:** Produces: `GET /api/startup` → `{ on: boolean; available: boolean }` (`available` = win32, ou darwin com `FOLGA_APP=1`) · `launchAgentXml(appPath: string): string` (puro) · arquivo `<startupDir>/local.folga.app.plist`.

- [ ] **Step 1: Write the failing test** — `http.test.ts`, bloco P04 no Mac: servidor novo → `on: false`; sem `FOLGA_APP` → `available: false` e `PUT on:true` com token → 409 e nada criado; com `FOLGA_APP=1` e `FOLGA_APP_PATH=/Users/x/Applications/Fol&ga.app` (stdin em pipe) → plist criado no `FOLGA_STARTUP_DIR` temporário, `plutil -lint` ok, `Label local.folga.app`, `ProgramArguments[0]` = `…/Fol&ga.app/Contents/MacOS/Folga` (com `&amp;` no XML), `RunAtLoad true`, `LimitLoadToSessionType Aqua`; `on:false` apaga. `FOLGA_APP_PATH` relativo ou sem `.app` → 409. Windows igual a hoje.
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/http.test.ts` Expected: no Mac, `available` ausente e o plist não existe.
- [ ] **Step 3: Implement** — `window.ts` darwin: `startupDir()` = `FOLGA_STARTUP_DIR` ?? `~/Library/LaunchAgents`; escrever com `writeFileSync` (o launchd lê no próximo login; o Node **não** chama `launchctl`); `ProgramArguments` = `[<app>/Contents/MacOS/Folga, --login]`, `AssociatedBundleIdentifiers local.folga.app`, `ProcessType Interactive`. `--login` no app = só o ícone, sem abrir a janela. `Settings.tsx`: título "Abrir com o Mac" quando `/Mac/.test(navigator.platform)`, e com `available: false` o interruptor fica desligado com "Disponível pelo app Folga".
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck` Expected: verde nos dois sistemas. Ao vivo só em pasta temporária. **Passo do controlador:** ligar pela tela, sair e entrar na conta, conferir o ícone e desligar se o Vittorio não quiser.
- [ ] **Step 5: Commit**
  ```bash
  git add src/window.ts src/server.ts src/tests/http.test.ts web/src/Settings.tsx web/src/api.ts
  git commit -m "abrir com o Mac: LaunchAgent escrito pelo Node só dentro do app, desligado por padrão (P04, R33)

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 8: Avisos pelo app (com `osascript` de reserva)

**Files:** Modify `src/notify.ts`, `src/tests/notify.test.ts`, `mac/Folga.swift`, `.claude/adr/0007-app-de-barra-webkit-no-mac.md`
**Interfaces:** Produces: `notifyCommand(platform, env): { cmd: string; args: string[] } | null` (puro) · `Folga --notify` (lê `FOLGA_TOAST_TITLE`/`FOLGA_TOAST_BODY` do ambiente, posta, sai).

- [ ] **Step 1: Write the failing test** — `notify.test.ts`: darwin com `FOLGA_APP=1` e `FOLGA_APP_PATH` absoluto `.app` → `cmd` = `<app>/Contents/MacOS/Folga`, `args` = `['--notify']`; darwin fora do app → `/usr/bin/osascript` com `-e` fixo que lê `system attribute "FOLGA_TOAST_TITLE"`/`"FOLGA_TOAST_BODY"`; um título `"; do shell script "rm -rf ~"` nunca aparece em `args` (vai só no ambiente, como a R31 do Windows); win32 → `null` (segue o PowerShell de hoje).
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/notify.test.ts` Expected: `notifyCommand` não exportado.
- [ ] **Step 3: Implement** — `notify.ts` usa `notifyCommand` no Mac, mesmo `spawn` sem shell, mesmo `broken`. `Folga --notify` roda antes da instância única: `UNUserNotificationCenter` (pede autorização na primeira vez — **o Vittorio responde**), posta, sai no handler. A instância principal define o `delegate`: clique no aviso → abre a janela. **Spike:** se o macOS recusar notificação de app sem certificado pago, o `--notify` sai ≠ 0, o `notify.ts` marca `broken` só do app e passa para o `osascript`. Resultado no ADR.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test` Expected: verde. Ao vivo: `FOLGA_TOAST_TITLE=teste FOLGA_TOAST_BODY=oi build/Folga.app/Contents/MacOS/Folga --notify` com o app aberto → aviso com o nome Folga (ou registro de "autorização pendente"); clique abre a janela.
- [ ] **Step 5: Commit**
  ```bash
  git add src/notify.ts src/tests/notify.test.ts mac/Folga.swift .claude/adr/0007-app-de-barra-webkit-no-mac.md
  git commit -m "avisos do Mac pelo Folga.app (clique abre a janela), osascript de reserva; texto só pelo ambiente

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 9: Pegada do app inteiro

**Files:** Modify `scripts/footprint.mjs`
**Interfaces:** Produces: `node scripts/footprint.mjs [--minutes N] [--window]` — limite 150 MB com `--window`, 120 MB sem; no Mac imprime também os pids de `__self` com `ps -o pid=,rss=,comm=` (rótulo "RSS, só para ver quem pesa").

- [ ] **Step 1: Write the failing test** — rodar o script com o app aberto e a janela aberta: hoje ele compara com 120 MB e não lista o app nem o WebKit.
- [ ] **Step 2: Run test to verify it fails** Run (sandbox desligado): `node scripts/footprint.mjs --minutes 1 --window` Expected: `--window` ignorado; limite 120.
- [ ] **Step 3: Implement** — só a flag, o limite e a lista. A soma já é `phys_footprint` de servidor + sonda + app + WebKit, porque a Task 2 pôs o bundle em `__self`. Conferir uma vez que os pids do `WebContent`/`Networking`/`GPU` da janela estão lá (se não, o `responsible` do WebKit não aponta para o app: anotar e corrigir na sonda).
- [ ] **Step 4: Run test to verify it passes** Run: `node scripts/footprint.mjs --minutes 10 --window` com a janela aberta e usada; fechar a janela, esperar 1 min, `node scripts/footprint.mjs --minutes 10` Expected: os dois números no relatório. Passou do alvo → reportar quanto e quem pesa (não é trava, é meta medida, pela spec); o processo de conteúdo do WebKit precisa sumir depois de fechar a janela.
- [ ] **Step 5: Commit**
  ```bash
  git add scripts/footprint.mjs
  git commit -m "footprint no Mac: app + WebKit + servidor + sonda, alvo 150 MB com janela e 120 MB sem

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 10: Instalar e desinstalar com um comando

**Files:** Modify `scripts/mac-app.mjs` (`install`, `uninstall`), `scripts/launch.mjs`
**Interfaces:** Produces: `node scripts/mac-app.mjs install` (build da interface, da sonda e do app → `check` → `~/Applications/Folga.app` → abre) · `node scripts/mac-app.mjs uninstall` · `npm run app` no Mac abre o `Folga.app` instalado ou diz para instalar.

- [ ] **Step 1: Write the failing test** — rodar `install` com `FOLGA_INSTALL_DIR=$(mktemp -d)` (a pasta destino é trocável só para teste): hoje o subcomando não existe.
- [ ] **Step 2: Run test to verify it fails** Run: `FOLGA_INSTALL_DIR=$(mktemp -d) node scripts/mac-app.mjs install` Expected: "subcomando desconhecido".
- [ ] **Step 3: Implement** — `install`: `vite build` e `build-probe` pelo `process.execPath` (sem `npx`), `build`, `check` (vermelho → para sem tocar no instalado); se o `Folga` instalado estiver rodando (pid achado por caminho **exato** do executável em `ps -axo pid=,comm=`), `SIGTERM` e espera sair; `ditto` para `Folga.app.novo`, troca por `rename` (o velho vira `Folga.app.velho` e é apagado só depois que o novo abriu); `open` do novo. Nada de `osascript`/Apple Events (pediria Automação para o Terminal). `uninstall`: para o app do mesmo jeito, apaga `~/Applications/Folga.app` e o plist da Task 7 se existir; **não** apaga `~/Library/Application Support/Folga` nem mexe na lista do Acesso Total ao Disco — imprime onde ficam e que o Vittorio remove o Folga dos Ajustes se quiser. `launch.mjs` no darwin: `open <~/Applications/Folga.app>` se existir; senão "rode node scripts/mac-app.mjs install".
- [ ] **Step 4: Run test to verify it passes** Run: `FOLGA_INSTALL_DIR=$(mktemp -d) node scripts/mac-app.mjs install` e depois `uninstall` na mesma pasta Expected: instalado, aberto, desinstalado, dados intactos. **Passo do controlador:** `node scripts/mac-app.mjs install` de verdade, uma vez, com o Vittorio vendo o ícone aparecer; depois disso as Tasks 5–8 têm seus passos ao vivo no app instalado. Reinstalar e confirmar que o Acesso Total ao Disco continuou ligado (se a assinatura ficou em A).
- [ ] **Step 5: Commit**
  ```bash
  git add scripts/mac-app.mjs scripts/launch.mjs
  git commit -m "instalar e desinstalar o Folga.app com um comando; npm run app no Mac abre o app

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 11: Revisão de segurança dedicada

**Files:** nenhum de antemão; o que a revisão achar, com teste novo (ou caso novo no `--selftest`/smoke) no lugar do módulo.
**Interfaces:** Consumes: `git diff 6602753..HEAD`. Produces: lista de achados com veredito e o que foi feito, na mensagem do commit de correção (ou "nenhum achado" no resumo final).

- [ ] **Step 1: Write the failing test** — roteiro do revisor (novo, sem o contexto desta sessão), contra o diff inteiro: os 6 itens do Review Focus; token nunca em URL/argv/log/`UserDefaults`, e o app não o guarda; `WKWebView` sem ponte, sem dados persistentes, sem sair do 127.0.0.1; o que mais o app expõe a outro processo local (notificação distribuída, `--notify`, `--disclaim`, `FOLGA_APP_PATH`, `folga.json`) e se algum deles executa algo escolhido por quem chama; supervisão sem matar processo alheio e sem órfão; requisito de assinatura e onde mora a chave (chaveiro próprio, senha 0600); `codex`/`claude` lançados com `--disclaim` dentro do app; nenhum texto juntando Acesso Total ao Disco com `node`/Terminal; plist com XML escapado e só dentro do app; nenhum `.env` tocado. Resíduo já aceito, para não reabrir: `GET /api/token` responde a qualquer processo local, como antes deste plano.
- [ ] **Step 2: Run test to verify it fails** Run: a skill `security-review` sobre o branch e, em seguida, um `code-review` em nível `high` com o foco acima Expected: lista de achados (ou nenhum), cada um com cenário concreto.
- [ ] **Step 3: Implement** — confirmar cada achado por sonda (app em `build/`, pasta temporária) antes de corrigir; não confirmado fica registrado como descartado, com o porquê. Correção = menor diff + teste que pina o cenário.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck && node scripts/build-probe.mjs && node scripts/probe-smoke.mjs && node scripts/mac-app.mjs build && node scripts/mac-app.mjs check build/Folga.app`, depois `git push fork mac-port` Expected: tudo verde, os dois jobs da CI verdes. Só então o plano conta como feito.
- [ ] **Step 5: Commit**
  ```bash
  git add -A mac src scripts probe web .claude/adr
  git commit -m "revisão de segurança do app na barra: <achados e correções>

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

**Fica para os próximos planos (sem pintar o canto):** assistente no Mac (spike do ADR 0006, `PATH` de login — hoje vai o `PATH` gravado no build —, matar por grupo de processos); avisos de apps que travaram por `DiagnosticReports` e FileVault/Gatekeeper/SIP; Auto Care por pressão na tela de Ajustes; emendas em `CLAUDE.md`, `requirements.md` (R18 com o app, R33 no Mac) e `fluxo-infraestrutura.md`, e o PR para o Antônio.
