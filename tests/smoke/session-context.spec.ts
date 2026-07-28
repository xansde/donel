import { appendFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT, SESSIONS_DIR } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke da Fase C da 006 (T611/T612), ADAPTADO no teste manual de 27/07
// (commit 40c202c): a toolbar SessionDetails (que mostrava o `%` de contexto
// POR ABA, com estado de alerta acima de 100% da smart zone) saiu dos dois
// modos — "não tem sido nem um pouco útil". O MECANISMO por trás (T610,
// transcript-watcher lendo `message.usage` do `.jsonl`) continua 100% vivo;
// só a SUPERFÍCIE mudou: agora é a StatusBar (rodapé), GLOBAL para a aba em
// foco (não mais por-aba-na-toolbar), e mostra tokens BRUTOS arredondados em
// milhares — `"<model>/<effort> · ctx Nk"` — sem `%`, sem denominador de
// zona, sem estado de alerta visual (App.tsx `activeModelEffort`/
// `activeContextTokens`).
//
// NÃO ADAPTÁVEL sem mexer em src/ (reportado, não implementado aqui): a
// matemática de `%` relativa à smart zone (CA-6/CA-7), o estado "acima de
// 100%" (CA-8/CA-9, `data-over-zone`) e o tooltip com o denominador da janela
// não têm mais NENHUMA representação na árvore renderizada — só existem no
// arquivo morto `SessionDetails.tsx` (nunca montado). Cobertura que
// permanece válida sem tocar produção: `tests/contextWindow.test.ts` (a
// matemática pura de `%`/zona, que continua correta mesmo sem consumidor de
// UI) e o roteiro E2E humano (T614) para o que só um humano pode julgar.
//
// Custo: uma sessão `claude` REAL é aberta (o watcher só existe para abas
// claude), mas **nenhum turno de API é consumido** — nada é digitado no prompt.
// O que exercita a feature é a ESCRITA no `.jsonl`: o teste escreve a MESMA
// linha `assistant` com `message.usage` que o CLI escreveria ao fim de um turno
// (forma conferida no disco em 26/07 — ver `medicao-t606.md`). Depender de um
// turno real tornaria o teste ambiental (cota/rede), e foi exatamente o que
// deixou dois smokes vermelhos em 24/07 (backlog §B11).
//
// O truque para descobrir o `sessionId` da sessão VIVA sem API nova é o mesmo do
// `session-rename-live.spec.ts`: renomear pela UI faz o `main` persistir o nome
// sob a chave `sessionId`.

// T801/§B19 (008) — `APP_MAIN`/`PROJECT_NAME`/`REPO_ROOT`/`SESSIONS_DIR` vêm de `repoUnderTest.ts`: o nome do projeto na
// sidebar é o `basename` da PASTA (numa worktree, `donel-dev-wt-x`), e sai da
// MESMA fonte que o `SESSIONS_DIR` da fixture — divergir entre os dois era o
// bug do §B19 (o clique achava o `donel-dev` de verdade e a lista voltava vazia).


/** Linha `assistant` como o CLI escreve: a `usage` fica em `message.usage`. */
function usageLine(input: number, cacheRead: number, cacheCreation: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: 1177,
      },
    },
  })}\n`;
}

let electronApp: ElectronApplication;
let appWindow: Page;
let userDataDir: string;
/** Só é removido no fim se ESTE teste criou o arquivo. */
let createdTranscriptPath: string | null = null;

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('session-context');
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: REPO_ROOT });
  appWindow = await electronApp.firstWindow();
  await appWindow.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  test.setTimeout(90_000); // folga do B11 para o close com PTY vivo
  try {
    await electronApp.close();
  } finally {
    removeIsolatedUserDataDir(userDataDir);
    if (createdTranscriptPath && existsSync(createdTranscriptPath)) {
      try {
        unlinkSync(createdTranscriptPath);
      } catch {
        // já removido — ok
      }
    }
  }
});

test('T611/T612 (adaptado 27/07) — a StatusBar mostra "ctx Nk" pra aba em foco, atualiza ao vivo com o turno novo e cai quando o turno fica menor (não é acumulado)', async () => {
  test.setTimeout(180_000);

  // Só faz sentido com o perfil Principal ativo: com outro perfil o CLI grava o
  // transcript sob o diretório daquele perfil, não em `~/.claude`.
  const profiles = await appWindow.evaluate(() => window.donel.profiles.list());
  const active = profiles.find((profile) => profile.active);
  test.skip(!active?.isPrimary, `perfil ativo não é o Principal (${active?.slug}) — transcript não fica em ~/.claude`);

  // 1. Abre uma sessão claude real clicando no projeto na sidebar.
  const sidebar = appWindow.locator('nav[aria-label="Projetos e sessões"]');
  const projectRow = sidebar.locator(`[data-testid="project-row-${PROJECT_NAME}"]`);
  await expect(projectRow).toBeVisible({ timeout: 15_000 });
  await projectRow.getByRole('button', { name: PROJECT_NAME, exact: true }).click();

  const tab = appWindow.locator('[role="tab"]').first();
  await expect(tab).toBeVisible();
  const pane = appWindow.locator('[data-testid="terminal-pane"]:visible');
  await expect(async () => {
    const text = await pane.innerText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('CLAUDE_NOT_FOUND');
    expect(text).not.toContain('Falha ao iniciar');
  }).toPass({ timeout: 30_000 });

  // 2. CA-4 (adaptado) — sessão recém-nascida, sem nenhum turno → a StatusBar
  // mostra modelo/esforço da aba (tem "/"), mas NUNCA o sufixo "· ctx Nk"
  // sem uma leitura real do transcript-watcher (App.tsx `activeContextTokens`
  // nasce `null`, filtrado do array antes do `.join(' · ')`). Sem testid
  // próprio pro span de modelo/esforço (design-system só expõe `accountTestId`,
  // ver StatusBar.tsx) — o container inteiro (`div:has(> ...)`) é o locator
  // estável disponível.
  const statusBar = appWindow.locator('div:has(> [data-testid="statusbar-account"])');
  await expect(statusBar).toContainText('/');
  await expect(statusBar).not.toContainText('ctx ');

  // 3. Descobre o `sessionId` da sessão viva renomeando pela UI (o main persiste
  //    sob essa chave) — nenhuma API de teste nova.
  const uiName = `ctx-${Date.now().toString(36)}`;
  await tab.getByText(PROJECT_NAME, { exact: true }).dblclick();
  const input = tab.getByRole('textbox');
  await expect(input).toBeVisible();
  await input.fill(uiName);
  await input.press('Enter');
  await expect(tab).toHaveAttribute('title', new RegExp(`^${uiName} —`));

  const config = await appWindow.evaluate(() => window.donel.config.get());
  const entries = Object.entries(config.sessionNames).filter(([, entry]) => entry.name === uiName);
  expect(entries, 'o rename pela UI tinha de ter persistido sob o sessionId da sessão viva').toHaveLength(1);
  const [sessionId] = entries[0];

  const transcriptPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    createdTranscriptPath = transcriptPath;
  }

  // 4. Turno novo: 290 + 132.807 + 1.505 = 134.602 tokens brutos → arredonda
  // pra "ctx 135k" (Math.round(134602 / 1000), App.tsx `activeModelEffort`).
  // Sem `%`/zona: o número agora é absoluto, não depende mais do modelo ativo.
  appendFileSync(transcriptPath, usageLine(290, 132_807, 1_505), 'utf8');
  await expect(statusBar).toContainText('ctx 135k', { timeout: 5_000 });

  // 5. Turno maior — 380.000 = 300.000 + 60.000 + 20.000 → "ctx 380k". (O
  // antigo CA-8/CA-9, "estado de alerta acima de 100% da smart zone", NÃO
  // TEM equivalente aqui — sem `%`/zona não há "acima de 100%" pra alertar;
  // ver cabeçalho do arquivo, "NÃO ADAPTÁVEL sem mexer em src/".)
  appendFileSync(transcriptPath, usageLine(300_000, 60_000, 20_000), 'utf8');
  await expect(statusBar).toContainText('ctx 380k', { timeout: 5_000 });

  // 6. C1: o número é o contexto AGORA, não acumulado — um turno menor (o que um
  //    `/compact` produz) faz o valor CAIR: 150 + 20.000 + 0 = 20.150 → "ctx 20k".
  appendFileSync(transcriptPath, usageLine(150, 20_000, 0), 'utf8');
  // Timeout maior que os anteriores por um motivo MEDIDO, não por superstição:
  // na primeira execução deste smoke este passo ficou 5 s inteiros exibindo o
  // valor anterior e passou com folga maior. Um append único seguido de silêncio
  // é o pior caso para `fs.watch` no Windows (evento coalescido/perdido não tem
  // nada depois para "consertá-lo"); numa sessão real o CLI escreve várias
  // linhas por turno, então o próximo evento chega em seguida. Registrado como
  // dívida nomeada em `specs/backlog.md` §B15.
  await expect(statusBar).toContainText('ctx 20k', { timeout: 20_000 });

  // 7. Fecha a aba (mata o PTY e o watcher) — não deixa sujeira para os outros.
  await tab.getByRole('button', { name: new RegExp(`^Fechar aba ${uiName}`) }).click();
  const closeModal = appWindow.getByRole('dialog', { name: 'Fechar sessão?' });
  if (await closeModal.isVisible().catch(() => false)) {
    await closeModal.getByRole('button', { name: 'Fechar sessão', exact: true }).click();
  }
  await expect(appWindow.locator('[role="tab"]')).toHaveCount(0);
});

test('aba de terminal livre (shell) não mostra modelo/esforço nem ctx no rodapé (CA-4/CA-5 adaptado — a toolbar por-aba foi removida, a leitura agora é a StatusBar global)', async () => {
  test.setTimeout(60_000);

  // FIX (teste manual 27/07) — `[data-testid="session-details"]`/
  // `[data-testid="session-context"]` não existem mais em NENHUMA aba
  // (SessionDetails.tsx não é mais montada nem para sessões claude — ver
  // cabeçalho do arquivo), então `toHaveCount(0)` contra esses testids
  // deixou de provar algo específico de shell. A prova equivalente agora é
  // no rodapé global: só sessões `claude` alimentam `activeModelEffort`
  // (App.tsx) — uma aba shell em foco não deve mostrar nem o segmento
  // "modelo/esforço" (sinalizado pela presença de "/") nem "ctx".
  await appWindow.getByRole('button', { name: 'Mais opções de ＋ Nova sessão' }).click();
  await appWindow.getByRole('menuitem', { name: 'Terminal' }).click();

  await expect(appWindow.locator('[role="tab"]')).toHaveCount(1);
  const statusBar = appWindow.locator('div:has(> [data-testid="statusbar-account"])');
  await expect(statusBar).not.toContainText('ctx ');
  await expect(statusBar).not.toContainText('/');
});
