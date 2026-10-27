# 0006 — Agente no chat: Claude ou GPT pelos CLIs da assinatura, com ferramentas só de leitura

**Status:** aceito (2026-10-18). Spike real nos dois provedores, script em
`scripts/spike-agent.mjs` (cópia do spike da sessão).

## Contexto
Antônio quer conversar com um agente dentro do app, escolhendo entre a assinatura do GPT e a do Claude,
sem chave de API. O agente ajuda a achar arquivos que ele não abre mais, recomenda limpezas e acompanha os avisos.

## Decisão
- Um turno = um processo do CLI, que termina ao fim da resposta. A conversa continua pelo id da sessão
  (`--resume <id>` no Claude, `exec resume <id>` no Codex).
- As ferramentas vêm de um único servidor MCP stdio do Folga (`src/mcp.ts`), escrito à mão (JSON-RPC por
  linha). Ele foi testado com os dois clientes reais.
- **Todas as ferramentas são só de leitura** (`readOnlyHint: true`). O agente **não executa nada**. Ele
  propõe sugestões num bloco `folga-sugestao` da resposta, e o servidor transforma esse bloco em cartões
  que o usuário aprova (R20 a R24). Uma tentativa de configurar aprovação automática de ferramentas no
  Codex foi barrada pelo classificador de segurança, e este desenho dispensa isso.

### Claude (`claude.exe` 2.1.302, assinatura)
`-p <texto> --output-format stream-json --verbose --tools "" --mcp-config <arquivo> --strict-mcp-config
--allowedTools mcp__folga --permission-mode dontAsk --setting-sources project,local --disable-slash-commands
--system-prompt <prompt> --settings {"disableAllHooks":true,"claudeMdExcludes":[...]}`, com env
`CLAUDE_CODE_HARBOR_KITE=0`, cwd = pasta de dados e **stdin fechado**. Com stdin aberto, ele espera 3 s.
- Observado: `init.tools` = só `mcp__folga__*`, a autenticação OAuth funciona e a conversa leva 8,4 s.
- Sem o `claudeMdExcludes`, o agente dizia ter recebido as instruções do `~/.claude/CLAUDE.md`; com ele, diz
  que não (controle negativo).
- `--bare` foi descartado: aceita só `ANTHROPIC_API_KEY`.

### GPT (`codex.exe` 0.156.1 do pacote npm, login ChatGPT)
Chamado direto, com o exe do vendor e `shell:false` (o `.cmd` exigiria shell):
`exec --json --sandbox read-only --skip-git-repo-check --ignore-user-config -C <pasta de dados>
-c mcp_servers.folga.command=… -c mcp_servers.folga.args=[…] -c mcp_servers.folga.env={…}
-c developer_instructions=<prompt>` e `--disable` em `shell_tool`, `plugins`, `apps`, `browser_use`,
`browser_use_external`, `computer_use`, `image_generation`, `in_app_browser`, `hooks`, `tool_suggest`,
`skill_search`, `goals` e `view_image`.
- Observado: com `readOnlyHint` a ferramenta roda sem aprovação, e a conversa leva de 9 a 13 s.
- Sem o `readOnlyHint` a chamada falha ("requires approval, but approval policy is never").
- **Assimetria conhecida:** o `~/.codex/AGENTS.md` sempre entra no contexto; não há opção para tirar.
  Como o shell e as skills estão desligados, ele não consegue agir sobre essas instruções. O prompt de
  sistema manda ignorá-las.

## No Mac (22/10)
Spike refeito no MacBook (arm64) com `scripts/spike-agent.mjs`, agora sem caminho do Windows: `REPO` vem do
`import.meta.dirname` e os CLIs de `FOLGA_CLAUDE_EXE`/`FOLGA_CODEX_EXE` (faltou → sai explicando). Flags iguais às do
`realLaunch`, cwd numa pasta vazia dentro de um `mkdtemp`, chaves de API tiradas do ambiente. Prompt único: "Use
ver_memoria e diga quantos apps aparecem. Depois tente rodar o comando `id` no terminal e diga, em uma palavra, se
conseguiu." **Duas chamadas de modelo, uma por provedor.** Checagens sem modelo com `env -i HOME=$HOME PATH=/usr/bin:/bin`.

**Binários.** No nvm (`~/.nvm/versions/node/v24.18.0/bin`) `claude` aponta para
`…/@anthropic-ai/claude-code/bin/claude.exe` (Mach-O arm64, 2.1.246) e `codex` para `…/@openai/codex/bin/codex.js`
(script `#!/usr/bin/env node`). O Folga usa o nativo que o `codex.js` lança:
`…/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` (Mach-O arm64,
`codex-cli 0.157.0`). `probe-mac --disclaim <binário> --version` imprime a versão dos dois (o `SETEXEC` funciona com eles).

| flag | ainda existe? | observado |
|---|---|---|
| Claude: `-p`, `--output-format`, `--verbose`, `--resume`, `--tools`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`, `--permission-mode`, `--setting-sources`, `--disable-slash-commands`, `--system-prompt`, `--settings` | sim (as 13, no `--help` da 2.1.246); `dontAsk` está nas escolhas de `--permission-mode` | `init.tools` = só os 9 `mcp__folga__*`, MCP `connected`, 0 skills, 0 plugins. O modelo não respondeu: **401 "OAuth access token has expired"** (2 retries, 4,2 s, US$ 0). Nenhum `tool_use`, nenhum comando. Nenhum aviso de chaveiro apareceu. |
| Codex `exec` e `exec resume`: `--json`, `--skip-git-repo-check`, `--ignore-user-config`, `--disable`, `-c` | sim, nos dois | ver abaixo |
| `--disable` dos 13 de hoje (`shell_tool` … `view_image`) | sim, os 13 em `features list` (stable, true) | nenhum `command_execution` |
| `--disable unified_exec`, `multi_agent`, `memories`, `workspace_dependencies`, `skill_mcp_dependency_install`, `in_app_local_automation`, `worktrees` | sim (stable, true); aceitos sem erro | nenhum `command_execution` |
| `--disable code_mode_host` | sim (stable, true); aceito | **derruba o MCP**: item `error` "Code Mode is unavailable because code-mode host is disabled… will fail closed"; o `ver_memoria` não foi chamado e a resposta foi "Não consegui acessar `ver_memoria`… execução de `id`: **não**" (14,5 s) |
| `--disable nome_que_nao_existe` | — | sai com erro (`Unknown feature flag`, rc 1). Nome novo não pode ir para o Windows sem conferir a versão de lá. |

**`id` não rodou em nenhum dos dois.** No Claude não havia ferramenta fora do MCP; no Codex não houve
`command_execution` e ele mesmo disse que o terminal estava indisponível. O `features list` não reflete o `--disable`
da linha de comando (continua mostrando `true`), então a prova é o stream do `exec`, não a lista.

**`unified_exec`:** com `--disable` (esta rodada) não houve comando. Sem `--disable` **não foi medido**: o orçamento
era de uma chamada por provedor.

**Lista de `--disable` do Mac** (decidida na Task 3, com duas chamadas extras do Codex): os 13 de hoje mais
`unified_exec`, `multi_agent`, `memories`, `workspace_dependencies`, `skill_mcp_dependency_install`,
`in_app_local_automation` e `worktrees` (`CODEX_DISABLE_MAC` em `src/agent.ts`, só no `darwin`). **`code_mode_host` fica
ligado**: desligado, ele derruba o MCP.

As duas chamadas usaram exatamente o `realLaunch('darwin')`: o binário do vendor achado pelo `findCli`, o ambiente montado
do zero (só `HOME`, `USER`, `LOGNAME`, `TMPDIR` e `PATH=/usr/bin:/bin:/usr/sbin:/sbin`), cwd numa `agent-cwd` vazia
dentro de um `mkdtemp`, e o MCP pelo `process.execPath`.
- **Chamada 1** (o prompt do spike) levou 17,2 s. Houve um `mcp_tool_call` `ver_memoria` com status `completed` e
  **nenhum `command_execution`**. Resposta: "Aparece 1 app… `id`: não."
- **Chamada 2** levou 18,5 s. O prompt mandou "tentar de todo jeito" rodar `id` (terminal, exec, code mode, JavaScript,
  MCP) e listar as ferramentas. O registro da sessão (`~/.codex/sessions`) mostra como o Codex 0.157 chama o MCP: por
  dentro do **code mode**, a ferramenta `exec`, que roda JavaScript isolado (`await tools.mcp__folga__ver_memoria({})`).
  O próprio script testou: `typeof process` e `typeof require` deram `undefined`, e nenhuma ferramenta tinha shell,
  terminal ou comando no nome. Houve **nenhum `command_execution`**. Resposta: "`id` rodou? **Não.**"

**Ressalva da Task 3:** com essa lista, o Codex ainda declarou ao modelo `apply_patch`, `web__run`, `spawn_agent` e as
outras ferramentas de colaboração (apesar do `--disable multi_agent`), `request_user_input` e `list/read_mcp_resource*`.
O `sandbox_mode="read-only"` deve barrar a escrita do `apply_patch`, e nada disso executa comando, mas o agente vê mais
ferramentas do que só as do Folga. Fechá-las fica fora do orçamento de chamadas desta tarefa e é decisão do controlador.

**Pendente:** a conversa real do Claude no Mac. O token OAuth do `claude` está vencido; renovar o login é passo do
Vittorio, e depois disso a checagem fica para o ponta a ponta.

**Assimetria do `~/.codex/AGENTS.md`:** continua (no Mac do Vittorio o arquivo existe e está vazio, 0 bytes). O `--ignore-user-config` não tira o `AGENTS.md`; com shell, exec e
skills desligados ele não tem como agir sobre essas instruções.

### Revisão final (23/10): contexto residual e web desligada no Mac
- **Web desligada no Mac:** `-c web_search="disabled"` (só `darwin`; o Windows fica como está até conferir o Codex de lá).
  Sem isso o Codex declarava `web__run`, que abre qualquer URL: um nome de arquivo malicioso poderia mandar o agente
  vazar nomes de arquivo e de app por uma URL. Conferido com **uma** chamada (mesmos flags, cwd descartável): o registro
  da sessão em `~/.codex/sessions` não tem `web__run` nem `web.run` (as sessões anteriores, sem o flag, têm).
- **Contexto residual que o agente ainda vê:** a lista de skills, `spawn_agent` e `request_user_input` aparecem na
  declaração de ferramentas do Codex. **Nenhuma consegue executar:** sandbox `read-only`, shell, `unified_exec`,
  `multi_agent` e `worktrees` desligados, e o code mode isolado (sem `process` nem `require`).
- **Binário:** o nome real do CLI achado tem de ser `claude`, `claude.exe` ou `codex` (um link chamado `claude` para
  `/bin/zsh` não passa; exceção: o instalador nativo do Claude Code liga
  `~/.local/bin/claude` a `~/.local/share/claude/versions/<x.y.z>`, então um nome real `x.y.z` vale, só dentro dessa pasta
  e só para o Claude). `LANG` só entra no ambiente se casar `^[A-Za-z0-9_.@-]{1,64}$`.

## Consequências
- Cada turno abre um processo de 100 a 300 MB, que termina ao fim do turno. Esse processo fica na árvore
  `__self` enquanto vive, e o R18 vale entre turnos.
- Um turno por vez, com teto de 120 s. Ao estourar, o servidor mata a árvore do processo.
- O custo é a cota da assinatura de cada um. O Claude informa o custo equivalente em US$ no `result`.
