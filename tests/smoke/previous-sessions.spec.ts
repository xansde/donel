import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT, SESSIONS_DIR } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke da T013 (UI de sessões anteriores, FR-004/CA-2).
//
// CORREÇÃO da auditoria do batch 4 (ciclo 1, achado [média]): a versão
// anterior deste arquivo dependia dos dados REAIS desta máquina (a sessão
// mais recente do próprio donel-dev) pra provar "Retomar restaura a
// conversa". Isso é não-determinístico — se a sessão mais recente cair num
// fallback do SessionIndexer ("(sem mensagem de usuário)"/"(ilegível)") ou
// não tiver palavra >= 4 chars, o teste pulava via `test.skip` e a metade de
// RESTAURAÇÃO de CA-2 nunca era observada green (só provada por construção:
// CommandBuilder unit-tested + flags do CLI verificadas via `claude --help`).
// Fork não tinha smoke nenhum.
//
// Fix: SEMEIA duas sessões sintéticas com marcador conhecido diretamente em
// `~/.claude/projects/<slug-real-do-donel-dev>/<id>.jsonl` (uma pra Retomar,
// outra pra Fork) antes de abrir o app, no MESMO diretório real que o
// SessionIndexer/CLI já leem pra este projeto — não um projeto de teste à
// parte, porque `slugifyProjectPath` (session-indexer.ts) é 1:1 com o path
// absoluto do repo, e o histórico de comando desta task pede provar contra o
// projeto real "donel-dev" que a sidebar já lista. O schema da linha JSONL
// (campos, tipos) foi inspecionado numa sessão real desta própria máquina
// (só as CHAVES, nunca o conteúdo — LGPD) pra garantir que o `claude -r`
// real aceita o arquivo como transcript válido, não só o nosso indexador.
// Localizar a sessão sintética usa a busca da própria UI (Filtrar por nome)
// por um marcador único gerado em runtime — nunca a ordem/posição da lista —
// então o resultado independe de quantas sessões reais este repo já tem ou
// de qual delas é a mais recente no momento da execução.
//
// LGPD: o conteúdo das duas linhas JSONL escritas por este arquivo é 100%
// sintético (gerado aqui, nunca uma mensagem real de trabalho) e os arquivos
// são apagados no `afterAll` (roda mesmo se o teste falhar) — nada disso é
// commitado como fixture nem persiste na máquina depois da execução. Ver
// também profiles.spec.ts (mesmo padrão de escrever/limpar sob o `homedir()`
// real em vez de fixture commitada, quando o alvo é literalmente o
// filesystem que o app/CLI leem em produção).
//
// Custo: nenhum prompt novo é mandado ao CLI depois do resume/fork — só se
// espera o CLI carregar o transcript local e reimprimir o scrollback (mesma
// lógica local de sempre, sem turno de API novo).

// T801/§B19 (008) — `APP_MAIN`/`PROJECT_NAME`/`REPO_ROOT`/`SESSIONS_DIR` vêm de `repoUnderTest.ts`: o nome do projeto na
// sidebar é o `basename` da PASTA (numa worktree, `donel-dev-wt-x`), e sai da
// MESMA fonte que o `SESSIONS_DIR` da fixture — divergir entre os dois era o
// bug do §B19 (o clique achava o `donel-dev` de verdade e a lista voltava vazia).


function detectClaudeCliVersion(): string {
  try {
    const raw = execSync('claude --version', { encoding: 'utf8' });
    const match = raw.match(/^(\S+)/);
    return match ? match[1] : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function detectGitBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const CLI_VERSION = detectClaudeCliVersion();
const GIT_BRANCH = detectGitBranch();

interface SyntheticSessionSeed {
  readonly id: string;
  readonly filePath: string;
  readonly marker: string;
}

/**
 * Escreve uma sessão sintética válida (schema inspecionado numa sessão real
 * desta máquina — só as chaves, nunca conteúdo) com UMA linha `type: user`
 * cujo texto começa pelo `marker` — único o bastante pra localizar via busca
 * na UI sem depender de ordenação. `parentUuid: null` porque é a única
 * mensagem da sessão (mesmo formato de uma sessão real interrompida antes da
 * resposta do assistente — caso legítimo que o CLI já sabe carregar).
 */
function seedSyntheticSession(marker: string): SyntheticSessionSeed {
  const id = randomUUID();
  const filePath = join(SESSIONS_DIR, `${id}.jsonl`);
  const line = {
    type: 'user',
    message: {
      role: 'user',
      content: `${marker} — fixture sintética do smoke E2E do Donel Dev (T013), sem conteúdo real de trabalho.`,
    },
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: id,
    timestamp: new Date().toISOString(),
    cwd: REPO_ROOT,
    gitBranch: GIT_BRANCH,
    permissionMode: 'bypassPermissions',
    version: CLI_VERSION,
    entrypoint: 'claude-desktop',
    userType: 'external',
    promptId: randomUUID(),
    promptSource: 'sdk',
    isSidechain: false,
  };
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(line)}\n`, 'utf8');
  return { id, filePath, marker };
}

function removeSessionFile(filePath: string | undefined): void {
  if (!filePath || !existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    // Já removido — ok.
  }
}

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;
let resumeSeed: SyntheticSessionSeed;
let forkSeed: SyntheticSessionSeed;
let forkOriginalContent: string;

test.beforeAll(async () => {
  resumeSeed = seedSyntheticSession(`MARCADOR-SMOKE-RESUME-${randomUUID().slice(0, 8)}`);
  forkSeed = seedSyntheticSession(`MARCADOR-SMOKE-FORK-${randomUUID().slice(0, 8)}`);
  forkOriginalContent = readFileSync(forkSeed.filePath, 'utf8');

  userDataDir = createIsolatedUserDataDir('previous-sessions');
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: REPO_ROOT });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  // FIX B11 (2026-07-24) — mesmo endurecimento de `profiles.spec.ts` /
  // `model-injection.spec.ts` / `tabs-lifecycle.spec.ts`: folga só neste hook
  // para o `electronApp.close()` sob carga.
  // O `finally` aqui é MAIS crítico que nos outros arquivos: os dois seeds
  // são `.jsonl` sintéticos escritos sob o `homedir()` REAL do usuário (ver
  // nota de LGPD no topo). Sem `finally`, um close que estoura deixava esses
  // arquivos permanentes em `~/.claude/projects/` — resíduo no ambiente de
  // produção do próprio usuário, não só em %TEMP%.
  test.setTimeout(90_000);
  try {
    await electronApp.close();
  } finally {
    removeIsolatedUserDataDir(userDataDir);
    removeSessionFile(resumeSeed?.filePath);
    removeSessionFile(forkSeed?.filePath);
  }
});

async function openPreviousSessionsDialog() {
  const sidebar = window.locator('nav[aria-label="Projetos e sessões"]');
  await expect(sidebar).toBeVisible();

  const historyButton = sidebar.getByRole('button', { name: `Sessões anteriores de ${PROJECT_NAME}`, exact: true });
  await expect(historyButton).toBeVisible({ timeout: 15_000 });
  await historyButton.click();

  const dialog = window.getByRole('dialog', { name: new RegExp(`Sessões anteriores · ${PROJECT_NAME}`) });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('T013 — Retomar restaura o histórico da sessão sintética via marcador determinístico (FR-004, CA-2)', async () => {
  test.setTimeout(120_000);

  const dialog = await openPreviousSessionsDialog();

  // Isola a sessão sintética pela busca da própria UI — nunca pela posição
  // na lista (independe do estado das dezenas de sessões reais da máquina).
  await dialog.getByLabel('Filtrar sessões anteriores por nome').fill(resumeSeed.marker);
  const row = dialog.locator('[data-testid="previous-session-row"]');
  await expect(row).toHaveCount(1, { timeout: 10_000 });

  await row.getByRole('button', { name: 'Retomar' }).click();

  // Modal fecha (App.tsx `handleResumeSession`) e a aba nova abre.
  await expect(dialog).toBeHidden();
  const activePane = window.locator('[data-testid="terminal-pane"]:visible');
  await expect(activePane).toHaveCount(1);

  await expect(async () => {
    const text = await activePane.innerText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('CLAUDE_NOT_FOUND');
    expect(text).not.toContain('Falha ao iniciar');
  }).toPass({ timeout: 20_000 });

  // Mesmo diálogo de "Quick safety check" dos outros smokes (terminal.spec.ts).
  await activePane.click();
  if ((await activePane.innerText()).includes('trust this folder')) {
    await window.keyboard.press('Enter');
  }

  // Prova real de CA-2: o histórico da sessão RETOMADA aparece no terminal —
  // o marcador sintético (conhecido, gerado por este arquivo) surge na tela
  // sem que nenhum prompt novo tenha sido enviado (`claude -r <id>` sozinho
  // já reimprime o scrollback restaurado a partir do arquivo semeado).
  await expect(async () => {
    expect(await activePane.innerText()).toContain(resumeSeed.marker);
  }).toPass({ timeout: 30_000 });
});

test('T013 — Fork cria sessão nova a partir do histórico e mantém a sessão original intacta (FR-004, CA-2)', async () => {
  test.setTimeout(120_000);

  const dialog = await openPreviousSessionsDialog();

  await dialog.getByLabel('Filtrar sessões anteriores por nome').fill(forkSeed.marker);
  const row = dialog.locator('[data-testid="previous-session-row"]');
  await expect(row).toHaveCount(1, { timeout: 10_000 });

  await row.getByRole('button', { name: 'Fork' }).click();
  await expect(dialog).toBeHidden();

  const activePane = window.locator('[data-testid="terminal-pane"]:visible');
  await expect(activePane).toHaveCount(1);

  await expect(async () => {
    const text = await activePane.innerText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('CLAUDE_NOT_FOUND');
    expect(text).not.toContain('Falha ao iniciar');
  }).toPass({ timeout: 20_000 });

  await activePane.click();
  if ((await activePane.innerText()).includes('trust this folder')) {
    await window.keyboard.press('Enter');
  }

  // Prova real de CA-2 (Fork): o histórico da sessão original aparece na
  // sessão FORKADA (mesmo mecanismo local de reimpressão do scrollback que
  // o teste de Retomar acima — `--fork-session` também carrega o histórico
  // do id original antes de seguir com um id novo).
  await expect(async () => {
    expect(await activePane.innerText()).toContain(forkSeed.marker);
  }).toPass({ timeout: 30_000 });

  // Prova de "sessão ORIGINAL intacta" (achado da auditoria do batch 4,
  // ciclo 1, achado [média]): bytes do arquivo semeado (forkSeed)
  // permanecem exatamente os mesmos depois do fork — nunca sobrescritos.
  // NOTA: `--fork-session` só persiste o `.jsonl` do id NOVO no primeiro
  // turno de verdade da sessão forkada (confirmado empiricamente rodando
  // este smoke: nenhum arquivo novo aparece no diretório enquanto só o
  // scrollback é carregado, sem prompt novo) — como este smoke nunca manda
  // prompt novo (custo, ver cabeçalho do arquivo), a prova de "id novo" fica
  // só no CommandBuilder (unit-tested, flag real `--fork-session`
  // confirmada via `claude --help`); o que ESTE teste prova, no filesystem
  // real, é a garantia que a task pediu: a sessão original não é mutada.
  expect(readFileSync(forkSeed.filePath, 'utf8')).toBe(forkOriginalContent);
});
