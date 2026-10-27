# Projeto — Folga (nome provisório, ver P01)

App de Windows que mostra quais apps estão segurando a memória e fecha, do jeito normal, os que
estão parados. A referência é a frente "Free up memory" do Mint para Mac (`docs/engenharia-reversa-mint.md`).

## Para quem
Antônio, num notebook Windows 11 com 16 GB que satura com várias sessões do Claude Code, servidores
`next dev`/Vite e Chrome. O app é de uso pessoal; distribuição pública não está nos planos.

## O que o app faz (v1)
1. **Memória**: barra de memória usada; apps agrupados em Parados, Em uso, Sistema e protegidos, Liberados;
   os parados já vêm marcados; botão **Liberar**.
2. **Auto Care de memória**: liberado ou não; quando a memória passa da linha que você define (padrão 92 %),
   fecha os apps parados sozinho. Roda enquanto o servidor do app estiver vivo, mesmo com a janela fechada.
3. **Registro**: cada liberação, manual ou automática, com o que fechou, o que ficou aberto e quanto voltou.

Fora da v1: disco, otimizar, organizar, desinstalar, MCP para agentes, partículas animadas (ticket opcional).

## Decisões
- **D01** — Escopo só de memória, Auto Care de memória e Registro. (2026-10-18)
- **D02** — Mesma forma do Play.me, com menos peças: um processo Node 24 com `node:http` em 127.0.0.1 serve
  a SPA React/Vite, JSON e SSE. Sem Agent SDK, sem MCP, sem banco. ADR 0001.
- **D03** — A leitura do Windows fica numa **sonda nativa em C#**, um arquivo `probe/probe.cs` compilado
  pelo `csc.exe` que já vem no Windows (.NET Framework 4.x). Ela fala com o Node por linhas JSON em
  stdin/stdout. PowerShell com `Add-Type` é o plano B. ADR 0002.
  **Emenda (D10, 2026-10-18):** o antivírus apaga o `.exe` sem assinatura, então o padrão é o `probe.cs`
  carregado pelo `Add-Type` do PowerShell (~33 MB). O `.exe` só roda com `FOLGA_PROBE_EXE=1`.
- **D04** — Liberar é mandar `WM_CLOSE` para as janelas do app. **Nunca** encerrar à força por padrão.
  ADR 0003.
- **D05** — Não fazer "limpeza de RAM" com `EmptyWorkingSet` nem esvaziar a lista standby. ADR 0004.
- **D06** — Estado em arquivos: `settings.json` e `log.jsonl` em `%LOCALAPPDATA%\Folga\`. Sem SQLite. ADR 0005.
- **D07** — A janela é o Edge em modo app (`msedge --app=… --user-data-dir=…`), com perfil próprio para
  não se misturar com o Edge do dia a dia. Sem Electron nem Tauri. ADR 0001.
- **D08** — CSS com tokens próprios em vez de Tailwind: são 3 telas. Adicionar Tailwind se passar de ~5 telas.
- **D09** — Ícones de app viram avatares com a inicial (o próprio guia do Mint faz isso). Ícone real depois.

## Decisões da v2 (2026-10-18, pedido do Antônio: McAfee, agente no chat, visual do Mint)
- **D11 (P01)** — O nome é **Folga**. Antônio delegou a escolha: o nome é curto, em português, diz o que o
  app dá ("memória com folga") e não lembra o Mint.
- **D12 (P02, supersede D08 e a regra "sem o verde-limão")** — Visual do Mint por pedido explícito:
  - paleta `#080b08`, `#0e130f`, `#2c322d`, `#edebe5`, `#979d97`, destaque `#bdfe3a`;
  - DM Sans embutida (sem internet) e Geist Mono;
  - barra lateral com ícone e rótulo, títulos grandes, pílulas;
  - partículas na tela Memória (o F-12 entra).

  Continua proibido usar o nome, o logo e a imagem da Terra do Mint.
- **D13 (P03 a P07)** — Padrões ajustáveis em Ajustes:
  - não encerrar app de bandeja (P03);
  - não abrir com o Windows (P04);
  - Auto Care em 92 % (P05, confirmado pelo Antônio);
  - parado depois de 30 min (P06).

  A P07 é respondida pela D16: a v2 traz arquivos parados e limpeza.
- **D14** — Agente no chat, Claude ou GPT, pelos CLIs já logados nas assinaturas; sem chave de API. Ver
  ADR 0006. Um turno por processo; as ferramentas vêm de um único servidor MCP, todas só de leitura.
- **D15** — Avisos com três níveis (crítico, atenção, informação) e o ajuste "todos" ou "só críticos", à
  moda do McAfee. Fontes:
  - memória e disco;
  - apps que travaram (log de Aplicativo do Windows, eventos 1000 e 1002);
  - status do antivírus (Central de Segurança);
  - Auto Care;
  - sonda fora do ar.
- **D16** — "Arquivos que não abro mais":
  - **Sinal de uso:** a hora do último acesso do NTFS, que está habilitada nesta máquina
    (`DisableLastAccess = 2`), reforçada pela pasta Recentes e, por último, pela data de modificação. A
    tela diz qual sinal valeu.
  - **Onde procura:** só nas pastas do usuário (Downloads, Área de Trabalho, Documentos, Imagens, Vídeos
    e Músicas).
  - **Ação:** mandar para a Lixeira, que dá para desfazer.
- **D17** — Limpeza rápida por categoria, inspirada no removedor de rastreador do McAfee:
  - temporários do usuário com mais de 7 dias e cache dos navegadores fechados; esses dados se refazem
    sozinhos e são apagados de vez, só com aprovação;
  - cookies e histórico ficam de fora, para não deslogar você;
  - a lixeira só aparece como informação, porque esvaziá-la é com o Windows.
- **D18** — Início no estilo do painel do Mint e do Relatório do McAfee:
  - anel de memória e anel de disco;
  - nota de saúde de 0 a 100 com palavra de status;
  - os problemas, cada um com o lugar onde se resolve;
  - os avisos e as sugestões pendentes.
- **D19** — O agente nunca executa. Ele escreve sugestões num bloco `folga-sugestao`, e o servidor valida
  e mostra cada uma como cartão; só a aprovação na tela executa (R20 a R24). Uma tentativa de dar
  aprovação automática de ferramentas ao agente foi barrada pelo classificador de segurança, e este
  desenho dispensa isso.

- **D20** — Pastas de projeto de código ficam fora de "arquivos que não abro mais", tanto na busca quanto
  na validação. Uma pasta conta como projeto se tiver `.git`, `package.json`, `pyvenv.cfg`, `pyproject.toml`,
  `Cargo.toml` ou `go.mod`. Motivo: o QA ao vivo achou dependências de um ambiente virtual Python como
  "paradas", e mandá-las para a Lixeira quebraria o projeto. (2026-10-18)
- **D21 O vigia é de regra, não de modelo** (R30) — Quem monitora e propõe sozinho é código com limites fixos
  (`src/watch.ts`), não o assistente. Motivos: um turno de CLI por ciclo gastaria a assinatura do Antônio e a
  pegada da R18 o dia todo; os números já estão no servidor; e regra fixa é testável e repetível. O assistente
  continua para conversar e para o que precisa de julgamento. Pedido do Antônio: "fique monitorando o
  desempenho e traga opções, eu dou o ok e ele já resolve". (2026-10-18)

## Mac (port de 2026-10)
Pedido do Vittorio, num MacBook Air M2 com 8 GB (swap em ~4 GB, disco em 81 %): as duas dores são Mac lento e disco
cheio. Branch `mac-port` no fork `vittoriofbrun-blip/folga`; **um código só** para os dois sistemas, e o Windows do
Antônio não pode quebrar (CI com `windows-latest` + `macos-latest`). Vira PR para `FainowAI/folga` no fim.
- **Entregue:** memória (Cmd+Q no lugar de `WM_CLOSE`, pressão do sistema e swap, Auto Care por pressão), armazenamento
  com o bloco novo "Dados dos apps" (tamanho por app; limpa só cache recriável, nunca denylist), app de barra de menus
  `Folga.app` com janela WebKit, avisos (travamentos, FileVault/Gatekeeper/SIP no lugar do antivírus) e o assistente
  pelos CLIs já logados.
- **Decisões D-Mac 1–21:** estão numeradas no spec `docs/superpowers/specs/2026-10-20-folga-mac-design.md` (seções por
  plano); não repetir aqui. As que mais mudam o dia a dia: 4 (Cmd+Q), 17 (sem Acesso Total ao Disco), 18 (barra mostra
  só a memória), 19 (pegada ~180/~350 MB aceita), 20 (aviso crítico notifica), 21 (sem itens de login).
- **Em aberto:** (1) notificações do tipo toast: o `usernoted` recusa o Folga como cliente (`UNErrorDomain 1`); investigação
  e matriz de testes em ADR 0007; hoje os avisos são o contador no menu e a tela Avisos. (2) O login do CLI do Claude
  expirou no Mac do Vittorio: o assistente com Claude pede `claude` logado de novo. (3) Para o Antônio, do lado
  Windows: `web_search` desligado e recursos extras do Codex, aviso crítico que notifica, e o bloco "Dados dos apps"
  (decisão 7) com a allowlist de `%LOCALAPPDATA%`/`%APPDATA%`.

## Perguntas abertas (decisão do Antônio)
Todas as perguntas abaixo foram decididas em 2026-10-18 (D11 a D13); os valores seguem ajustáveis em Ajustes.
- **P01** — Nome do app. "Folga" é provisório. Não pode ser "Mint".
- **P02** — Paleta: fundo escuro como o Mint, mas a cor de destaque não pode ser o verde-limão `#bdfe3a`.
  Proposta provisória em `docs/referencias-ui/README.md`.
- **P03** — Apps que vão para a bandeja (Teams, Discord, Spotify): permitir "encerrar de vez" por app,
  com aviso? Padrão proposto: não; você marca app por app.
- **P04** — Abrir junto com o Windows? Padrão proposto: desligado, com um botão em Ajustes.
- **P05** — Linha do Auto Care: 92 % como o Mint, ou outra?
- **P06** — Tempo para considerar um app parado: 30 min proposto. O Mint não diz o dele, mas marca o Slack
  "idle 40 min" como parado, então o corte dele é no máximo 40 min.
- **P07** — Disco e organizar pastas entram numa v2?
