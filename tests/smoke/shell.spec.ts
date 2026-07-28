import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke do feedback E2E rodada 2 ("app inteiro tem scrollbar vertical" —
// item 7 do roteiro batch 2): prova que o documento (body) nunca tem
// overflow, mesmo com o shell inteiro carregado (sidebar + tabs + terminal +
// painel direito). `scrollHeight` só bate com `clientHeight` quando não há
// NADA pra rolar no nível do documento — scroll continua existindo, mas
// sempre interno aos painéis (sidebar/terminal), nunca na janela.

// T801/§B19 (008) — `APP_MAIN`/`REPO_ROOT`/`PROJECT_NAME` vêm de
// `repoUnderTest.ts`: o projeto na sidebar é o `basename` da PASTA de onde a
// suíte roda (numa worktree, `donel-dev-wt-x`), nunca o literal `donel-dev`.

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('shell');
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: REPO_ROOT });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp.close();
  removeIsolatedUserDataDir(userDataDir);
});

test('o shell inteiro não tem scrollbar no documento (body.scrollHeight === body.clientHeight)', async () => {
  test.setTimeout(60_000);

  // FIX (decisão A, 2026-07-23) — o app nasce com ZERO abas (empty state,
  // App.tsx `INITIAL_TABS`); prova o empty state primeiro (nenhum
  // `terminal-pane` ainda) e só depois abre uma sessão pra provar o mesmo
  // cenário original (shell inteiro carregado, COM terminal + toolbar de
  // Modelo/Esforço, que é quem mais rouba espaço vertical/horizontal).
  const emptyState = window.locator('[data-testid="empty-state"]');
  await expect(emptyState).toBeVisible();

  const emptyDimensions = await window.evaluate(() => ({
    scrollHeight: document.body.scrollHeight,
    clientHeight: document.body.clientHeight,
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
  }));
  expect(emptyDimensions.scrollHeight).toBe(emptyDimensions.clientHeight);
  expect(emptyDimensions.scrollWidth).toBe(emptyDimensions.clientWidth);

  // FIX (auditoria rodada 6 ciclo 2, achado media "CTA do titlebar reproduz
  // o bug do empty state em 1 clique") — sem `lastLaunch`/
  // `selectedProjectPath` (estado deste boot), o clique no corpo do "＋ Nova
  // sessão" abre o Launcher em vez de spawnar direto em `cwd: undefined`/home
  // — escolhe `donel-dev` (repo já confiável nesta máquina) pra chegar na
  // mesma prova de sempre (shell com terminal carregado).
  //
  // FIX (teste manual 27/07) — o corpo do "＋ Nova sessão" agora abre o
  // Launcher SEMPRE (não só na ausência de lançamento anterior); a toolbar de
  // Modelo/Esforço (SessionDetails) foi removida — a leitura equivalente
  // agora vive na StatusBar (rodapé), fora do escopo deste teste (que só
  // mede scroll do documento).
  await window.getByRole('button', { name: '＋ Nova sessão', exact: true }).click();
  const launcher = window.locator('[data-testid="launcher"]');
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: 'Selecione um projeto' }).click();
  await window.getByRole('option', { name: PROJECT_NAME, exact: true }).click();
  await launcher.getByRole('radio', { name: 'haiku', exact: true }).click();
  await launcher.getByRole('button', { name: '▶ Iniciar' }).click();

  const shell = window.locator('[data-testid="terminal-pane"]');
  await expect(shell).toBeVisible();

  const dimensions = await window.evaluate(() => ({
    scrollHeight: document.body.scrollHeight,
    clientHeight: document.body.clientHeight,
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
  }));

  expect(dimensions.scrollHeight).toBe(dimensions.clientHeight);
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
});

test('redimensionar a janela continua sem criar scrollbar no documento', async () => {
  const originalSize = window.viewportSize();
  await window.setViewportSize({ width: 1000, height: 650 });
  await window.waitForTimeout(300);

  const dimensions = await window.evaluate(() => ({
    scrollHeight: document.body.scrollHeight,
    clientHeight: document.body.clientHeight,
  }));
  expect(dimensions.scrollHeight).toBe(dimensions.clientHeight);

  await window.setViewportSize({ width: originalSize?.width ?? 1280, height: originalSize?.height ?? 800 });
});
