# Donel Dev — contexto para o Claude Code

App desktop Windows (Electron) que embeda o `claude` CLI num PTY e orquestra
várias sessões em abas. **O app não reimplementa o agente** — se uma mudança
começar a interpretar prompt, gerenciar contexto ou falar com a API, ela está no
lugar errado.

## Instalação assistida — quando o usuário pedir "instala o app"

Quem clona este repo pode pedir a instalação inteira ao Claude Code. Execute
os passos abaixo NA ORDEM, verificando cada um antes de seguir — não declare
instalado sem ter visto o instalador terminar com exit 0.

1. **Pré-requisitos** (aborte com instrução clara se faltar):
   - `node --version` → 20+.
   - `claude --version` → CLI instalado. Se faltar, instrua a instalar por
     https://claude.com/claude-code e rodar `claude` → `/login` uma vez.
   - Windows x64 (o app usa ConPTY; não roda em Linux/macOS).
2. **Dependências**: `npm install`. Se falhar no `electron-rebuild` do
   node-pty (o erro típico menciona MSBuild/gyp), há dois caminhos, nesta
   ordem: (a) instalar Visual Studio Build Tools (workload C++) + Python 3 e
   repetir `npm install`; (b) `npm install --ignore-scripts` seguido de
   `npx patch-package` — os prebuilds do node-pty 1.1.0 costumam bastar.
   ATENÇÃO no caminho (b): rode um smoke de terminal antes de prosseguir
   (passo 4) — ABI errada de node-pty = nenhum terminal abre no app.
3. **Verificação**: `npm run typecheck` e `npm test` — os dois precisam
   passar. Não pule.
4. **Prova de fumaça do PTY**: `npm run build` e depois
   `npx playwright test -c tests/smoke/playwright.config.ts terminal-copy-paste`
   — prova que node-pty compilou de verdade nesta máquina (abre um shell
   real). Se os browsers do Playwright faltarem: `npx playwright install`.
5. **Instalador**: `npm run dist` → gera `release\Donel Dev-Setup-<versão>.exe`.
6. **Instalar**: rodar o setup gerado (aceita `/S` para silencioso). É
   per-user, sem admin, instala em `%LOCALAPPDATA%\Programs\Donel Dev` e cria
   atalho na área de trabalho e no menu Iniciar.
7. **Confirmar**: o exe existe em `%LOCALAPPDATA%\Programs\Donel Dev\Donel
   Dev.exe` e abre. Só então reporte concluído.

Duas configurações que valem mencionar ao usuário no final:
- Preferências → "Pastas-raiz de projetos": onde a sidebar procura projetos.
- Preferências → "O que aparece como projeto": por padrão só pastas com
  `.git/` ou `CLAUDE.md` aparecem; "Todas as pastas" lista qualquer pasta de
  1º nível das raízes.

## Arquitetura em uma tela

- `src/main/` — processo main. PTY (`pty-manager.ts`), resolução do executável
  (`claude-executable.ts`), scanner de projetos, índice de sessões (lê os
  `.jsonl` do `~/.claude`), perfis (`CLAUDE_CONFIG_DIR`), semáforo (servidor
  HTTP local que recebe hooks), config em `%APPDATA%\donel-dev\config.json`.
- `src/preload/` — ponte de IPC. `contextIsolation` ligado; o renderer nunca
  toca `node:*`.
- `src/renderer/` — React. Sidebar de projetos, abas, launcher, painel da sessão.
- `src/shared/` — módulos **puros** (sem I/O). É onde mora a maior parte da
  lógica testável: `commandBuilder.ts`, ordenação, parsing, registry de sessões.
- `design-system/` — pacote de workspace com os componentes de UI.

## Regras do projeto

- **Credenciais**: o app nunca lê, grava ou exibe credencial. `/login` acontece
  só dentro do terminal, pelo fluxo oficial do CLI.
- **Nunca escrever no `~/.claude/settings.json` do usuário.** Os hooks do
  semáforo entram por `--settings <arquivo próprio>`, de forma aditiva.
- **`node-pty` precisa casar com a ABI do Electron.** Ao subir versão de
  Electron ou de node-pty, conferir o `postinstall` e os prebuilds.
- **Transcripts `.jsonl` nunca são lidos inteiros** — streaming + `stat`. Há
  sessão de centenas de MB.
- **Argv do `claude` é array de tokens discretos**, sem shell no meio: valor
  nunca leva aspas literais (ver o comentário de topo de
  `src/shared/commandBuilder.ts`).
- **TDD com escopo**: módulo puro em `src/shared/` e lógica do main entram com
  teste `vitest`. PTY e UI validam por smoke de Playwright, não por unitário.
- UI em pt-BR; código, comentários e identificadores em inglês.

## Comandos

```powershell
npm run dev          # app em desenvolvimento
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run build        # necessário ANTES dos smokes
npm run test:smoke   # Playwright
npm run dist         # instalador NSIS em release/
```

## Problemas conhecidos

Estão listados no `README.md`, seção **Problemas conhecidos** — ler antes de
diagnosticar um bug de sessão que morre no nascimento ou de projeto que não
aparece na sidebar.
