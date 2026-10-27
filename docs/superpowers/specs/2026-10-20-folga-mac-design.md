# Folga no Mac — desenho

Data: 2026-10-20 · Branch: `mac-port` (fork `vittoriofbrun-blip/folga`, origem `FainowAI/folga`)

## Intenção e por quê

O Folga hoje é um app de Windows (do Antônio) que mostra quem segura a memória, fecha do jeito normal os apps
parados, acha arquivos esquecidos e limpa temporários, com um assistente de IA que só sugere. O Vittorio quer
o mesmo no Mac dele para cuidar das duas dores que sente ao mesmo tempo: **disco enchendo e Mac lento**.

Estado real do Mac (raio-X de 2026-10-20, só leitura):
- MacBook Air M2, **8 GB**, macOS 26.5.1. Swap em **3,9 GB de 5 GB** — a lentidão é pressão de memória.
- Disco: 228 GB, **160 GB usados (81 %)**, 39 GB livres.
- As pastas do usuário pesam pouco (Downloads 0,9 GB, Documentos 1 GB). O peso está em
  `~/Library/Application Support` (27 GB) e `~/Library/Caches` (5,5 GB).
- Exemplo do que **não** é lixo: dos 13 GB do app Claude, 11 GB são o disco da máquina virtual dele
  (`vm_bundles/claudevm.bundle/rootfs.img` 10 GB + `rootfs.img.zst` 1,1 GB). Cache de verdade: ~0,8 GB
  (`Cache`, `Code Cache`, versões antigas em `claude-code/<versão>`). Chrome: perfil `Default` 3,1 GB.
- Ferramentas já instaladas: Node 24.18, Swift 6.3.2 (Command Line Tools, sem Xcode), CLIs `claude` e `codex`.

## Decisões do Vittorio (nesta conversa)

1. **Escopo: o app inteiro** — memória, Auto Care, armazenamento, avisos, registro e o assistente.
2. **Um código só para Windows e Mac.** O Windows do Antônio não pode quebrar; o fork deve poder virar PR
   para `FainowAI/folga`.
3. **Armazenamento mira em pastas + dados dos apps.** Além do que o Folga já faz (arquivos parados, temporários,
   cache de navegador), mostra quanto cada app guarda e limpa **só o que o app recria sozinho**.
4. **Liberar memória no Mac = encerrar o app como Cmd+Q** (pedido de saída normal; o app pode perguntar
   sobre salvar). Nunca forçar por padrão.
5. **App de Mac leve com ícone na barra de menus**, que abre a mesma interface React numa janela WebKit
   (motor do Safari), não o Chrome.
6. **O Antônio topa receber o Mac.** O pacote inteiro (código, emendas nos documentos, ADRs novos) vai como PR
   para `FainowAI/folga` no fim.
7. **"Dados dos apps" vale nos dois sistemas.** O Windows ganha a mesma visão, com a própria allowlist de caches
   em `%LOCALAPPDATA%`/`%APPDATA%` (Chrome/Edge/Electron: `Cache`, `Code Cache`, `GPUCache`, …; versões antigas
   do Claude Code se existirem lá).
8. **App do Dock sem janela e parado pode ser encerrado (Cmd+Q).** É o desperdício mais comum no Mac. App de
   barra de menus/agente continua protegido (P03).

### Decisões do Vittorio (2026-10-20, plano 2)

9. **Medir `~/Library/Containers` e `Group Containers`**, aceitando o aviso único do macOS "acessar dados de outros
   apps". Quem constrói nunca responde o aviso no lugar dele.
10. **Acesso Total ao Disco: sim, mas só para o `Folga.app` (plano 3), nunca para o `node`.** Liberar para o `node`
    daria acesso total a todo script Node do Mac. No plano 2, o que depende dele (tamanho da Lixeira, cache do Safari)
    é lido pelo binário Swift e, sem a permissão, aparece como "não deu para ler".
11. **O assistente pode propor "limpar cache do app X"** pelo cartão de sempre (R20–R25). O servidor revalida tudo no
    clique, com a mesma allowlist e o app fechado; as ferramentas do agente continuam só de leitura.
12. **`.app` velho em `~/Downloads` (e só lá) pode ir para a Lixeira**, como um item só, com o tamanho total e o
    último uso pelo Spotlight. Em qualquer outra pasta o pacote continua fechado; nunca um `.app` de `/Applications`.

### Decisões do Vittorio (2026-10-21, plano 3)

13. **Barra de menus mostra ícone + "62% · 39 GB"** (memória usada · disco livre).
14. **"Liberar parados" do menu mostra a lista e pede OK** antes de encerrar.
15. **Ao ligar o Mac (se ativado), só o ícone** — a janela não abre sozinha.
16. **Pode criar a assinatura local "Folga Local"** (chave só no Mac, na pasta do Folga) para a permissão de disco não
    sumir a cada atualização.
17. **O Folga NÃO pede Acesso Total ao Disco** (2026-10-21, depois da revisão de segurança do plano 3). Com o servidor
    Node dentro do bundle, uma cópia adulterada do app herdaria a permissão (o selo dos recursos não é conferido ao
    executar) e qualquer processo local poderia usá-la pela API. Substitui a parte "pedido pelo Folga.app" das
    decisões 10 e 16. Perde-se: tamanho da Lixeira, tamanho do cache do Safari e busca no iCloud Drive. Se a permissão
    aparecer ligada mesmo assim, o app avisa para desligar.
18. **Barra de menus: ícone + só a memória ("81%")** (2026-10-21, teste ao vivo). Com "81% · 34 GB" o item ficava
    escondido atrás do entalhe do MacBook Air; o disco livre aparece ao clicar. Substitui a decisão 13.
19. **Pegada aceita como medida** (2026-10-21): ~180 MB só com o ícone e ~350 MB com a janela aberta (o WebKit da
    janela é o que pesa). As metas de 120/150 MB viram referência; abrir a janela só quando for olhar.

### Decisões do Vittorio (2026-10-21, plano 4)

20. **Aviso crítico também vira notificação** (ex.: disco quase cheio, memória crítica). Só o nível crítico, uma vez
    por aviso até ele sair da lista (se voltar depois, avisa de novo), pelo mesmo caminho de notificação do app; vale
    nos dois modos de "Avisos no ícone" (todos / só críticos). Atenção e informação ficam só na tela Avisos e na
    contagem do menu.
21. **Itens de login ficam de fora.** Ler os itens de login pediria Automação (System Events) ou senha de
    administrador (`sfltool`); o Folga não pede nenhum dos dois. A tela mostra só LaunchAgents/LaunchDaemons e diz isso.

## Objetivos

- Rodar no Mac com as mesmas telas e o mesmo comportamento do Windows, trocando só as peças do sistema.
- Mostrar memória e disco de forma honesta para o Mac (compressão de memória, espaço "purgeable").
- Liberar memória encerrando apps parados com Cmd+Q, com as mesmas proteções (R05, nunca fechar a lista
  `neverClose`, nunca o app em primeiro plano, nunca quem toca áudio).
- Mapear o armazenamento: pastas do usuário, iCloud Drive, dados por app e caches, Lixeira.
- Assistente funcionando no Mac pelos CLIs `claude` e `codex` já logados.
- Pegada baixa: o Folga inteiro (servidor + sensor + janela aberta) cabe num Mac de 8 GB sem virar parte
  do problema. Alvo: ≤ 150 MB com a janela aberta, ≤ 120 MB só em segundo plano (R18).

## Não-objetivos

- Distribuição pública, App Store, notarização, auto-update.
- Desinstalar apps, "otimizar", organizar arquivos.
- Fechar janelas individuais pelo Accessibility (a R29 do Chrome com várias janelas vira "encerrar o app").
- Paridade de avisos que não têm equivalente no Mac (antivírus).

## Anti-objetivos (falhou mesmo se funcionar)

- Apagar algo que o usuário ou um app precisa: conversas, logins, configurações, máquinas virtuais, bibliotecas
  de fotos, arquivos do iCloud que só existem na nuvem. **Arquivo do usuário só vai para a Lixeira** (com
  "Pôr de volta"); apagar de vez só cache reconhecido de app fechado e temporário velho.
- "Limpador de RAM" (`purge`, forçar compressão) — ADR 0004 vale também no Mac.
- Encerrar app à força, ou encerrar algo com trabalho não salvo sem o app ter chance de perguntar.
- Quebrar o Windows do Antônio.
- O Folga gastar memória demais (ex.: janela em Chrome) num Mac que já está em swap.

## Restrições

- Tudo que o `CLAUDE.md` chama de "regras que não se quebram" continua valendo (localhost + token, agente só
  sugere, menor diff, dependência nova só com motivo escrito, teste `node:assert` para lógica com regra).
- Sem Xcode: só `swiftc` das Command Line Tools. Sem projeto `.xcodeproj`; o `.app` é montado por script.
- Sem dependência nova de npm para o Mac.
- Permissões do macOS (TCC): o app deve funcionar **sem** pedir Gravação de Tela nem Acessibilidade. Pedir
  "Automação" (Apple Events para Finder/System Events) é aceitável, uma vez, com explicação.

## Como (decidido)

### Camada de plataforma

`process.platform` escolhe a implementação. As peças de sistema hoje espalhadas (`powershell.exe`, `reg.exe`,
caminhos `%LOCALAPPDATA%`) passam a viver atrás de funções pequenas por plataforma, sem framework de
plugins. Lógica pura (`classify`, `release`, `autocare`, `watch`, `suggestions`, `selection`, `samples`) fica
única e recebe dados normalizados.

### Sensor (sonda) do Mac

Binário Swift `probe/probe-mac.swift`, compilado com `swiftc -O` por `scripts/build-probe.mjs` (que passa a
escolher csc ou swiftc). Mesmo contrato de linhas JSON da sonda C# (`src/types.ts`): snapshot a cada
`sampleSeconds`, comandos `close`/`kill` no stdin, `reply` no stdout. Mapeamento:

| Campo | Fonte no Mac |
|---|---|
| processos (pid, ppid, nome) | `proc_listallpids` + `proc_pidinfo` |
| memória por processo (R02) | `proc_pid_rusage` → `ri_phys_footprint` (o número do Monitor de Atividade) |
| CPU acumulada | `proc_pid_rusage` user+system (converter mach ticks) |
| nome de exibição / app | `NSRunningApplication` (`localizedName`, `bundleIdentifier`, `activationPolicy`) |
| janelas visíveis | `CGWindowListCopyWindowInfo` camada 0, sem título (não exige Gravação de Tela) |
| primeiro plano | `NSWorkspace.frontmostApplication` |
| áudio | CoreAudio `kAudioProcessPropertyIsRunningOutput` (macOS 14.4+) |
| atividade do disco | deltas de IOKit `IOBlockStorageDriver` Statistics (aproximação de "% ocupado") |
| `close` | `NSRunningApplication.terminate()` (Cmd+Q) |
| `kill` | `forceTerminate()` — só quando o contrato já permitiria `kill` no Windows |

`session` vira "mesmo uid do usuário"; `accessible` vira "consegui ler o processo".

### "App" no Mac

Agrupar por **bundle** (`.app`), não por nome de executável: `Google Chrome Helper (Renderer)` soma no
Google Chrome. Chave estável = bundle id; nome exibido = `localizedName`. Apps com `activationPolicy` diferente
de `.regular` (barra de menus, agentes) contam como "bandeja" e seguem a regra P03 (não encerrar por padrão).
`launchd`, `loginwindow`, `Dock`, `WindowServer`, `Finder`, `SystemUIServer`, `ControlCenter`, etc. entram na
lista de sistema (R05). `neverClose` padrão do Mac: Terminal, iTerm2, Ghostty, Warp, Code, Cursor, Claude, Codex,
Xcode.

Resultado de liberar (`release.ts`): no Mac, "fechou" = o processo saiu dentro do prazo depois do `terminate`;
"ficou aberto" = o app recusou ou perguntou ao usuário. "Bandeja" deixa de ser o caso comum.

### Memória honesta

O Mac não tem `dwMemoryLoad`. Usar a mesma conta do Monitor de Atividade:
**usada = app + wired + comprimida**; **disponível = total − usada**. Expor também a **pressão de memória**
(`kern.memorystatus_vm_pressure_level` / `memorystatus_level`) e o swap usado. R08 ("liberados X GB = disponível
depois − antes") usa essa disponível, medida depois de um pequeno intervalo. Gatilhos padrão no Mac: Auto Care
por **pressão "atenção"** (amarela) em vez de 92 %; linha de observação equivalente à R30. Os percentuais ficam
ajustáveis como hoje.

### Armazenamento

Uma tela, três blocos:

1. **Suas pastas** — o "arquivos parados" de hoje com raízes do Mac: `~/Downloads`, `~/Desktop`,
   `~/Documents`, `~/Pictures`, `~/Movies`, `~/Music` e iCloud Drive. Último uso pelo Spotlight
   (`kMDItemLastUsedDate`, cai para `kMDItemDateAdded`/data de modificação quando faltar, com a base mostrada
   como hoje em `StaleBasis`). Pacotes (`.app`, `.photoslibrary`, `.fcpbundle`, …) são opacos. Arquivo do iCloud
   que só existe na nuvem (dataless) **nunca** entra. Vai para a Lixeira via `NSFileManager.trashItem` no helper
   Swift (mantém "Pôr de volta").
2. **Dados dos apps** — tamanho por app em `~/Library/Application Support`, `~/Library/Caches`,
   `~/Library/Containers`, `~/Library/Group Containers`. Mostra tudo; **limpa só** o que estiver numa lista
   explícita de caches recriáveis (allowlist, nunca denylist), e só com o app fechado. Lista inicial:
   - `~/Library/Caches/*` de apps fechados;
   - `Cache`, `Code Cache`, `GPUCache`, `GraphiteDawnCache`, `DawnWebGPUCache`, `ShaderCache` dentro de pastas de
     apps Electron/Chromium (Claude, Code, Miro, Fathom, Chrome);
   - versões antigas de `Claude/claude-code/<versão>` e `claude-code-vm/<versão>` (manter a mais nova).
   Itens grandes que **não** são cache (ex.: `vm_bundles` do Claude) aparecem com explicação de que não são
   limpáveis pelo Folga.
3. **Temporários e Lixeira** — `$TMPDIR` com mais de 7 dias, caches de navegador fechado (Chrome, Edge,
   Safari), tamanho da Lixeira (`~/.Trash`). Esvaziar a Lixeira continua fora (só informa).

Espaço livre: `statfs` do volume de dados + `volumeAvailableCapacityForImportantUsage`, mostrando o "purgeable"
separado para não parecer mais livre do que é.

O validador de caminhos (R21) ganha a versão POSIX: absoluto, `realpath` dentro de uma raiz permitida (cobre
`/private/var` e firmlinks), sem `..`, sem link simbólico saindo da raiz.

### Janela e ícone na barra

App Swift `Folga.app` (AppKit, sem Xcode): `NSStatusItem` mostrando memória/disco num texto curto, menu com
"Abrir Folga", "Liberar parados", "Sair". A janela é um `WKWebView` apontando para `http://127.0.0.1:4780` com o
token. O app sobe o servidor Node (equivalente ao `scripts/launch.mjs`) e o encerra ao sair. O sensor pode ser
o mesmo binário ou um irmão — decisão do construtor, desde que a pegada fique no alvo.
Abrir com o Mac: LaunchAgent em `~/Library/LaunchAgents` escrito pelo Node (R33), desligado por padrão (P04).

### Avisos (R26 / D15)

- Memória e disco: portáveis.
- Apps que travaram: arquivos novos em `~/Library/Logs/DiagnosticReports` (`.ips`/`.crash`, últimas 24 h).
- Antivírus: **sai** no Mac. No lugar, status de FileVault, Gatekeeper e SIP como informação.
- Itens de inicialização: `~/Library/LaunchAgents`, `/Library/LaunchAgents` e itens de login (`sfltool dumpbtm`
  ou System Events). Sem o estado "desligado" se não houver jeito confiável.

### Notificações

`osascript display notification`. Clique que abre o Folga fica para depois, se o app Swift puder postar a
notificação ele mesmo (`UNUserNotificationCenter`) — escolha do construtor.

### Assistente

Mesma arquitetura (ADR 0006): um processo de CLI por turno, MCP só leitura via HTTP local. No Mac: achar `claude`
e `codex` pelo `PATH` do usuário (hoje em `~/.nvm/versions/node/v24.18.0/bin/`; o app de barra precisa
carregar o PATH do shell de login, porque apps abertos pelo Finder não herdam o nvm). Matar por grupo de
processos (`detached` + `kill(-pid)`) no lugar de `taskkill /T`. Refazer o spike do ADR 0006 no Mac antes de
mexer no código do agente. Texto do `agent-prompt.md` passa a falar do sistema certo.

### Documentos e testes

- `CLAUDE.md`, `project.md`, `requirements.md`, `fluxo-infraestrutura.md` e ADRs 0001–0004, 0006 ganham a parte
  do Mac (emenda, não reescrita). Novo ADR para "Cmd+Q no Mac" e outro para "janela WebKit + barra de menus".
- Testes atuais continuam passando no Windows. Fixtures do Mac novas ao lado (fake probe com bundle ids e uid).
- Testes que dependem do sistema rodam só na plataforma deles (pular explicitamente, com motivo).
- Validação real no Mac do Vittorio: `probe-smoke` do Mac, liberar um app de teste (TextEdit), arquivos parados
  numa pasta de teste, limpeza de cache de um app fechado, assistente respondendo.

## Ordem sugerida (o construtor pode reordenar)

0. CI com Windows e Mac (ver chamadas minhas).
1. Camada de plataforma + caminhos (`~/Library/Application Support/Folga`) + testes atuais verdes no Mac com o
   fake probe.
2. Sensor Swift + memória honesta + agrupamento por bundle → tela Memória funcionando só leitura.
3. Liberar com Cmd+Q + Auto Care por pressão.
4. Armazenamento (pastas, dados dos apps nos dois sistemas, temporários, Lixeira).
5. App de barra + janela WebKit + abrir com o Mac.
6. Avisos e notificações.
7. Assistente.
8. Documentos, ADRs e PR para o Antônio.

Cada fase termina com o Folga utilizável e o Windows intacto (typecheck + testes verdes).

## Deixado para o construtor

- Formato exato da camada de plataforma (arquivos `*.mac.ts`/`*.win.ts` ou funções com `switch`), desde que
  pequena.
- Se sensor e app de barra são um binário ou dois.
- Intervalo e prazos (espera depois do Cmd+Q, intervalo de leitura do disco).
- Texto da interface, mantendo o tom e o visual atuais (D12).

## Chamadas minhas (não decididas pelo Vittorio)

- **Windows conferido por CI.** Não há Windows à mão. Primeira tarefa: GitHub Actions no fork com
  `windows-latest` + `macos-latest` rodando `npm run typecheck` e `npm test` a cada push. Teste preso a um sistema
  pula explicitamente no outro, com motivo; a CI do Windows é a prova de "Windows intacto".
- **Pegada é meta medida, não trava.** `scripts/footprint.mjs` ganha a versão Mac somando `phys_footprint` de
  servidor + sensor + app + processos do WebKit. Se passar de 150 MB, reportar o número e o que pesa; preferir
  sensor e app num binário só se isso ajudar a caber.
- **Auto Care no Mac:** `Settings` ganha `autoCareTrigger: 'percent' | 'pressure'` (padrão `percent` no Windows,
  `pressure` no Mac) e `autoCarePressure: 'warn' | 'critical'`; `autoCareThreshold` continua valendo no modo
  percentual. Configuração salva sem o campo novo = `percent` (sem migração). `memLoad` no Mac = usada/total
  (conta do Monitor de Atividade) e é o que o gráfico da Início mostra.
- **Forçar continua opt-in por app.** No Mac, app que não saiu depois do Cmd+Q e não tem janela vira
  `ficou_aberto`; só é forçado se estiver em `mayForceQuit`, que o usuário preenche à mão, como no Windows.

- Gatilho do Auto Care por pressão de memória em vez de percentual fixo.
- Remover o aviso de antivírus no Mac e trocar por FileVault/Gatekeeper/SIP.
- Lista inicial de caches limpáveis (acima) e manter a versão mais nova do `claude-code`.
- Não exigir Gravação de Tela nem Acessibilidade; aceitar pedir Automação.
- Alvo de pegada ≤ 150 MB com janela aberta.
