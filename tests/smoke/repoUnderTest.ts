import { homedir } from 'node:os';
import path from 'node:path';

// §B19 (backlog) / 008-fechar-pendencias T801 — o repo SOB TESTE, calculado.
//
// Por que existe: os smokes semeiam a fixture `.jsonl` num diretório derivado
// da PRÓPRIA pasta (`slugify(REPO_ROOT)`), mas localizavam o projeto na
// sidebar por nome HARDCODED (`'donel-dev'`, `exact: true`). Numa worktree
// (`donel-dev-wt-005`) o ProjectScanner varre `~/seazone` e lista as DUAS
// pastas — o clique achava um projeto, só que o errado, e a lista voltava com
// 0 linhas. Cinco specs falhavam 100% das vezes fora da pasta `donel-dev`, por
// motivo de TESTE, cegando o gate do modelo de lote (que roda sempre em
// worktree).
//
// Por que os dois num módulo só: o nome do projeto e o `SESSIONS_DIR` têm de
// sair da MESMA fonte, senão voltam a divergir — era exatamente a divergência
// do §B19. Antes disto, `slugifyProjectPath` estava COPIADO em 4 specs.
//
// Padrão preservado: smokes nunca importam de `src/` (o teste não pode herdar
// o bug do código que testa), então a regra do slug é duplicada aqui de
// propósito — 1:1 com `slugifyProjectPath` de `src/main/session-indexer.ts`,
// e é o app real (via `electron.launch`) quem prova a regra. Helper
// compartilhado no diretório já é padrão daqui: `userDataIsolation.ts`,
// importado inclusive de `tests/smoke-dev/`.

/** Raiz absoluta do repo/worktree de onde a suíte está rodando. */
export const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Nome com que o projeto aparece na sidebar. O ProjectScanner usa o nome da
 * PASTA, não o `name` do `package.json` — numa worktree é `donel-dev-wt-007`,
 * não `donel-dev`. Calculado, nunca hardcoded.
 *
 * ⚠️ Não confundir com o nome do APP (`app.setName('donel-dev')`), que define
 * `%APPDATA%\donel-dev\config.json` e é constante em qualquer worktree — ver
 * `config-persistence.spec.ts` (allowlist da cerca `smoke-project-name.test.ts`).
 */
export const PROJECT_NAME = path.basename(REPO_ROOT);

/** `out/main/index.js` do build de produção — o que `electron.launch` recebe. */
export const APP_MAIN = path.join(REPO_ROOT, 'out', 'main', 'index.js');

/** Duplicado de propósito de `slugifyProjectPath` (src/main/session-indexer.ts) — ver comentário de topo. */
export function slugifyProjectPath(absoluteProjectPath: string): string {
  return absoluteProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Onde o CLI guarda os transcripts DESTE repo/worktree (`~/.claude/projects/<slug>`). */
export const SESSIONS_DIR = path.join(homedir(), '.claude', 'projects', slugifyProjectPath(REPO_ROOT));
