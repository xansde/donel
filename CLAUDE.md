# Donel Dev — contexto para o Claude Code

App desktop Windows (Electron) que embeda o `claude` CLI num PTY e orquestra
várias sessões em abas. **O app não reimplementa o agente** — se uma mudança
começar a interpretar prompt, gerenciar contexto ou falar com a API, ela está no
lugar errado.

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
