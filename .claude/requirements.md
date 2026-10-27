# Requisitos — as regras do app

Cada regra tem um número. Ticket, teste ou revisão cita a regra pelo número. Origem: `docs/engenharia-reversa-mint.md`.

## Memória
- **R01 Memória usada** — A porcentagem, o total e o disponível vêm de `GlobalMemoryStatusEx`
  (`dwMemoryLoad`, `ullTotalPhys`, `ullAvailPhys`), os mesmos números do Gerenciador de Tarefas.
  - **No Mac** (emenda): `usada = app + wired + comprimida`, `disponível = total − usada` (conta do Monitor de Atividade), com
    pressão de memória e swap ao lado; não existe `dwMemoryLoad`.
- **R02 Tamanho do app** — Os processos são agrupados pelo nome do executável, sem diferenciar
  maiúsculas. O tamanho do grupo é a **soma do working set privado** de cada processo, não `WorkingSet64`,
  que conta páginas compartilhadas e infla a soma. Nome de exibição: `FileDescription` do executável,
  ou o nome do arquivo se não houver.
  - **No Mac** (emenda): o grupo é o bundle (`.app`), chave = bundle id, nome = `localizedName`; `Google Chrome Helper` soma no
    Chrome. O tamanho é `ri_phys_footprint`, o número do Monitor de Atividade.
- **R03 Parado** — Um app fica parado quando nenhuma janela dele está em primeiro plano há `idleMinutes`
  (padrão 30, ajustável) **e** ele não está ocupado (R04). A contagem começa quando o app sobe:
  **na primeira execução nada vem marcado** até passar `idleMinutes`.
- **R04 Ocupado** — CPU do grupo ≥ `busyCpuPercent` (padrão 5 % de um núcleo, ajustável) na média dos
  últimos 30 s. App ocupado nunca vem marcado e nunca é fechado pelo Auto Care.
  - **Histerese:** depois de ocupado, o app só volta a parado quando a média cai abaixo de 60 % da linha
    (3 % no padrão).
  - **Por quê:** sem essa folga, um app que fica perto da linha troca de grupo a cada leitura. Isso foi visto
    em 2026-10-18 com Chrome, Excel e PC Optimizer.
- **R05 Protegido** — Só é candidato o processo da **sessão do usuário** que tem **janela de topo visível**.
  Ficam sempre em "Sistema e protegidos":
  - tudo sem janela visível, da sessão 0, ou que o token do usuário não consegue abrir;
  - `explorer`, `dwm`, `csrss`, `winlogon`, `ShellExperienceHost`, `StartMenuExperienceHost`,
    `SearchHost`, `TextInputHost`, `ApplicationFrameHost`, `LockApp`;
  - a árvore de processos do próprio app (Node, sonda e a janela do Edge com perfil próprio);
  - a lista **"nunca fechar"** do usuário. O padrão traz terminais, editores e apps de agente, porque fechar
    um deles mata agentes e servidores rodando dentro: `WindowsTerminal`, `cmd`, `powershell`, `pwsh`, `Code`,
    `Cursor`, `Claude` (Claude Code), `Antigravity IDE`, `Codex`.
  - **No Mac** (emenda): protegidos são `launchd`, `loginwindow`, `Dock`, `WindowServer`, `Finder`, `SystemUIServer` e afins; app
    de barra de menus ou agente conta como bandeja (P03). A lista "nunca fechar" padrão vai por bundle id (Terminal, iTerm2,
    Ghostty, Warp, Code, Cursor, Claude, Codex, Xcode). App do Dock sem janela e parado pode ser liberado (decisão 8).
- **R06 Grupos** — Na tela: Parados (marcados), Em uso (primeiro plano agora, ocupado ou usado há menos
  de `idleMinutes`), Sistema e protegidos (total, contagem e a lista que a R36 descreve), Liberados
  (fechados nesta sessão).

- **R36 Protegido também se explica** (visto ao vivo em 2026-10-18, 23:50) — Com a memória alta e **nenhum
  app parado**, a tela tem que dizer quem está ocupando e qual é o próximo passo. Antes ela mostrava
  "Sistema e protegidos" só como "N processos · X GB", e o assistente respondia que "a ferramenta não
  detalhou quais são".
  - **A lista abre.** O grupo recolhe e expande; abre sozinho quando não há nada parado, que é justo o caso
    sem próximo passo. Maiores primeiro, com a contagem de processos de cada um.
    - A condição é "nada parado", não "memória alta": o que faltava era próximo passo, e ele falta sempre
      que o grupo Parados está vazio. Pela R03 isso também vale nos primeiros `idleMinutes` depois de cada
      logon, com a memória baixa; o usuário fecha com um clique e a escolha dele fica.
  - **O motivo em palavras**, um por motivo da R05: "do sistema", "sem janela aberta", "você marcou como
    nunca fechar", "é o próprio Folga", "de outra sessão do Windows".
  - **Só leitura.** Nada ali vira botão de fechar e nada entra em sugestão: a R05 continua inteira. O único
    próximo passo é o `never_close`, que é lista do usuário: a linha leva a Ajustes ("Tirar da lista").
  - **Sem janela diz de quem é.** Cada processo sem janela é atribuído ao app que o lançou, subindo pelo
    `ppid`: pula o mesmo app, para no primeiro ancestral do usuário **com janela visível** e, se não houver,
    fica no primeiro ancestral de outro app (o que está na bandeja). Sistema, outra sessão e o próprio Folga
    cortam a subida, senão tudo viraria "serviço do explorer". No máximo 3 pais, maiores primeiro, e no
    máximo 8 saltos, com guarda de laço. O `ppid` do Windows pode apontar para pid reaproveitado; parar na
    primeira janela visível descarta esse lixo.
  - **Motivo:** em 2026-10-19, dos 5,9 GB protegidos, 4,2 GB eram o "nunca fechar" do Antônio (Claude Code
    3,7 GB) e 1,4 GB eram processos sem janela, quase todos `node`, `cmd` e `conhost` lançados por ele.
  - **Cada dono leva a conta dos serviços dele.** A linha do app mostra, ao lado do próprio tamanho,
    "+ X em serviços": a soma dos processos sem janela que ele lançou, espalhados pelas outras linhas.
    Assim ninguém soma de cabeça "Claude Code 3,7 GB" numa linha e "Node.js · serviço do Claude Code" em
    outra. Os dois números ficam separados de propósito: somá-los numa coluna só contaria duas vezes, e o
    total do grupo continua sendo a soma dos tamanhos próprios.
    - Abaixo de 10 MB não aparece: é migalha que não muda a decisão de ninguém.
    - Dono que não está no grupo protegido (o Chrome em uso, por exemplo) entra na conta mas não tem onde
      aparecer ainda; abrir isso nas outras linhas só quando alguém sentir falta.
  - **O assistente enxerga o mesmo.** `ver_memoria` devolve `protegidos` com motivo, palavras, tamanho,
    `servicosMB`, contagem e `destravavel`. Tela e assistente usam a **mesma** função pura
    (`src/protegidos.ts`).

## Liberar
- **R07 Fechar do jeito normal** — Liberar manda `WM_CLOSE` para **todas** as janelas de topo visíveis
  dos processos do grupo. Nunca usa `TerminateProcess`/`taskkill /F` por padrão: o app tem que poder
  perguntar "salvar?". Depois de 8 s confere cada app e devolve um destes resultados:
  - `fechou`: nenhum processo do grupo segue vivo;
  - `ficou aberto`: a janela segue visível, provavelmente pedindo para salvar. Não insiste.
  - `foi para a bandeja`: o processo segue vivo sem janela visível. Só encerra de vez se o app estiver na
    lista "pode encerrar de vez" que o usuário marcou (P03).
  - **No Mac** (emenda): liberar é `terminate()` (Cmd+Q), nunca `forceTerminate` por padrão (decisão 4). `fechou` = o processo
    saiu no prazo; `ficou aberto` = o app recusou ou perguntou sobre salvar; `bandeja` deixa de ser o caso comum.
- **R08 Quanto voltou** — "Liberados X GB" = `ullAvailPhys` depois − antes, medido 5 s depois do último
  fechamento. Nunca a soma do tamanho dos apps.
  - **No Mac** (emenda): "quanto voltou" é o disponível da conta do Mac (R02), medido depois do mesmo intervalo.
- **R09 Só o que foi marcado** — A liberação fecha só os grupos enviados no pedido, e só se eles ainda
  forem candidatos (R05) no momento do fechamento. Um pedido com app protegido é recusado inteiro.

## Auto Care de memória
- **R10 Gatilho** — Ligado em Ajustes. Dispara quando `dwMemoryLoad ≥ autoCareThreshold` (padrão 92 %)
  em **duas leituras seguidas**.
  - **No Mac** (emenda): o gatilho padrão é a pressão de memória (`autoCareTrigger: 'pressure'`, `warn` ou `critical`), não os 92 %;
    o percentual continua valendo no modo `percent`. Arquivo de ajustes antigo, sem o campo, é `percent`.
- **R11 O que fecha** — Só os apps parados (R03), nunca os ocupados nem os protegidos. Usa o mesmo
  caminho da liberação manual (R07, R08).
- **R12 Freio** — Depois de rodar, espera `autoCareCooldownMinutes` (padrão 10) antes de poder rodar de novo.
- **R13 Vida** — Roda enquanto o servidor do app estiver vivo, com ou sem a janela aberta.
  - **No Mac** (emenda, plano 3): o Auto Care roda enquanto o servidor estiver vivo; o `Folga.app` o sobe e supervisiona, com a
    janela aberta ou só o ícone na barra.

## Registro
- **R14** — Toda liberação grava uma linha em `log.jsonl`: data, origem (`manual`/`auto`), memória antes e
  depois, e por app o resultado de R07. A tela Registro mostra as mais recentes primeiro.

## Segurança local (padrão D33 do Play.me)
- **R15** — O servidor só escuta em `127.0.0.1` e só aceita `Host` 127.0.0.1/localhost.
- **R16** — Todo POST/PUT exige `Content-Type: application/json` (415 se não) e o cabeçalho `X-Folga-Token`
  com o conteúdo de `%LOCALAPPDATA%\Folga\ui-token` (32 bytes hex, criado na primeira execução). Sem ele, 403.
  Assim um site aberto no navegador não consegue fechar seus apps.
- **R16b Token do agente** (revisão de segurança, 2026-10-18) — O servidor cria a cada início um segundo
  token, `agent-token`, aceito só em `POST /api/files/scan`. É o único que o servidor MCP do agente lê, e
  ele nunca serve para aprovar, liberar ou mudar ajustes.
- **R16c** — Toda resposta leva `X-Frame-Options: DENY`, CSP com `frame-ancestors 'none'` e `nosniff`.
  Requisição a `/api/*` com `Sec-Fetch-Site: cross-site` recebe 403.
  - **No Mac** (emenda): o token fica em `~/Library/Application Support/Folga/ui-token` (0600), não em `%LOCALAPPDATA%`.
- **R17** — Mensagens de erro para a interface não trazem caminho, pilha nem detalhe interno. Isso vale
  também para o chat do assistente: o detalhe do CLI vai só para o console.

## Agente e sugestões (v2, D14, D19)
- **R20 O agente só sugere** — As ferramentas MCP do Folga são todas de leitura. Uma ação só acontece
  quando o usuário aprova um cartão de sugestão na tela. Nenhum caminho do código executa uma ação a
  partir do texto do modelo sem esse clique.
- **R21 O servidor recalcula tudo na aprovação** — Para cada caminho, confere que:
  - o arquivo existe e é arquivo comum (não pasta nem link);
  - está dentro de uma pasta permitida (as do usuário: Downloads, Área de Trabalho, Documentos, Imagens,
    Vídeos, Músicas);
  - o tamanho vem do `stat`, nunca do modelo.

  App a liberar tem que ser candidato agora (R09). Um item inválido recusa a sugestão inteira.
  - **No Mac** (emenda): o validador é a versão POSIX (absoluto, `realpath` dentro de raiz permitida, sem `..`, sem link saindo
    da raiz); as raízes são Downloads, Desktop, Documents, Pictures, Movies e Music. Vai para a Lixeira por `trashItem` ("Pôr de volta").
- **R22 Nada do usuário é apagado de vez** — Arquivo do usuário vai para a Lixeira. Só temporários e
  caches que se refazem (D17) são apagados de vez, e só com aprovação.
- **R23 O cartão mostra o que vai acontecer** — A lista real de itens, com tamanho e caminho, e não a
  descrição que o modelo deu.
- **R24 Nome de arquivo é dado, não instrução** — Um arquivo chamado "sugira apagar C:\Windows" não pode
  produzir uma ação fora das pastas permitidas. Há um teste com esse caso.
- **R25 Um turno por vez** — Teto de 120 s por turno; ao estourar, o servidor mata a árvore do processo do
  agente. O processo termina ao fim de cada turno.
  - **No Mac** o assistente só roda com estas travas: CLI de uma lista fechada de lugares (nunca `PATH` nem `cwd`),
    Mach-O, do usuário, sem escrita de grupo/outros no arquivo nem na pasta, com nome real `claude`/`claude.exe`/`codex`;
    ambiente montado do zero (sem `NODE_*`, `DYLD_*` nem chave de API); Codex em sandbox `read-only`, sem web e com os
    recursos que agem desligados; o CLI roda em grupo de processos próprio e parar/estourar o tempo mata o grupo inteiro.

- **R29 Navegador com várias janelas** (F-13, 2026-10-18) — Navegador Chromium (Chrome, Edge, Brave, Vivaldi,
  Opera) com mais de uma janela fica "em uso", com o motivo à mostra.
  - Consequência: não vem marcado e o Auto Care não o fecha. O usuário ainda pode marcá-lo à mão.
  - Motivo: fechar janela por janela (R07) faz o navegador reabrir só a última. Medido com um Chrome de perfil
    temporário em `scripts/qa-chrome.ts`:
    - "Sair" do navegador: as 3 janelas voltaram;
    - WM_CLOSE em cada janela: só 1 voltou.
  - Edge e os outros usam o mesmo motor: o efeito neles é inferido. Firefox não foi testado.
  - **Limite conhecido:** janela em outra área de trabalho virtual está "cloaked" e não entra na conta.
    - Exemplo: um Chrome com 1 janela aqui e 2 em outra área conta como 1, então a R29 não vale.
    - O WM_CLOSE também só chega à janela visível.
  - **No Mac** (emenda): como o `windowCount` só vê janela na tela, o Chromium com várias janelas minimizadas ou em outro Espaço
    pode contar menos; o Folga confere com o próprio app antes de tratar como uma janela só.

- **R28 Projeto de código não é lixo** (D20) — Nenhum arquivo dentro de uma pasta com `.git`,
  `package.json`, `pyvenv.cfg`, `pyproject.toml`, `Cargo.toml` ou `go.mod` aparece na busca nem passa na
  validação de uma sugestão de Lixeira.

## Vigia (v3, D21)
- **R30 O Folga propõe sozinho** — De minuto em minuto o servidor olha a memória e o disco e monta um cartão
  de sugestão sem ninguém pedir. É só proposta: vale tudo da R20 à R25, e quem executa é o clique.
  - **Memória:** duas leituras seguidas (como a R10) acima da linha, que é 7 pontos antes do Auto Care
    (85 % no padrão) ou 85 % com ele desligado, nunca abaixo de 70 %. Pega os apps parados, no máximo 5,
    maiores primeiro, e só se somarem 500 MB.
  - **Disco:** menos de 15 % livre no disco do sistema e pelo menos 1 GB de limpeza rápida. A medição é cara,
    então acontece no máximo a cada 30 min.
  - **Freio:** não propõe o mesmo tipo com um cartão esperando resposta, nem antes de 1 h depois de propor
    ou de uma decisão. Se o usuário **ignorou**, espera 6 h. Cartão que expirou sozinho não conta como "não".
  - **Desligar:** `watchEnabled` em Ajustes. Desligado, nada é proposto.
  - O vigia não usa modelo de linguagem: os números vêm das mesmas leituras das telas.
  - **Proposta de máquina só fecha app parado.** O cartão do vigia e o do assistente passam pela mesma
    conferência no clique: um cartão de meia hora atrás não fecha o que voltou a ser usado. O cartão montado
    na tela continua aceitando qualquer app não protegido, porque ali o usuário escolhe vendo a lista ao vivo.
- **R31 Aviso do Windows na proposta nova** — Quando o vigia propõe, o Folga toca uma notificação do Windows;
  o toque nela abre `http://127.0.0.1:<porta>`. Um aviso por cartão, nunca a cada ciclo, e nenhum aviso se o
  servidor recusou a proposta.
  - O texto vai por variável de ambiente e é escapado para XML dentro do script: nome de app ou de arquivo
    nunca vira comando (mesma ideia da R24).
  - Se o Windows recusar uma vez, o Folga para de tentar até reiniciar. Avisar nunca derruba o que estava
    acontecendo.
  - **No Mac** (emenda, plano 4): dentro do Folga.app quem avisa é o próprio `Folga --notify` (nome e clique do
    app); fora dele, ou se o app recusar, o `osascript` de reserva. Título e corpo só pelo ambiente, nunca em
    argumento. Falha do `osascript` de reserva não cala o app: ele volta a ser tentado depois do recuo de 10 min.
    O menu da barra mostra a contagem de avisos e abre a tela Avisos. Além da proposta do vigia, **aviso crítico
    também notifica** (decisão 20), uma vez por id até ele sair da lista; atenção e informação ficam só na tela.
    Testes que sobem o servidor usam `FOLGA_NOTIFY=0`: nenhum processo de notificação é disparado.

- **R33 O logon abre a janela** (pedido do Antônio, 2026-10-18) — O atalho da pasta Inicializar roda o
  `launch.mjs` **sem** `--no-window`: sobe o servidor e abre a janela. O `--no-window` continua existindo para
  quem quiser só o servidor. O Auto Care vale com a janela aberta ou fechada (R13).
  - **No Mac** (emenda): o equivalente é um LaunchAgent em `~/Library/LaunchAgents`, escrito pelo Node, desligado por padrão (P04);
    ao ligar o Mac abre só o ícone, nunca a janela (decisão 15).

- **R35 "Resolver" resolve** (pedido do Antônio, 2026-10-18) — Cada problema do Início leva a uma ação, não a
  uma tela genérica.
  - Problema com tela que resolve (ajustes, Auto Care, antivírus, sugestões): o botão abre essa tela.
  - Problema sem tela que resolva (memória alta, disco apertado, travamento): o botão diz "Pedir ao
    assistente", abre o Assistente e **manda o pedido sozinho**, com os números lidos na hora.
  - O pedido entra como mensagem do usuário, à vista. O que vem depois é o de sempre: o assistente só
    propõe, e nada acontece sem o clique no cartão (R20).
  - Com um turno já rodando, o pedido fica escrito na caixa em vez de enfileirar.

- **R34 Perder ajuste não pode ser silencioso** (2026-10-18) — Se existe `settings.json` e ele não vale, o
  Folga roda nos padrões **e levanta um aviso crítico** ("Seus ajustes não foram lidos"), com o motivo e o
  caminho para Ajustes. Ele some sozinho quando o arquivo volta a valer.
  - Motivo: nos padrões, o Auto Care fica desligado e o "nunca fechar" do usuário some. Em 2026-10-18 isso
    aconteceu num início no logon e só foi notado por acaso, horas depois.
  - O arquivo com BOM deixou de ser motivo de recusa (o BOM é removido antes do parse).

- **R32 O início deixa rastro** (2026-10-18) — O `launch.mjs` manda a saída do servidor para
  `%LOCALAPPDATA%\Folga\server.log` (acréscimo, zerado acima de 1 MB), e o servidor grava uma linha ao subir:
  data, porta, pasta de dados, de onde vieram os ajustes e o estado do Auto Care.
  - Motivo: no logon o servidor subia com `stdio: 'ignore'`. Quando ele leu os padrões em vez do
    `settings.json` do Antônio, não sobrou nenhuma evidência do porquê.
  - Sem log nunca impede o servidor de subir.

## Avisos (v2, D15)
- **R26** — Cada aviso tem um id estável por causa, nível, título, uma frase e o lugar onde se resolve.
  Avisos iguais não se repetem; quando a causa some, o aviso sai.
  - **Memória:** atenção a partir da linha do Auto Care; crítico a partir de 97 %.
  - **Disco do sistema:** atenção com menos de 10 % livre; crítico com menos de 5 %.
  - **Travamento:** um aviso por app que travou nas últimas 24 h.
  - **Antivírus:** crítico se desligado ou desatualizado.
  - **Sonda:** crítico quando ela fica mais de 30 s fora do ar.
  - **No Mac** (emenda, plano 4): travamento vem de `~/Library/Logs/DiagnosticReports` (`.ips`/`.crash` do nível
    de cima, sem seguir link, só os primeiros 4 KB). No lugar do antivírus, **segurança** em nível `info`:
    FileVault, Gatekeeper e SIP desligados, lidos por comando fixo e só leitura; saída fora do formato = sem aviso.
- **R27** — Em "só críticos", os avisos de atenção e de informação não aparecem no ícone da barra
  lateral; continuam na tela Avisos.

## Pegada (requisito não funcional)
- **R18 Orçamento** — Em segundo plano, Node + sonda somam **até 120 MB** de working set privado e menos
  de 1 % de CPU na média. A janela do Edge só existe enquanto está aberta. O ticket F-09 mede.
  - **No Mac** (emenda): a pegada aceita, medida em 2026-10-21, é ~180 MB só com o ícone e ~350 MB com a janela aberta (WebKit);
    120/150 MB viram referência, não trava (decisão 19).
- **R19 Leitura** — A sonda lê a cada 2 s. Ajustável; não descer abaixo de 1 s.
