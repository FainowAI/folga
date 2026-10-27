# Folga no Mac — Plano 4: avisos e notificações (fase 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No Mac, a tela Avisos passa a mostrar o que vale para o Mac — memória, disco, apps que travaram nas últimas 24 h (`~/Library/Logs/DiagnosticReports`), FileVault/Gatekeeper/SIP desligados e os itens que abrem com o Mac (LaunchAgents/LaunchDaemons) — e o menu da barra diz "2 avisos" e abre essa tela. A notificação do macOS passa a chegar (ou o Folga diz com honestidade, no menu, que está desligada), sem pedir senha de administrador, sem escrever nada no sistema e sem quebrar o Windows.

**Architecture:** Tudo continua em `src/warnings.ts`, com o `exec` injetável de hoje: no `darwin`, os jobs `crashes`, `antivirus` (vira segurança) e `startupApps` trocam de fonte; o Windows segue idêntico. Travamentos são lidos como arquivo (`readdir` + 4 KB do começo de cada `.ips`/`.crash`), sem processo externo. Segurança e itens de inicialização usam só comandos de leitura com caminho absoluto, `shell:false` e o timeout de 20 s que o `exec` já tem: `/usr/bin/fdesetup status`, `/usr/sbin/spctl --status`, `/usr/bin/csrutil status`, `/bin/launchctl print gui/<uid>` e `/bin/launchctl print system`. Parsers são funções puras testadas com saída real capturada neste Mac. Notificações: o diagnóstico (Task 1) já achou o motivo provável do `--notify` sair 4 sem pedido — o `Folga.app` **não está registrado no LaunchServices** — então o `install` passa a registrar o app, a instância principal pede a autorização (uma vez, quando ainda não foi perguntada) e o `--notify` só posta. O caminho honesto não depende da notificação: contagem no menu e tela Avisos sempre.

**Tech Stack:** Node 24 (type stripping, `node:assert`), TypeScript 7, React (Vite), Swift 6 via `swiftc -O` (AppKit, UserNotifications), ferramentas do sistema só de leitura, GitHub Actions (windows-latest + macos-latest).

**Spec:** docs/superpowers/specs/2026-10-20-folga-mac-design.md (seções "Avisos (R26 / D15)", "Notificações"; decisões 17–21; fase 6 da ordem sugerida) · ADR 0007, seção "Avisos do Mac (Task 8)"

## Global Constraints
- Nenhuma dependência npm nova; só `swiftc`. Windows intacto: toda fonte nova é `platform === 'darwin'` (dep `platform` já existe no `WarningsDeps`); os casos atuais de `warnings.test.ts` (rig com `platform: 'win32'`) continuam passando sem mudança. A CI dos dois sistemas é a prova.
- **Só leitura, sem administrador.** Nenhum `sudo`, `sfltool`, `launchctl` com verbo que não seja `print`, `defaults write`, `tccutil`, `osascript` para System Events. **`sfltool dumpbtm` está fora:** no planejamento (21/10) ele ficou >120 s parado esperando autorização de administrador e foi morto — itens de login (Ajustes › Geral › Itens de Início) não são lidos, e a tela diz isso (decisão 21).
- **Só aviso crítico vira notificação** (decisão 20), uma vez por id até ele sair da lista; atenção e informação ficam na tela Avisos e na contagem do menu.
- Comando externo: caminho absoluto, `shell:false`, argumentos fixos. Nada lido de arquivo (nome de app, nome de plist) entra em argumento de processo; texto de notificação só pelo ambiente (R31, já pinado em `notify.test.ts`).
- Saída de ferramenta que não bate com o formato conhecido = "não sei" → **nenhum aviso** (nunca alarme falso) e o último valor bom fica.
- Fixtures de teste são saídas reais deste Mac, capturadas com o sandbox desligado e reduzidas ao mínimo; nomes de pasta/arquivo pessoais trocados por neutros.
- Aviso do macOS (notificações, administrador, Automação): quem constrói **nunca clica nem muda Ajustes do Sistema**. Apareceu → anota e segue; o que depende do Vittorio vira passo do controlador.
- O sandbox do Bash esconde processos e algumas pastas: checagens ao vivo (`launchctl`, `pgrep`, `lsregister -dump`) rodam com o sandbox desligado.
- Push só para o remoto `fork`. Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Nome vindo de arquivo virando comando ou texto enganoso.** `app_name` de um `.ips` e o nome de um `.plist` são escritos por qualquer programa do usuário. Fixado: `cleanName` (sem caracteres de controle, sem quebra de linha, até 80 caracteres) testado com nome hostil em `warnings.test.ts` (Task 3), e o teste do `exec` gravado da Task 5 exigindo que nenhum nome de plist apareça em argumento.
2. **Comando privilegiado ou que escreve.** Fixado: rig `darwin` em `warnings.test.ts` grava todo `exec` e compara com a lista fechada (5 comandos, caminhos absolutos) — Tasks 4 e 5; um teste `git grep` barra `sfltool`, `sudo` e `launchctl (load|unload|bootstrap|bootout|enable|disable|kickstart)` em `src` e `mac` (Task 5).
3. **Alarme falso ou mudo.** `.diag`, pasta `Retired`, relatório com mais de 24 h, `bug_type` que não é travamento e saída desconhecida de `fdesetup`/`spctl`/`csrutil` não geram aviso; consulta quebrada mantém os avisos que havia. Fixado em `warnings.test.ts` (Tasks 3 e 4).
4. **Notificação que "funciona" sem aparecer.** `--notify` saindo 0 sem postar, ou pedindo autorização num processo de 10 s que ninguém vê. Fixado: `notifyExit(status:alert:)` no `--selftest` (autorizado + alerta ligado → 0; não perguntado → 3; recusado ou alerta desligado → 4) e o item de menu "Notificações do Folga desligadas" (Task 2); contagem no menu independente da notificação (Task 6); e o oposto, notificação repetida a cada ciclo de 30 s ou para aviso de atenção — fixado por `warnings.test.ts` na Task 7.
5. **Windows quebrado pela troca de fonte.** Fixado: rig `win32` continua chamando PowerShell/`reg.exe` (casos atuais), rig `darwin` nunca chama `powershell.exe` nem `reg.exe` (Task 4), `Avisos.tsx` com o texto do Windows quando a plataforma não é Mac (Task 5).

---

## File Structure
- `src/warnings.ts` — dep `notify` (aviso crítico novo → uma notificação), `cleanName`, `crashCandidates` (compartilhada), `parseIpsHeader`, `parseCrashText`, `macCrashes`, `parseMacSecurity`, `macSecurityWarnings`, `parseLaunchctlPrint`; jobs por plataforma.
- `src/types.ts` — `WarningKind` ganha `'seguranca'`; `StartupApp.source` ganha `'launchagent_usuario' | 'launchagent_sistema' | 'launchdaemon'`.
- `src/tests/warnings.test.ts` — casos do Mac + rig `darwin`. `src/tests/fixtures/mac/` (novo) — saídas reais reduzidas.
- `mac/Folga.swift` — `notifyExit`, autorização na instância principal, item "Notificações desligadas", `avisosTexto`, item "N avisos" abrindo a tela Avisos.
- `scripts/mac-app.mjs` — `install` registra o app no LaunchServices.
- `src/server.ts` — liga `notify` do `createWarnings` ao `notify.toast` de sempre.
- `web/src/App.tsx` — vista inicial pelo `#hash`. `web/src/Avisos.tsx` — "Apps que abrem com o Mac", fontes novas, nota dos itens de login.
- `.claude/adr/0007-app-de-barra-webkit-no-mac.md` — resultado do diagnóstico e estratégia de entrega. `.claude/requirements.md` — R26/R31 com a parte do Mac (emenda).

---

### Task 1: Diagnóstico — por que nenhum aviso chega (só leitura)

**Files:** Modify `.claude/adr/0007-app-de-barra-webkit-no-mac.md` (seção "Avisos do Mac")
**Interfaces:** Produces: tabela no ADR "fato · como medido · resultado" e a estratégia escolhida, que a Task 2 consome.

- [ ] **Step 1: Write the failing test** — roteiro de sondas (sandbox desligado, nada escreve), com o resultado já medido no planejamento entre parênteses, para conferir que não mudou:
  - `lsregister -dump | grep -i 'local.folga.app'` (caminho completo do `lsregister` no `CoreServices.framework`) → **vazio: o Folga não está registrado** (21/10). Sem registro, o `UNUserNotificationCenter` recusa sem mostrar pedido e o `list_apps` não o vê.
  - `codesign -dv ~/Applications/Folga.app` → `Identifier=local.folga.app`, `Signature=adhoc`.
  - `defaults read com.apple.ncprefs` → existe entrada `com.apple.ScriptEditor2` com `flags = 8206`; **não** existe entrada do Folga. O aviso do `osascript` sai em nome do Editor de Scripts: conferir se esse `flags` corresponde a "permitir notificações" desligado (provável; comparar com um app cujo estado o Vittorio sabe) — se sim, o reserva está mudo por ajuste, não por bug.
  - `ls ~/Library/DoNotDisturb/DB/` → **`Operation not permitted`**: o Foco não é detectável sem Acesso Total ao Disco (decisão 17). Registrar como limite, não contornar.
  - `~/Library/Logs/DiagnosticReports` legível pelo Terminal (42 itens: 40 `.diag`, 1 `.ips` de `node` com `bug_type` 309, pasta `Retired`). **Medir também de dentro do app** (Task 3 grava a linha no `server.log`), porque o Terminal pode ter permissões que o Folga não tem.
  - `fdesetup status` / `spctl --status` / `csrutil status` respondem sem administrador; `launchctl print gui/<uid>` e `print system` também (seções `services = {` e `disabled services = {`). `sfltool dumpbtm` **trava esperando administrador** → fora.
- [ ] **Step 2: Run test to verify it fails** Run: as sondas acima Expected: os mesmos resultados; diferença → anotar e reavaliar a Task 2 antes de seguir.
- [ ] **Step 3: Implement** — **passo do controlador com o Vittorio** (é a única escrita, e é do LaunchServices do usuário, sem administrador; desfaz com `lsregister -u`): `lsregister -f ~/Applications/Folga.app`, `lsregister -dump | grep local.folga.app` (agora aparece), sair do Folga e abrir de novo, `FOLGA_TOAST_TITLE=teste FOLGA_TOAST_BODY=oi ~/Applications/Folga.app/Contents/MacOS/Folga --notify; echo $?`. Esperado: o macOS mostra o pedido "Folga quer enviar notificações" — **o Vittorio responde**. Anotar o código de saída antes e depois da resposta. Perguntar ao Vittorio se o Foco estava ligado e se quer ligar as notificações do Editor de Scripts (só ele muda Ajustes).
- [ ] **Step 4: Run test to verify it passes** Run: repetir o `--notify` depois da resposta Expected: saída 0 e o aviso visível com o nome Folga (ou, se recusado, saída 4 e a decisão registrada). Escrever no ADR: causa, estratégia (registrar no `install` + pedir na instância principal + `osascript` de reserva + contagem no menu sempre) e o limite do Foco.
- [ ] **Step 5: Commit**
  ```bash
  git add .claude/adr/0007-app-de-barra-webkit-no-mac.md
  git commit -m "ADR 0007: diagnóstico dos avisos do Mac (app fora do LaunchServices, Foco ilegível, sfltool pede administrador)

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 2: Autorização de notificação que aparece, e menu honesto quando está desligada

**Files:** Modify `mac/Folga.swift` (`notificar`, `AppDelegate`, `Supervisor.menuNeedsUpdate`), `scripts/mac-app.mjs` (`install`), `.claude/adr/0007-app-de-barra-webkit-no-mac.md`
**Interfaces:** Produces: Swift `notifyExit(status: UNAuthorizationStatus, alert: UNNotificationSetting) -> Int32` · item de menu (só texto) "Notificações do Folga desligadas — ligue em Ajustes do Sistema › Notificações › Folga", visível só quando `notifyExit != 0` · `install` roda `lsregister -f <destino>` depois do `ditto`.

- [ ] **Step 1: Write the failing test** — no `--selftest`: `notifyExit(.authorized, .enabled) == 0`, `(.provisional, .enabled) == 0`, `(.notDetermined, _) == 3`, `(.denied, _) == 4`, `(.authorized, .disabled) == 4` (autorizado mas com alertas desligados não conta como entregue).
- [ ] **Step 2: Run test to verify it fails** Run: `node scripts/mac-app.mjs build --adhoc && build/Folga.app/Contents/MacOS/Folga --selftest` Expected: falha de compilação (`notifyExit` não existe).
- [ ] **Step 3: Implement**
  - `--notify` **não** pede mais autorização: `getNotificationSettings` → `notifyExit`; ≠ 0 → sai com ele (o `notify.ts` já trata 3 como recuo de 10 min e 4 como quebrado, e cai no `osascript`); 0 → posta e sai 0/5. O timeout de 10 s fica só como rede.
  - A instância principal, no `applicationDidFinishLaunching`, chama `requestAuthorization([.alert, .sound])` **só se** o status for `.notDetermined` (o pedido aparece uma vez, com o app de pé, onde o Vittorio vê). Não com `--login` se isso fizer o pedido surgir sozinho no login: pedir no primeiro "Abrir Folga" nesse caso.
  - `menuNeedsUpdate` atualiza o item novo como faz com o aviso do Acesso Total (só texto, sem link, sem abrir Ajustes).
  - `mac-app.mjs install`: depois de trocar o app, `lsregister -f` com caminho absoluto e `shell:false`; falhou → imprime e segue (não impede instalar). `uninstall`: `lsregister -u` do mesmo caminho antes de apagar.
- [ ] **Step 4: Run test to verify it passes** Run: `build/Folga.app/Contents/MacOS/Folga --selftest && npm test` Expected: verde. **Passo do controlador:** `node scripts/mac-app.mjs install`, o Vittorio responde o pedido; menu sem o item novo se permitiu, com ele se recusou; um cartão do vigia (R31) chega como notificação do Folga e o clique abre a janela.
- [ ] **Step 5: Commit**
  ```bash
  git add mac/Folga.swift scripts/mac-app.mjs .claude/adr/0007-app-de-barra-webkit-no-mac.md
  git commit -m "notificações do Mac: app registrado no LaunchServices, pedido feito pela instância principal, menu avisa quando estão desligadas

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 3: Apps que travaram (DiagnosticReports)

**Files:** Modify `src/warnings.ts`, `src/tests/warnings.test.ts`, `src/server.ts` (linha de início) · Create `src/tests/fixtures/mac/ips-header.txt`, `src/tests/fixtures/mac/old.crash`
**Interfaces:** Produces: `cleanName(s: string): string` · `crashCandidates(names: string[]): Candidate[]` (o miolo de hoje do `parseCrashes`, que passa a chamá-la) · `parseIpsHeader(firstLine: string): { app: string; bugType: string } | null` · `parseCrashText(text: string): string | null` (linha `Process:` do formato antigo) · `macCrashes(entries: { file: string; mtimeMs: number; head: string }[], now: number): Candidate[]` · dep opcional `crashDir?: string` (padrão `~/Library/Logs/DiagnosticReports`).

- [ ] **Step 1: Write the failing test** — com a primeira linha real (`{"app_name":"node",…,"bug_type":"309",…}`): `parseIpsHeader` → `{ app: 'node', bugType: '309' }`; JSON quebrado, sem `app_name` ou linha vazia → `null`. `macCrashes`: `.ips` 309 de 1 h atrás → `travamento:node`, "node travou", "Travou 1 vez nas últimas 24 h."; dois do mesmo app → "2 vezes"; `.diag`, nome sob `Retired/`, `mtime` de 25 h, `bug_type` fora da lista de travamento → nada. `cleanName('Evil\u0007\nApp' + 'x'.repeat(200))` sem controle nem quebra e com ≤ 80 caracteres. `parseCrashes` do Windows devolve exatamente o mesmo de hoje (casos atuais intactos). Rig `darwin` com `crashDir` em `mkdtemp`: arquivo some → aviso sai; pasta ilegível → mantém os avisos.
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/warnings.test.ts` Expected: `parseIpsHeader` não exportado.
- [ ] **Step 3: Implement** — `run.crashes` no `darwin`: `readdir` só do nível de cima (não desce em `Retired`), filtra `.ips`/`.crash`, `stat` → últimas 24 h, no máximo os 50 mais novos, lê 4 KB do começo com `fs.open`/`read` (sem `exec`). Lista de `bug_type` de travamento = os vistos nos relatórios reais capturados (309 hoje; outro tipo só entra com fixture real e comentário). Nome: `app_name`, senão `name`, passado por `cleanName`. Pasta com `EPERM`/`ENOENT` → `throw` (o `job` mantém os avisos). Dentro do app, linha de início no `server.log` (R32): `travamentos: N relatórios lidos` ou `travamentos: sem acesso (<código>)` — é a medição "de dentro do app" da Task 1.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck` Expected: verde nos dois sistemas. Ao vivo: rebuild + `install` → `server.log` com a linha; `GET /api/warnings` com o travamento real do `node` (se ainda dentro de 24 h).
- [ ] **Step 5: Commit**
  ```bash
  git add src/warnings.ts src/tests/warnings.test.ts src/tests/fixtures/mac src/server.ts
  git commit -m "avisos do Mac: apps que travaram nas últimas 24 h, lidos dos relatórios do DiagnosticReports sem processo externo

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 4: FileVault, Gatekeeper e SIP no lugar do antivírus

**Files:** Modify `src/warnings.ts`, `src/types.ts` (`WarningKind`), `src/tests/warnings.test.ts`
**Interfaces:** Produces: `parseMacSecurity(out: { fv: string; gk: string; sip: string }): { fileVault: boolean | null; gatekeeper: boolean | null; sip: boolean | null }` · `macSecurityWarnings(s): Candidate[]` (um aviso `info` por item `false`; `null` não gera nada) · ids `seguranca:filevault|gatekeeper|sip`.

- [ ] **Step 1: Write the failing test** — saídas reais: `FileVault is On.` → `true`; `assessments enabled` → `true`; `System Integrity Protection status: enabled.` → `true`; e as formas desligadas (`FileVault is Off.`, `assessments disabled`, `… status: disabled.`) → `false`; vazio, texto em outro idioma ou `SIP … unknown (Custom Configuration)` → `null`. `macSecurityWarnings` com tudo ligado → `[]`; FileVault desligado → um `info` "FileVault desligado" com uma frase do que significa (sem mandar rodar comando). Rig `darwin` com `exec` gravado: `run.antivirus()` chama exatamente `/usr/bin/fdesetup ['status']`, `/usr/sbin/spctl ['--status']`, `/usr/bin/csrutil ['status']`; nenhum `powershell.exe`/`reg.exe`; um comando que falha não derruba os outros dois.
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/warnings.test.ts` Expected: `parseMacSecurity` não exportado; no rig `darwin` o job chama o PowerShell.
- [ ] **Step 3: Implement** — `run.antivirus` no `darwin` vira a leitura de segurança (mesmo intervalo de 30 min) e aplica `apply('seguranca', …)`; no Windows nada muda. Cada comando com `.catch(() => '')` → `null`. `WarningKind` ganha `'seguranca'` (o Windows nunca o emite).
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck` Expected: verde; ao vivo, `GET /api/warnings` sem aviso de segurança (os três estão ligados neste Mac) e sem aviso de antivírus.
- [ ] **Step 5: Commit**
  ```bash
  git add src/warnings.ts src/types.ts src/tests/warnings.test.ts
  git commit -m "avisos do Mac: FileVault, Gatekeeper e SIP desligados viram informação; antivírus só no Windows

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 5: Itens que abrem com o Mac

**Files:** Modify `src/warnings.ts` (`readStartupApps`), `src/types.ts` (`StartupApp.source`), `src/tests/warnings.test.ts`, `web/src/Avisos.tsx` · Create `src/tests/fixtures/mac/launchctl-gui.txt`, `src/tests/fixtures/mac/launchctl-system.txt`
**Interfaces:** Produces: `parseLaunchctlPrint(text: string): { loaded: Set<string>; disabled: Set<string> }` (labels da seção `services = {` e os `"x" => disabled` de `disabled services = {`) · deps opcionais `launchDirs?: { dir: string; source: StartupApp['source']; domain: 'gui' | 'system' }[]` · Mac: `name` = nome do arquivo sem `.plist`, `command` = caminho do plist, `enabled` = carregado **e** não desligado.

- [ ] **Step 1: Write the failing test** — fixtures reduzidas de `launchctl print gui/<uid>` e `print system` (5–8 serviços cada, com um `=> disabled`). `parseLaunchctlPrint`: carregados e desligados certos; texto vazio ou lixo → conjuntos vazios. Rig `darwin` com três pastas `mkdtemp`: `a.plist` carregado → ativo; `b.plist` em `disabled` → desativado; `c.plist` não carregado → desativado; `c.plist.bak-x`, `_aposentados/` e `.DS_Store` fora; nome `$(rm -rf ~).plist` aparece como texto e **não** em nenhum argumento do `exec` gravado, que é só `/bin/launchctl ['print', 'gui/<uid>']` e `['print', 'system']`. `launchctl` falhando → `startupApps` rejeita (estado não é inventado) e a tela mostra o "Não deu para ler" que já existe. Pino `git grep -nE "sfltool|\bsudo\b|launchctl.*(load|unload|bootstrap|bootout|enable|disable|kickstart)" -- src mac` vazio (fora de comentário de teste).
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/warnings.test.ts` Expected: `parseLaunchctlPrint` não exportado; rig `darwin` chama `cmd.exe`.
- [ ] **Step 3: Implement** — `readStartupApps` no `darwin`: `~/Library/LaunchAgents` (`launchagent_usuario`, domínio `gui/<process.getuid()>`), `/Library/LaunchAgents` (`launchagent_sistema`, gui), `/Library/LaunchDaemons` (`launchdaemon`, system); só `*.plist` no nível de cima; um `print` por domínio, cache de 5 min de hoje. `Avisos.tsx`: título "Apps que abrem com o Mac" quando `/Mac/.test(navigator.platform)`, `SOURCE` com "LaunchAgent · só você", "LaunchAgent · todos os usuários", "LaunchDaemon · sistema", e a frase "Só leitura. Itens de login (Ajustes do Sistema › Geral › Itens de Início) não aparecem aqui: o macOS só os mostra com senha de administrador." No Windows o texto de hoje.
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck && npm run build` Expected: verde. Ao vivo: tela Avisos no app lista os ~50 itens reais; `com.everblue.credit-gateway` aparece desativado (está em `disabled` hoje); nenhum pedido de senha.
- [ ] **Step 5: Commit**
  ```bash
  git add src/warnings.ts src/types.ts src/tests/warnings.test.ts src/tests/fixtures/mac web/src/Avisos.tsx
  git commit -m "avisos do Mac: LaunchAgents e LaunchDaemons com estado do launchctl, só leitura; itens de login ficam de fora (pedem administrador)

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 6: "2 avisos" no menu da barra, abrindo a tela Avisos

**Files:** Modify `mac/Folga.swift` (`Supervisor.atualizarTexto`, `Janela.abrir`), `web/src/App.tsx`
**Interfaces:** Consumes: `GET /api/warnings`, `settings.warningsLevel` do `GET /api/state`. Produces: Swift `avisosTexto(_ lista: [[String: Any]], soCriticos: Bool) -> String?` ("1 aviso", "3 avisos", `nil` com zero) · `Janela.abrir(vista: String? = nil)` carrega `http://127.0.0.1:<porta>/#avisos` · `App.tsx` lê a vista inicial e o `hashchange` de `location.hash` (só nomes de `View` conhecidos; o resto é ignorado).

- [ ] **Step 1: Write the failing test** — no `--selftest`: lista vazia → `nil`; um `atencao` ativo → "1 aviso"; dois ativos + um `active: false` → "2 avisos"; com `soCriticos` e só `atencao` → `nil` (R27, mesma regra do selo da barra lateral em `App.tsx`); item sem `severity` não conta. `allowedURL` continua aceitando `/#avisos` (caso novo).
- [ ] **Step 2: Run test to verify it fails** Run: `node scripts/mac-app.mjs build --adhoc && build/Folga.app/Contents/MacOS/Folga --selftest` Expected: `avisosTexto` não existe.
- [ ] **Step 3: Implement** — no mesmo ciclo de 10 s do texto da barra, `GET /api/warnings` (sem token: é GET) → item de menu clicável no topo, escondido quando `nil`; clique → `janela.abrir(vista: "avisos")`. Servidor fora → item escondido (não "0 avisos"). O título da barra não muda (decisão 18). `App.tsx`: `useState<View>(() => viewFromHash() ?? 'inicio')` + `hashchange` → `setView`; `viewFromHash` aceita só as chaves do menu lateral.
- [ ] **Step 4: Run test to verify it passes** Run: `build/Folga.app/Contents/MacOS/Folga --selftest && npm test && npm run typecheck` Expected: verde. Ao vivo: com um aviso real (ex.: o travamento da Task 3), o menu mostra "1 aviso"; clicar abre a janela já em Avisos; com a janela aberta em outra tela, clicar troca para Avisos; com as notificações desligadas a contagem aparece igual.
- [ ] **Step 5: Commit**
  ```bash
  git add mac/Folga.swift web/src/App.tsx
  git commit -m "menu da barra mostra quantos avisos há e abre a tela Avisos, com ou sem notificação ligada

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 7: Aviso crítico vira notificação (decisão 20)

**Files:** Modify `src/warnings.ts` (`apply`, `WarningsDeps`), `src/tests/warnings.test.ts`, `src/server.ts`
**Interfaces:** Produces: dep opcional `notify?: (title: string, body: string) => void` no `WarningsDeps` · regra: quando um aviso com `severity === 'critico'` entra (id que não estava notificado), chama `notify(w.title, w.detail)` uma vez; o id fica marcado até sair da lista; saiu e voltou → notifica de novo. `atencao`/`info` nunca notificam. Subir de atenção para crítico com o mesmo id conta como entrada (notifica uma vez).

- [ ] **Step 1: Write the failing test** — rig com `notify` gravado: memória 98 % → 1 chamada com "Memória quase esgotada"; mais dois `run.fast()` iguais → continua 1; memória 40 % (sai) e 98 % de novo → 2; memória 92 % (atenção) e um disco com 8 % livre (atenção) → nenhuma; atenção 92 % → 98 % → 1 (subiu para crítico); sonda fora > 30 s (crítico) → 1; Auto Care (`info`) → nenhuma; `warningsLevel` `'todos'` e `'criticos'` dão o mesmo resultado (as duas mostram crítico, R27); depois de `stop()` nada notifica; `notify` que lança não derruba o `apply` nem impede o `emit`. Os casos atuais sem `notify` continuam iguais.
- [ ] **Step 2: Run test to verify it fails** Run: `node --no-warnings src/tests/warnings.test.ts` Expected: nenhuma chamada a `notify`.
- [ ] **Step 3: Implement** — no `apply`, depois de atualizar `active`: um `Set` `notified`; para cada crítico ativo fora dele → adiciona e chama `notify` dentro de `try`; ids que saíram de `active` (ou deixaram de ser críticos) saem do `Set`. `server.ts`: `notify: (t, b) => notify.toast(t, b)` no `createWarnings` (closure: o `notify` do servidor já existe quando `warnings.start()` roda). O texto vai pelo caminho de sempre (`notify.ts`: só ambiente, Folga.app com `osascript` de reserva — Task 2); notificação de aviso crítico só no Mac (decisão 20; o Windows fica como está até o Antônio pedir).
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck` Expected: verde nos dois sistemas. Ao vivo (pasta de dados temporária, `FAKE_MAC=1` com memória forçada acima de 97 %): uma notificação só em 2 min; nenhuma para atenção. Nunca encher o disco de verdade para testar.
- [ ] **Step 5: Commit**
  ```bash
  git add src/warnings.ts src/tests/warnings.test.ts src/server.ts
  git commit -m "aviso crítico vira notificação uma vez por id até sair; atenção e informação ficam na tela

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 8: Revisão de segurança dedicada e emendas

**Files:** `.claude/requirements.md` (R26 e R31 com a parte do Mac, emenda); o que a revisão achar, com teste novo no módulo.
**Interfaces:** Consumes: `git diff d2826c5..HEAD`. Produces: achados com veredito na mensagem do commit (ou "nenhum achado").

- [ ] **Step 1: Write the failing test** — roteiro do revisor (novo, sem o contexto desta sessão): os 5 itens do Review Focus; notificação de aviso crítico repetida ou com texto de arquivo; nome de `.ips`/plist chegando ao menu, à notificação ou ao `server.log` (injeção de texto, quebra de linha forjando linha de log); leitura de `crashDir` seguindo link simbólico para fora (usar `lstat`, ignorar links); arquivo gigante ou `.ips` sem quebra de linha (lê só 4 KB); `launchctl`/`fdesetup` pendurado (timeout de 20 s mata e o `job` libera); `lsregister -f` só com o caminho do app instalado; o `#hash` não vira navegação para fora (`allowedURL`); nenhum comando com administrador, nenhum `.env` tocado. Resíduo aceito, para não reabrir: `GET /api/warnings` e `/api/startup-apps` respondem a qualquer processo local, como as outras leituras.
- [ ] **Step 2: Run test to verify it fails** Run: a skill `security-review` sobre o branch e um `code-review` nível `high` com o foco acima Expected: lista de achados, cada um com cenário concreto.
- [ ] **Step 3: Implement** — confirmar cada achado por sonda (pasta temporária, app em `build/`) antes de corrigir; descartado fica registrado com o porquê. Correção = menor diff + teste que pina o cenário. Emendar R26 (no Mac: travamento por DiagnosticReports, segurança `info` no lugar do antivírus) e R31 (no Mac: Folga.app com `osascript` de reserva, contagem no menu; aviso crítico também notifica, decisão 20).
- [ ] **Step 4: Run test to verify it passes** Run: `npm test && npm run typecheck && node scripts/mac-app.mjs build && node scripts/mac-app.mjs check build/Folga.app`, depois `git push fork mac-port` Expected: tudo verde, os dois jobs da CI verdes. Só então o plano conta como feito.
- [ ] **Step 5: Commit**
  ```bash
  git add -A mac src scripts web .claude
  git commit -m "revisão de segurança dos avisos do Mac: <achados e correções>; R26/R31 com a parte do Mac

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

**Fica para os próximos planos (sem pintar o canto):** itens de login ficam fora (decisão 21: sem pedido de Automação); Foco/Não Perturbe (ilegível sem Acesso Total ao Disco); assistente no Mac (spike do ADR 0006, `PATH` de login, matar por grupo); Auto Care por pressão na tela de Ajustes; emendas restantes em `CLAUDE.md`, `fluxo-infraestrutura.md` e o PR para o Antônio.
