# 0007 — Folga.app no Mac: app de barra com janela WebKit e o servidor dentro do bundle

**Status:** aceito (2026-10-21). Plano 3; decisões 5, 10, 16 e 17 do spec do Mac. A decisão 17 (o Folga não pede
Acesso Total ao Disco) vale por cima de tudo o que este ADR diz sobre pedir a permissão.

## Contexto
No Windows a janela é o Edge em modo app (ADR 0001). No Mac o Vittorio quer um ícone na barra de menus e a
mesma interface React, sem pagar um Chromium (decisão 5). A ideia inicial era pedir o Acesso Total ao Disco só para
o `Folga.app`, nunca para o `node` solto (decisão 10); depois da revisão de segurança o Folga não pede a permissão
de jeito nenhum (decisão 17, seção abaixo).

## Decisão
- **Janela WebKit, não Edge/Chrome.** O `WKWebView` usa o motor do Safari, que já está no Mac. Um Chrome
  ou Edge em modo app abriria um navegador inteiro (vários processos, centenas de MB) num Mac que muitas vezes
  já está em swap, e o Edge nem vem instalado no Mac.
- **Um binário Swift (`mac/Folga.swift`), sem Xcode.** `scripts/mac-app.mjs build` compila com `swiftc -O` e
  monta o `.app`: `Info.plist` gerado pelo script (`local.folga.app`, `LSUIElement`, rede local liberada no ATS),
  `Contents/MacOS/Folga` e `Contents/Resources/folga.json` (`{ node, path }`, caminhos relativos a
  `Contents/Resources`: `node` = `folga/bin/node`, `path` = `folga/bin:/usr/bin:/bin:/usr/sbin:/sbin`; o app
  resolve as entradas sem `/` na frente, então mover o `.app` de `build/` para `~/Applications` não quebra nada).
- **O servidor vai copiado no bundle** (`Contents/Resources/folga/`: `src/`, `dist/`, `probe/bin/probe-mac`,
  `package.json`) **junto com o próprio `node`** (`folga/bin/node`, cópia do Node ≥ 24 de quem rodou o build). Assim o app não depende do repositório, que outra sessão pode estar mexendo, e a assinatura
  sela o código que de fato roda. O app é o processo responsável (TCC) pelo `node` e pela sonda que ele sobe.
- **Por que o `node` vai dentro:** o app é o processo responsável no TCC. Se ele subisse o `node` do `~/.nvm`
  (gravável pelo usuário, fora do selo), qualquer programa rodando como o Vittorio poderia trocar esse arquivo e
  herdar as permissões que o macOS desse ao Folga. Dentro do bundle, trocar o `node` quebra o selo do app (mas veja
  a decisão 17: o selo dos recursos não é conferido ao executar). O `PATH` do filho também não tem nenhuma pasta do
  usuário. Com a decisão 17 isto vira defesa em profundidade, não a barreira principal.
- **Hardened runtime em tudo** (app, sonda, `node`): sem ele, `DYLD_INSERT_LIBRARIES` ou um depurador entrariam
  num processo que carrega a permissão. O `node` é reassinado só com `allow-jit` e
  `allow-unsigned-executable-memory` (o V8 precisa); os direitos originais da Node.js Foundation incluem
  `get-task-allow`, `allow-dyld-environment-variables` e `disable-library-validation`, que reabririam essa porta.
  O `check` confere os três.
- **Custo:** o app passa de ~1 MB para ~116 MB em disco (o `node` tem ~115 MB). Memória não muda: é o mesmo
  `node` que já rodava. Atualizar o Node pede reinstalar o Folga (rebuild copia o novo).
- **Conferência:** `scripts/mac-app.mjs check <app> [--previous <arquivo>]` valida o `Info.plist`, `--version`,
  `--selftest`, as assinaturas do bundle e da sonda de dentro, e recusa requisito designado fraco
  (`requirementWeak`): requisito só com `identifier "local.folga.app"` manteria as permissões entre builds, mas
  qualquer binário ad-hoc com esse id as herdaria. Com `--previous`, roda a mesma conta
  que o TCC faz depois de reinstalar (`codesign --verify -R=<requisito do build anterior>`).

### Assinatura: ramo B (ad-hoc)
Spike de 2026-10-21 (macOS 26.5.1, LibreSSL 3.3.6 do sistema):
- **Ramo A tentado e descartado.** Certificado "Folga Local" autoassinado (`openssl req -x509` com
  `extendedKeyUsage=codeSigning`, 10 anos) num chaveiro só dele, fora da lista de busca, importado com
  `-T /usr/bin/codesign` e `set-key-partition-list`. O `security find-identity` acha a identidade, mas marcada
  `CSSMERR_TP_NOT_TRUSTED` (0 válidas), e o `codesign --keychain <chaveiro> -s "Folga Local"` (e pelo hash
  SHA-1) responde "no identity found". Para torná-la válida seria preciso gravar confiança no certificado
  (`security add-trusted-cert`), o que abre a janela de senha do macOS, ou pôr o chaveiro na lista de busca do
  usuário; as duas coisas ficam fora do que quem constrói pode fazer. O chaveiro de teste foi apagado.
- **Ramo B em uso:** ad-hoc puro. O requisito designado é `cdhash H"…"`, preso ao conteúdo exato do app.
  `--adhoc` é aceito (a CI passa) e dá no mesmo.
- **"Sobrevive ao rebuild" só vale para rebuild idêntico** (o assunto do commit da Task 1 diz mais do que isso).
- **Consequência:** um build idêntico (mesmos arquivos) dá o mesmo `cdhash` e o `check --previous` fica verde;
  qualquer mudança no app ou no servidor copiado muda o `cdhash`, o `check --previous` fica vermelho e
  as permissões que o macOS guarda pelo requisito (notificações, item de segundo plano) podem ser pedidas de novo
  depois de reinstalar. Acesso Total ao Disco não entra nisso: o Folga não o pede (decisão 17).
- **Limite que fica:** a página continua pegando o token por `GET /api/token` (mesma origem, como hoje); quem
  já roda como o Vittorio na máquina consegue falar com o servidor local. Sem Acesso Total ao Disco (decisão 17),
  esse resíduo é o mesmo do Windows: pela API o chamador consegue o que o próprio usuário já consegue, revalidado
  pelo servidor, e nada além.
- **Limite honesto:** o ad-hoc não dá para imitar (o requisito é o hash do próprio app), mas também não prova
  autoria. Se um dia o ramo A voltar (por exemplo, o Vittorio dando confiança ao certificado ele mesmo), o limite
  dele é: um programa já rodando como você consegue assinar com essa chave, como aconteceria com um certificado
  pago guardado no mesmo Mac.

### Acesso Total ao Disco: não pedido (decisão 17, 2026-10-21)
A Task 5 pôs no menu "Liberar acesso ao disco…" com um link para o painel dos Ajustes. A revisão de segurança da
Task 11 achou dois problemas que só existem **porque** o app teria a permissão:
- **C1 — cópia adulterada herda a permissão.** O servidor é JavaScript dentro de `Contents/Resources`, e o macOS
  não confere o selo dos recursos ao executar. Uma cópia do `Folga.app` com o `server.ts` trocado continua sendo
  aceita pelo TCC como o Folga e roda o código novo com Acesso Total ao Disco.
- **I4 — qualquer processo local usaria a permissão pela API.** `GET /api/token` responde a quem rodar como o
  Vittorio; com o token, as ferramentas da API (varredura, tamanho, Lixeira) rodariam com o acesso do app.

Decisão: o Folga **não pede** Acesso Total ao Disco. Saíram o item do menu, o alerta e o link; `fdaNote()` é uma nota
só, sem caminho nos Ajustes ("Não deu para ler: o macOS protege esta pasta e o Folga não pede essa permissão."). O
pino em `files.test.ts` exige que nenhum fonte em `src`, `web/src`, `scripts`, `probe` e `mac` tenha
`Privacy_AllFiles` nem "Ajustes do Sistema › Privacidade", e continua barrando texto que junte a permissão com
`node`/Terminal.
- **O que se perde:** o tamanho da Lixeira, o tamanho do cache do Safari e a busca no iCloud Drive (a pasta saiu
  da lista do Mac em `userFolders`, para não gerar pedido de pasta à toa) aparecem como "não deu para ler"
  (desconhecido, nunca 0).
- **Pedidos de pasta que sobram (a medir ao vivo):** a busca de Arquivos varre Downloads, Desktop, Documents,
  Pictures, Movies e Music, e o macOS pede acesso a cada uma, atribuído ao Folga.app. Com assinatura ad-hoc o macOS
  pode perguntar de novo depois de reinstalar. Se isso incomodar, volta a opção de assinatura A (por isso o
  `check --previous` continua).
- **Rede de segurança:** se a permissão estiver ligada mesmo assim (o Vittorio ligou à mão, ou sobrou de um teste),
  o menu mostra "O Folga está com Acesso Total ao Disco — desligue em Ajustes (não é necessário)", só texto, sem
  link; e a linha R32 do `server.log` diz o mesmo depois de `servidor sim`. A checagem é abrir a `~/.Trash`: só
  abrir de verdade conta (pasta negada ou inexistente → sem aviso).
- **O `--disclaim` fica** (Task 6), como defesa em profundidade: se a permissão aparecer ligada, o assistente
  continua sem herdá-la.
- **Resíduo do `GET /api/token`:** ~~igual ao do Windows — sem a permissão, o servidor só faz o que o próprio usuário
  já faz.~~ **Errado (revisão de segurança, 2026-10-27):** as permissões por pasta (Documentos, Mesa, Downloads…)
  são do Folga.app, e qualquer programa do usuário (até app de sandbox com rede) pegava o token pelo HTTP ou no
  arquivo `ui-token` e listava/mandava para a Lixeira arquivos dessas pastas. Ver "Token só na memória" abaixo.

### O assistente fica fora do acesso ao disco (Task 6)
- Defesa em profundidade desde a decisão 17 (o Folga não pede a permissão). O servidor (o `node` filho do app)
  **continua** responsável pelo Folga.app. Só os CLIs do assistente (claude/codex) lançados por `agent.ts` rodam por `probe-mac --disclaim`, que
  os torna responsáveis por si mesmos. Fora do app (ou no Windows) o `Launch` não muda.
- **Spike (2026-10-21, macOS 26.5.1):** `responsibility_spawnattrs_setdisclaim` + `posix_spawnp` com
  `POSIX_SPAWN_SETEXEC` corta a responsabilidade: `--disclaim probe-mac --responsible` devolve
  `responsible == pid`, com o mesmo pid lançado pelo Node (o `kill` do turno acerta no CLI) e o código de saída
  repassado (`/usr/bin/false` → 1). O plano B (spawn + `waitpid` + repasse de sinais) não foi preciso.
- **Fail closed:** sem o símbolo privado (ou sem comando), `--disclaim` sai **125** sem executar; o chat mostra "O
  assistente não roda dentro do app Folga neste macOS…" em vez de rodar o CLI com o acesso do app. O mesmo texto
  fixo aparece se o `probe-mac` faltar no bundle (nunca o ENOENT cru). Comando inexistente sai 127. O 125 é só
  do disclaim: um 126 devolvido pelo próprio CLI continua a mensagem comum.
- **O que um chamador local consegue com `--disclaim`:** nada que já não tivesse. O modo só **retira** a herança
  de responsabilidade: o programa executado responde pelas próprias permissões do TCC, nunca pelas do Folga.app.
  Quem roda `probe-mac` de fora do app já é o responsável por ele; com `--disclaim`, o alvo passa a ser responsável
  por si — de novo sem nenhuma permissão do Folga. Não é um "rodar qualquer coisa com o acesso do app".
- **Log de início (R32), só dentro do app:** `responsável <executável do --responsible> · acesso ao disco:
  servidor sim|não · assistente não|SIM` (lê a Lixeira direto e via `--disclaim`; nenhum caminho do usuário).
  "assistente SIM" é bug. Esperado (decisão 17): `servidor não · assistente não` (visto ao vivo em 21/10).
  `servidor sim` vem com o aviso para desligar.

### Avisos do Mac (Task 8)
- Dentro do app, o servidor roda `Folga --notify` (UNUserNotificationCenter): processo curto, não sobe a instância
  nem a janela, nunca toca o supervisor. Título e corpo vão só pelo ambiente (`FOLGA_TOAST_TITLE/BODY`), nunca em
  argumento. Saídas: 0 postado · 3 ainda não perguntado (ou sem resposta em 10 s) · 4 recusado · 5 erro. Desde o
  plano 4 o `--notify` **não pede** autorização: só lê o estado (`notifyExit`) e posta; erro do macOS vai para o
  stderr e para o log público (domínio, código, texto). Clique no aviso → a instância
  principal (delegate) abre a janela.
- Qualquer saída ≠ 0 faz o aviso daquela vez sair pelo `osascript` (script fixo que lê `system attribute`; testado
  ao vivo com título `"; do shell script …`: nada executou). Saída 126, 127 ou falha de spawn ENOENT/EACCES
  (app ausente) trava o app como quebrado para sempre; as outras (3 não perguntado, 4 sem autorização ou alertas
  desligados, 5 erro, outras falhas) só recuam 10 minutos e o app é tentado de novo. O 4 deixou de travar no
  plano 4: virou leitura de estado barata, e o Vittorio pode ligar as notificações depois sem reiniciar o Folga. Fora do app, o `osascript` direto; clicar no aviso do `osascript`
  abre o Editor de Scripts, não o Folga (limite do reserva). Windows continua no PowerShell.
- **Ao vivo (21/10, build ad-hoc em build/):** `--notify` saiu **3** (sem resposta em 10 s): autorização do
  macOS pendente/sem resposta; ninguém clicou. **Pendente (controlador):** o Vittorio responder o pedido de
  autorização do Folga em Ajustes > Notificações e repetir; se continuar 3 ou 4 com app ad-hoc, o `osascript`
  (já ligado como reserva) é o caminho definitivo.

- Um `--notify` só é lançado pelo servidor, que só roda com a instância principal viva; por isso ele nunca
  pode barrar um lançamento necessário e a checagem de instância única não o distingue.

#### Diagnóstico: por que nenhum aviso chega (plano 4, Task 1 — 21/10, só leitura, sem administrador)
| Fato | Como medido | Resultado |
|---|---|---|
| Registro no LaunchServices | `lsregister -dump` (caminho completo em `CoreServices.framework`), sandbox desligado | **Mudou desde o planejamento.** `local.folga.app` aparece 3×: `~/Applications/Folga.app` (registrado 15:53, flags `ui-element`, é o principal), `build/Folga.app` (`ui-element launch-disabled`) e um `…/T/tmp.…/Folga.app` de smoke test (`in-temp-dir`, pasta já apagada, registro órfão). O "vazio" do planejamento não vale mais. |
| Assinatura | `codesign -dv` nos dois bundles | `Identifier=local.folga.app`, `Signature=adhoc`, `TeamIdentifier=not set` |
| Pedido de autorização (build) | `lsregister -f build/Folga.app`, depois `FOLGA_TOAST_TITLE=teste FOLGA_TOAST_BODY=oi build/…/Folga --notify` (6×) | **Saída 4 na hora (0 s), nenhum pedido na tela.** `log show`: `usernotificationsd` aceita ("Entitlement check success: matching bundle identifiers"), o `usernoted` acha o app pelo caminho do build, e volta `didGrant: 0 hasError: 1`. O código do erro não aparece no log e o `Folga.swift` o descarta (`{ ok, _ in }`). Hipótese: o registro que pede está `launch-disabled` (o mesmo bundle id já tem o instalado como principal). Não vale como prova para o instalado. |
| Entrada em Notificações | `defaults export com.apple.ncprefs -` | Nenhuma entrada do Folga, nem depois dos 6 pedidos: o macOS recusa **antes** de criar a linha em Ajustes › Notificações; não há o que o Vittorio ligar lá. |
| Reserva `osascript` | mesmo arquivo, entrada `com.apple.ScriptEditor2` | `flags = 0x200e` (8206), **sem** chave `auth`. Dos 109 apps, só ele e `com.apple.TelephonyUtilities` têm os bits 23 e 25 desligados juntos; Chrome/Notion/VS Code têm `0x80200e` (bit 23 ligado, 25 desligado), e FaceTime e Brave têm `0x280200e` (os dois ligados). Leitura provável: o Editor de Scripts nunca foi autorizado e o reserva sai mudo por ajuste, não por bug. O que cada bit significa não está documentado: falta o Vittorio dizer se o Chrome mostra avisos. |
| Foco (Não Perturbe) | `ls ~/Library/DoNotDisturb/DB/` | `Operation not permitted`: sem Acesso Total ao Disco não dá para ler (decisão 17). Fica como limite, sem contorno. |
| Relatórios de travamento | `ls ~/Library/Logs/DiagnosticReports` | Pelo Terminal dá para ler. São 42 itens: 40 `.diag`, 1 `.ips` (`node`, `bug_type` 309) e a pasta `Retired`. Falta medir de dentro do app (Task 3, linha no `server.log`). |
| Segurança e serviços | `fdesetup status`, `spctl --status`, `csrutil status`, `launchctl print gui/501` e `print system` | Todos respondem sem administrador: FileVault On, `assessments enabled`, SIP `enabled`. As seções `services = {` e `disabled services = {` existem nos dois domínios. |
| Itens de início | `sfltool dumpbtm` | Fora: no planejamento ficou parado esperando administrador e foi morto. Não foi rodado de novo. |

- **Causa:** o macOS recusa o pedido sem mostrar nada. Antes era porque o app não estava registrado. Hoje, no
  build, a recusa vem com o registro presente, só que em estado `launch-disabled`. Para o app instalado (o
  registro principal), o `--notify` ainda não foi medido depois do registro. Esse é o passo do controlador com
  o Vittorio (Step 3), e pode ser que apareça o pedido. Enquanto isso, o reserva `osascript` sai em nome do
  Editor de Scripts, que muito provavelmente nunca foi autorizado.
- **Erro exato (plano 4, Task 2):** `UNErrorDomain 1 Notifications are not allowed for this application`
  (`notificationsNotAllowed`), devolvido pelo `requestAuthorization` do `--notify` do build. O log do `usernoted`
  mostra o porquê com um app de teste ad-hoc (`local.folga.diag`, apagado e desregistrado depois):
  - **sem registro:** `Failed to find or validate client of identifier …` → erro 1 na hora, sem pedido;
  - **registrado, registro único, ad-hoc, rodado direto pelo binário:** `Sending request for permission … Presenting
    … as alert`: **o pedido aparece**. Ad-hoc não é barrado. O pedido sumiu quando o processo morreu (6 s), e o
    estado ficou recusado: o `--notify` antigo, que morria em 10 s, matava o próprio pedido (a saída 3 do
    planejamento).
  - O build continua com erro 1 porque o registro dele é `launch-disabled` (o instalado é o principal do mesmo id).
  Conclusão: dá para consertar. O pedido sai da instância principal (de pé, o pedido fica na tela) e o
  `install` registra o caminho instalado.
- **Feito (Task 2):** `--notify` só lê o estado; a instância principal pede uma vez se `.notDetermined` (no
  `--login`, só no primeiro "Abrir Folga"); o menu mostra "Notificações do Folga desligadas — ligue em Ajustes do
  Sistema › Notificações › Folga" (só texto) quando recusadas ou com alertas desligados, e o neutro "Notificações do
  Folga ainda não autorizadas" enquanto o macOS não perguntou (saída 3); `install` roda `lsregister -f` no app
  trocado e `uninstall` roda `lsregister -u` antes de apagar (falha só avisa). **Pendente (controlador):** instalar,
  o Vittorio responder o pedido, conferir o menu e um cartão do vigia chegando como aviso do Folga.
- **Estratégia para a Task 2 (escrita na Task 1):** (1) `install` roda `lsregister -f` no app instalado e `lsregister -u` nos outros
  registros do mesmo bundle id (build e temporários), para que um só caminho responda pelo `local.folga.app`;
  (2) o pedido de autorização sai da instância principal (o app que o macOS conhece), não do processo curto;
  (3) o `--notify` grava no log o código do erro de `requestAuthorization` (hoje descartado); (4) o `osascript`
  continua como reserva; (5) a contagem de avisos no menu aparece **sempre**, porque nenhum dos dois caminhos é
  garantido; (6) o Foco não pode ser lido: a tela diz isso e não tenta adivinhar.

### Token só na memória (revisão de segurança, 2026-10-27)
- Dentro do app (`FOLGA_APP=1`) o `ui-token` nunca vai para o disco: o `Folga` gera 32 bytes aleatórios a cada
  início do servidor e entrega na 1ª linha do stdin (o pipe que já existia). O arquivo `ui-token` antigo é apagado.
- A janela recebe o token num cookie `folga_t` (HttpOnly, SameSite=Strict) do armazenamento só-memória do
  WKWebView, gravado antes do primeiro `load`; servidor novo = cookie trocado. Com ele a página faz `GET /api/token`
  como sempre (a interface não mudou). O menu usa o token da memória no cabeçalho `x-folga-token`.
- O servidor do app recusa **toda** `/api/` sem token (leituras inclusive: lista de arquivos, conversa, sugestões).
  A página estática continua aberta. Token só é dado a servidor que este app subiu: porta ocupada ou "Folga de fora"
  zera o token (um programa que tome a porta não recebe o cookie de um token vivo).
- `agent-token`: existe só durante um turno do assistente (criado antes do CLI subir, apagado e trocado no fim, em
  todos os sistemas). Vale nas leituras do MCP e na varredura. **Resíduo:** durante um turno, quem ler o arquivo
  consegue listar nomes de arquivos das pastas (a varredura); não consegue mandar nada para a Lixeira nem aprovar.
- Fora do app (Windows, `npm run app`) nada mudou: lá não existe permissão por pasta a herdar.
- Testes: `http.test` (403 em toda `/api/` sem token, cookie passa, nenhum token no disco; mutação da checagem faz
  falhar) e `agent.test` (abre/fecha do agent-token, inclusive com CLI que não sobe).

### Limpeza rápida: apagar pelo nome dentro da pasta conferida (revisão de segurança, 2026-10-27)
- Cache de navegador que era link (`Cache_Data -> ~/Documents`) fazia a limpeza apagar de vez o outro lado. 1º
  conserto (caminho real da pasta antes de varrer + pasta de cada arquivo reconferida antes do `unlink`) fechou o
  caso parado, mas a 2ª revisão ganhou a corrida trocando a pasta por link em laço (~1% dos arquivos, 31 de 3000).
- Hoje (`files.ts`, `del`): agrupa por pasta, `chdir` nela, confere que `process.cwd()` é a pasta esperada e apaga
  pelo **nome** (`lstatSync` + `unlinkSync`), tudo síncrono para nenhum outro código rodar com o diretório trocado.
  Trocar a pasta depois do `chdir` não muda onde o `unlink` cai. Mesmo ataque, 3 rodadas: 0 de 3000.
- `agent-token`: o fechar do turno só apaga se o token ainda for o daquele turno (conversa zerada no meio de uma
  resposta não derruba o token do turno novo). Resíduo aceito: durante um turno o arquivo existe e permite listar
  nomes de arquivos (varredura); qualquer outro canal para o MCP (config, argumento) também fica legível.

### Notificações: estado em 2026-10-22 (superado — ver 2026-10-27 abaixo)

Medido no app instalado (`~/Applications/Folga.app`, registro único no LaunchServices, build f640ad5…):
`notificacoes.log` → `status=1 alert=2 pedindo` e, no `requestAuthorization` da instância principal,
`granted=false erro=UNErrorDomain 1 Notifications are not allowed for this application`. O Folga não aparece em
Ajustes › Notificações e não há entrada `local.folga.app` em `com.apple.ncprefs`.

Conclusão: o `usernoted` recusa o Folga como cliente antes de qualquer pergunta ao Vittorio — o problema é
registro/assinatura, não o momento do pedido. Um app de diagnóstico ad-hoc (`local.folga.diag`) recebeu o pedido
quando estava sozinho no registro; diferenças a isolar numa próxima sessão: hardened runtime, `LSUIElement`,
política `.accessory`, pasta (`~/Applications`), e o histórico do bundle id `local.folga.app` (pedidos anteriores
recusados). Plano: matriz de apps de teste com bundle ids novos, uma diferença por vez, com o Vittorio avisado
de que aparecerão pedidos na tela.

Enquanto isso, a entrega dos avisos é o contador no menu e a tela Avisos (funcionando, conferido ao vivo).

### Notificações: resolvido em 2026-10-27 (bundle id novo `local.folga.mac`)

Matriz com um app mínimo (mesmo `Info.plist`, `LSUIElement`, hardened runtime, `.accessory`, em
`~/Applications`, aberto pelo `open`), uma variável por vez:

| App de teste | Bundle id | Resultado |
|---|---|---|
| A, F | novo (`local.folgateste.*`) | pedido aparece na tela (sem resposta em 8 s; o Vittorio viu) |
| E | `local.folga.app` (Folga desregistrado durante o teste) | `antes=1` (negado) e `UNErrorDomain 1` na hora |
| B, C, D | qualquer, rodado **direto pelo binário** de uma pasta temporária | `UNErrorDomain 1` na hora, mesmo com id novo |

- **Causa:** o macOS guardou "negado" para `local.folga.app`, quase certamente dos testes de 21/10 em que o
  `--notify` antigo morria em 10 s com o pedido ainda na tela. Esse estado mora no banco do `usernoted`
  (`~/Library/Group Containers/group.com.apple.usernoted/`), que só abre com Acesso Total ao Disco (decisão 17):
  não há como zerar por fora. Os 2 registros órfãos das pastas `folga-install-*` não eram a causa (removidos, a
  recusa continuou).
- **Prova falsa que segurou a investigação:** "o Folga não está em `com.apple.ncprefs`". Neste macOS esse
  arquivo não é mais escrito (data de junho); a lista de Ajustes › Notificações vem de outro lugar. Não usar
  `ncprefs` como evidência.
- **Armadilha de método:** rodar o binário direto do shell (sem `open`) recusa sempre, e um pedido recusado
  assim **grava** "negado" para o id. Teste de notificação sempre pelo `open -n -a … --env … --args --notify`.
  E no zsh `log` é um comando interno: usar `/usr/bin/log`.
- **Conserto:** bundle id `local.folga.mac` (Info.plist, sonda/servidor que reconhecem o próprio Folga, item
  "Abrir com o Mac"). O rótulo do LaunchAgent e o `autosaveName` continuam com o nome antigo: não são bundle id.
  Depois do `install`, o pedido apareceu, o Folga entrou em Ajustes › Notificações e um aviso de teste foi
  entregue como faixa e ficou na Central (conferido com o Vittorio). Custo: permissões de pasta e posição do
  ícone foram pedidas de novo (domínio de preferências novo).
- **`install` desregistra a cópia da pasta temporária** (o `check` a roda e o LaunchServices a registra): sem
  isso cada instalação deixava mais um registro órfão do mesmo id.

## Consequências
- A CI do macOS monta o app ad-hoc e roda o `check` (sem segredo).
- O `node` gravado no `folga.json` é o do build; trocar de Node pede rebuild.
- As Tasks 5, 6 e 8 do plano 3 completam este ADR (Acesso Total ao Disco — desfeito pela decisão 17 —, assistente
  fora dele, avisos).
- O texto da barra é só o ícone + memória (`81%`), sem disco: "81% · 34 GB" ficava atrás do notch (decisão 18); a posição do ícone persiste via `autosaveName`.
