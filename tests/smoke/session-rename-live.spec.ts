import { appendFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT, SESSIONS_DIR } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke da T413 (004-nomear-sessoes, Fase C) — o CA-4: um `/rename` feito no CLI
// reflete na aba em MENOS DE 1 s, sem reabrir a sessão nem reiniciar o app.
//
// Custo: uma sessão `claude` REAL é aberta (o watcher só existe para abas
// claude), mas **nenhum turno de API é consumido** — nada é digitado no prompt.
// O que exercita o watcher é a ESCRITA no `.jsonl`, que é exatamente o que o
// `/rename` do CLI faz; o teste escreve o mesmo registro que o CLI escreveria.
// Digitar `/rename` de verdade dependeria da cota e do tempo de resposta do
// CLI, o que tornaria o teste ambiental — isso fica no roteiro E2E humano.
//
// O truque para descobrir o `sessionId` da sessão VIVA sem expor estado novo na
// UI: renomear a aba pela interface faz o `main` PERSISTIR o nome sob a chave
// `sessionId` (T406). O teste lê o `config.json` pelo IPC e pega a chave que
// apareceu. Nenhuma API nova foi criada para testar.
//
// Isolamento: `--user-data-dir` temp. O `.jsonl` fica sob o `homedir()` REAL
// (é lá que o CLI escreve) — se este teste criar o arquivo, ele o remove no
// `afterAll`; se o CLI já o tinha criado, só a linha extra fica, e ela é
// sintética (nome de sessão, sem conteúdo de conversa — LGPD).

// T801/§B19 (008) — `APP_MAIN`/`PROJECT_NAME`/`REPO_ROOT`/`SESSIONS_DIR` vêm de `repoUnderTest.ts`: o nome do projeto na
// sidebar é o `basename` da PASTA (numa worktree, `donel-dev-wt-x`), e sai da
// MESMA fonte que o `SESSIONS_DIR` da fixture — divergir entre os dois era o
// bug do §B19 (o clique achava o `donel-dev` de verdade e a lista voltava vazia).


let electronApp: ElectronApplication;
let appWindow: Page;
let userDataDir: string;
/** Só é removido no fim se ESTE teste criou o arquivo. */
let createdTranscriptPath: string | null = null;

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('session-rename-live');
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

test('T413 — CA-4: custom-title escrito no transcript da sessão VIVA reflete na aba em < 1 s, e o CLI vence o nome da UI (C2)', async () => {
  test.setTimeout(180_000);

  // Só faz sentido com o perfil Principal ativo: com outro perfil, o CLI grava
  // o transcript sob o diretório daquele perfil, não em `~/.claude`.
  const profiles = await appWindow.evaluate(() => window.donel.profiles.list());
  const active = profiles.find((profile) => profile.active);
  test.skip(!active?.isPrimary, `perfil ativo não é o Principal (${active?.slug}) — transcript não fica em ~/.claude`);

  // 1. Abre uma sessão claude real clicando no projeto na sidebar (1 clique,
  //    sem Launcher — o watcher nasce no `pty:create`, não no launcher).
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

  // 2. Renomeia pela UI — é o que revela o `sessionId` desta sessão viva
  //    (o main persiste sob essa chave) sem inventar API de teste.
  const uiName = `ui-${Date.now().toString(36)}`;
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

  // 3. Escreve no transcript exatamente o que o `/rename` do CLI escreve.
  const transcriptPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    createdTranscriptPath = transcriptPath;
  }
  const cliTitle = `cli-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  appendFileSync(transcriptPath, `${JSON.stringify({ type: 'custom-title', customTitle: cliTitle, sessionId })}\n`, 'utf8');

  // 4. CA-4: a aba troca sozinha, em menos de 1 s.
  //    Medição com polling APERTADO (25 ms) em vez de `expect().toHaveAttribute`:
  //    o polling progressivo do Playwright chega a ~500 ms de intervalo e
  //    inflaria a latência medida (a primeira medição saiu 852 ms por isso, com
  //    debounce de 300 ms — o número não era do app, era do amostrador).
  await appWindow.waitForFunction(
    (expected: string) =>
      document.querySelector('[role="tab"]')?.getAttribute('title')?.startsWith(expected) === true,
    cliTitle,
    { polling: 25, timeout: 3_000 },
  );
  const elapsedMs = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(`[CA-4] aba refletiu o custom-title em ${elapsedMs} ms (debounce 300 ms + fs.watch + IPC; alvo < 1000 ms)`);
  expect(elapsedMs).toBeLessThan(1_000);

  // 5. …e a sidebar mostra o mesmo valor (CA-5: uma resolução só).
  await expect(sidebar.getByText(cliTitle, { exact: true })).toBeVisible();

  // 6. C2 fechado: o `/rename` veio DEPOIS do nome da UI, então o CLI vence e a
  //    entrada da UI é descartada do storage — não fica nome morto competindo.
  await expect(async () => {
    const after = await appWindow.evaluate(() => window.donel.config.get());
    expect(after.sessionNames[sessionId]).toBeUndefined();
  }).toPass({ timeout: 5_000 });

  // 7. Fecha a aba (mata o PTY) — o watcher tem de sair com ela; a prova de que
  //    não vaza handle é o unit do registry, aqui só não deixamos sujeira.
  await tab.getByRole('button', { name: new RegExp(`^Fechar aba ${cliTitle}`) }).click();
  const closeModal = appWindow.getByRole('dialog', { name: 'Fechar sessão?' });
  if (await closeModal.isVisible().catch(() => false)) {
    await closeModal.getByRole('button', { name: 'Fechar' }).click();
  }
  await expect(appWindow.locator('[role="tab"]')).toHaveCount(0);
});
