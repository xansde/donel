import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke do feedback E2E rodada 3 ("BUG — favoritar projeto só reflete após
// reiniciar o app", → Batch 5): a lógica de merge/ordenação já estava
// correta (tests/projects.test.ts) — o que faltava era a UI refletir sem
// esperar o round-trip do scan síncrono do main (App.tsx agora reordena
// otimisticamente, ver handleToggleFavorite). Prova aqui via ORDEM NO DOM
// dos data-testid `project-row-*` (índice de "donel-dev" entre eles), não
// via posição em pixels (bounding box) — esta máquina real tem 39 projetos
// em `~/seazone`, a sidebar rola internamente, e comparar coordenadas Y
// absolutas entre passos que fazem `.click()` (que auto-scrolla o alvo pra
// dentro da viewport, mudando o scroll offset a cada ação) deu falso
// positivo de "não restaurou" numa primeira versão deste teste — a ORDEM já
// estava 100% correta (confirmado via `window.donel.projects.list()` num
// script de diagnóstico), só a leitura de pixels que era frágil.
//
// Roda contra o scan REAL de `~/seazone` (mesmo padrão de terminal.spec.ts
// — `donel-dev`, este próprio repo, sempre presente) — sem fixture
// isolada de projetos. `test.afterAll` deixa o favorito desmarcado de novo
// (best-effort) pra não sujar o `project-config.json` real da máquina.
//
// Variável da página chamada `appWindow` (não `window`, diferente do padrão
// dos outros arquivos de smoke) DE PROPÓSITO: este arquivo usa
// `page.evaluate()` pra chamar `window.donel.*` DENTRO do contexto do
// browser — nomear a variável do Playwright igual ao global do browser
// sombrearia `window` léxicamente pro TypeScript dentro do callback do
// `evaluate` (ele resolveria pro tipo `Page`, não pro `Window` do DOM).

// T801/§B19 (008) — `APP_MAIN`/`REPO_ROOT`/`PROJECT_NAME` vêm de
// `repoUnderTest.ts`: o projeto na sidebar é o `basename` da PASTA de onde a
// suíte roda (numa worktree, `donel-dev-wt-x`), nunca o literal `donel-dev`.

let electronApp: ElectronApplication;
let appWindow: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('sidebar-favorites');
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: REPO_ROOT });
  appWindow = await electronApp.firstWindow();
  await appWindow.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await appWindow
    .evaluate(async () => {
      const projects = await window.donel.projects.list();
      const target = projects.find((project) => project.name === PROJECT_NAME);
      if (target?.favorite) await window.donel.projects.setFavorite(target.path, false);
    })
    .catch(() => undefined);
  await electronApp.close();
  removeIsolatedUserDataDir(userDataDir);
});

/** Índice de "donel-dev" entre TODAS as linhas de projeto renderizadas (ordem real do DOM, não pixels — estável mesmo com scroll interno da sidebar). */
async function donelDevIndex(sidebar: Locator): Promise<number> {
  const testIds = await sidebar.locator('[data-testid^="project-row-"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')));
  return testIds.indexOf(`project-row-${PROJECT_NAME}`);
}

test('favoritar um projeto reordena a sidebar imediatamente, sem restart', async () => {
  const sidebar = appWindow.locator('nav[aria-label="Projetos e sessões"]');
  await expect(sidebar).toBeVisible();

  const row = sidebar.locator(`[data-testid="project-row-${PROJECT_NAME}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const favoriteButton = row.getByRole('button').first();

  // Estado limpo: garante que começa DESFAVORITADO — não assume o que uma
  // run anterior (ou uso manual real do app) deixou.
  if ((await favoriteButton.getAttribute('aria-pressed')) === 'true') {
    await favoriteButton.click();
    await expect(favoriteButton).toHaveAttribute('aria-pressed', 'false');
  }

  const indexBefore = await donelDevIndex(sidebar);
  expect(indexBefore).toBeGreaterThanOrEqual(0);

  await favoriteButton.click();

  // Sem NENHUM reload/restart — só o próximo paint do React. `toPass` cobre
  // o tempo normal de um re-render, nunca um round-trip de IPC/scan.
  await expect(async () => {
    await expect(favoriteButton).toHaveAttribute('aria-pressed', 'true');
    // Sobe pro topo do grupo `seazone/` (favoritos primeiro, ui-spec §2) —
    // índice MENOR prova que a linha realmente MOVEU no DOM, não só que a
    // estrela mudou de ícone no lugar.
    const indexAfter = await donelDevIndex(sidebar);
    expect(indexAfter).toBeGreaterThanOrEqual(0);
    expect(indexAfter).toBeLessThan(indexBefore);
  }).toPass({ timeout: 2_000 });

  // Desfavoritar também reflete na hora — volta pro ÍNDICE alfabético
  // original (nenhum outro projeto mudou de estado no meio do teste).
  await favoriteButton.click();
  await expect(async () => {
    await expect(favoriteButton).toHaveAttribute('aria-pressed', 'false');
    const indexRestored = await donelDevIndex(sidebar);
    expect(indexRestored).toBe(indexBefore);
  }).toPass({ timeout: 2_000 });
});
