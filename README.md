# Donel Dev

Um app desktop para Windows que roda **várias sessões do Claude Code em
paralelo**, cada uma numa aba, com painéis de organização em volta: projetos,
sessões anteriores (retomar ou forkar), seletor de modelo/esforço/permissões e um
semáforo que mostra quais sessões estão esperando você.

O princípio central é que **o app não reimplementa o agente**. Ele embeda o
`claude` de verdade num PTY (ConPTY) e orquestra o CLI por fora — seus hooks,
skills, MCPs e comandos continuam funcionando exatamente como no terminal.

> Este repositório é o **canal estável**: o código do app, para quem quiser
> clonar e buildar na própria máquina. Não há instalador pronto aqui, nem
> promessa de suporte — leia [Escopo e suporte](#escopo-e-suporte).

## O que ele faz

- **Abas de sessão**: cada aba é um processo `claude` real, no diretório do
  projeto que você escolheu.
- **Semáforo por sessão**: de longe dá para ver quem está trabalhando, quem
  terminou e quem está travado esperando uma resposta sua. Sessão pedindo
  permissão sobe para o topo.
- **Painel de projetos**: você aponta suas pastas-raiz e o app lista os projetos
  encontrados, com favoritos.
- **Sessões anteriores**: lê os transcripts `.jsonl` do próprio `~/.claude` e
  deixa retomar (`-r`) ou forkar (`--fork-session`) de onde parou.
- **Launcher**: escolhe modelo, esforço e modo de permissões antes de subir a
  sessão.
- **Nomes de sessão**: renomeia pela aba (duplo-clique ou `F2`), e acompanha o
  `/rename` feito dentro da sessão.
- **% de contexto consumido** na barra da sessão.
- **Copiar/colar de terminal moderno**: `Ctrl+C` com seleção copia; sem seleção,
  numa aba de sessão, **não** interrompe a execução (para interromper, `Esc`).
  `Ctrl+V` cola texto em bloco único e cola print quando há imagem no clipboard.
- **Perfis de conta**: mais de uma conta Claude na mesma máquina, isoladas por
  `CLAUDE_CONFIG_DIR`.

O app **não embute credencial nenhuma**. O `/login` é sempre um ato seu, dentro
do terminal, e as sessões continuam vivendo no `~/.claude` da sua máquina.

## Pré-requisitos

| | |
|---|---|
| **Sistema** | Windows 11 x64. O app usa ConPTY e resolve o executável com `where.exe` — não roda em Linux/macOS hoje. |
| **Node.js** | 20 ou superior (desenvolvido em 22.x). |
| **Claude Code CLI** | Instalado e logado. Confira com `claude --version` num PowerShell. Se não responder, instale a partir de https://claude.com/claude-code e rode `claude` → `/login` uma vez. |
| **Build tools nativas** | O `postinstall` recompila o `node-pty` contra a ABI do Electron, e isso exige **Visual Studio Build Tools** (workload *Desktop development with C++*) + **Python 3**. Ver [Se o `npm install` falhar](#se-o-npm-install-falhar). |

## Buildar e rodar

```powershell
git clone https://github.com/xansde/donel.git
cd donel
npm install          # roda patch-package + electron-rebuild do node-pty
npm run dev          # abre o app em modo desenvolvimento
```

Outros comandos:

```powershell
npm run typecheck    # tsc --noEmit
npm test             # testes unitários (vitest)
npm run build        # compila main/preload/renderer para out/
npm run dist         # gera o instalador NSIS em release/
npm run test:smoke   # smokes de UI (Playwright) — exigem `npm run build` antes
```

O `npm run dist` produz um instalador **per-user, sem admin**, que instala em
`%LOCALAPPDATA%\Programs\Donel Dev`.

### Se o `npm install` falhar

O erro quase sempre vem do `electron-rebuild -f -w node-pty` no `postinstall`,
que compila um addon nativo em C++. Duas saídas:

1. **Instalar as ferramentas de compilação** — Visual Studio Build Tools com o
   workload *Desktop development with C++*, e Python 3 no PATH.
2. **Tentar sem recompilar** — o `node-pty` 1.1.0 publica prebuilds. Rodar
   `npm install --ignore-scripts` e depois só `npx patch-package` às vezes
   basta; se o app subir e o terminal funcionar, você não precisava do
   compilador. Se der erro de ABI ao abrir uma aba, precisa.

Remover essa dependência do compilador é um item aberto — ver
[Problemas conhecidos](#problemas-conhecidos).

## Mapa do código

```
src/main/          processo main: PTY, scanner de projetos, índice de sessões,
                   perfis, semáforo (servidor local de hooks), config
src/preload/       ponte de IPC (contextIsolation ligado)
src/renderer/      UI em React: sidebar, abas, launcher, painel da sessão
src/shared/        módulos puros compartilhados (CommandBuilder, ordenação,
                   parsing) — é onde vive a maior parte dos testes
design-system/     pacote de workspace com os componentes de UI
tests/             vitest (unitários) + Playwright (smokes de UI)
```

Duas notas de arquitetura que economizam tempo de quem for mexer:

- **O `claude` é spawnado direto no PTY**, sem shell intermediário. Por isso o
  argv é montado como array de tokens discretos (`src/shared/commandBuilder.ts`)
  e valores nunca levam aspas literais.
- **Os hooks do semáforo entram por `--settings <arquivo>`**, somando aos hooks
  globais do usuário. O app **nunca** escreve no seu `~/.claude/settings.json`.

## Problemas conhecidos

Reportados por quem instalou a versão empacotada. Estão abertos — se você
tropeçar neles, não é a sua máquina.

1. **Abrir uma sessão cai direto em "Sessão encerrada".** O overlay que anuncia o
   fim da sessão é 92% opaco e cobre o terminal inteiro, escondendo justamente a
   mensagem de erro que o `claude` imprimiu antes de sair. As causas prováveis por
   baixo: (a) o launcher usa `fable`/`high` como padrão, e o CLI sai com erro se a
   sua conta não tem acesso ao modelo ou se a sua versão não conhece `--effort`;
   (b) a resolução do executável pega o **primeiro** resultado de
   `where.exe claude`, que numa instalação via npm é o shim sem extensão em vez
   do `claude.cmd`/`claude.exe`. Enquanto não estiver corrigido, contorne
   trocando modelo e esforço no launcher antes de subir a sessão.
2. **A sidebar não mostra todas as pastas do diretório de projetos.** O scanner
   só considera projeto o diretório que tem `.git/` ou `CLAUDE.md`, e varre no
   máximo 2 níveis. Pasta de código sem nenhum dos dois marcadores fica
   invisível, sem aviso.
3. **Os padrões de pasta-raiz são `~/seazone` e `~/pessoal`** — os caminhos da
   máquina de quem escreveu o app. Na primeira abertura a sidebar vem vazia; vá
   em **engrenagem → Preferências → Pastas-raiz de projetos** e aponte as suas.
4. **O instalador não é assinado.** O SmartScreen mostra "O Windows protegeu o
   seu PC" (*Mais informações → Executar assim mesmo*). Em máquina com **WDAC**
   ou AppLocker em modo de imposição, o app empacotado pode ser **bloqueado de
   vez** — o `electron-builder` reescreve o `electron.exe`, o que invalida a
   assinatura original da OpenJS Foundation. Nesse cenário, `npm run dev` tende a
   funcionar onde o instalador não funciona, porque usa o `electron.exe` assinado
   que veio no `node_modules`. Não é solução, é contorno.
5. **Sem atualização automática** e **sem ícone próprio** (cai no ícone padrão do
   Electron).
6. **`npm install` exige compilador C++** — ver a seção acima.

## Escopo e suporte

Isto é uma **ferramenta pessoal publicada como está**, não um produto. Não há
roadmap público, SLA, nem compromisso de responder issue ou revisar PR. Pode
clonar, buildar, forkar e adaptar à vontade — é para isso que está aberto.

Se for abrir uma issue, o que ajuda de verdade: o que você fez, o que esperava, o
que aconteceu, a saída de `claude --version` e o texto completo do erro.

## Licença

MIT — ver [LICENSE](LICENSE).
