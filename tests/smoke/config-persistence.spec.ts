import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT } from './repoUnderTest';

// Smoke da T015 (ConfigStore + statusbar — FR-007, FR-009): prova de
// persistência REAL através de um restart COMPLETO do app (fechar + reabrir
// via `electronApp.close()` + `electron.launch()` de novo), não só
// re-render — é o requisito explícito do DoD da task ("preferências
// sobrevivem a restart") e do roteiro E2E batch 5, passo 1.
//
// Cobre as DUAS preferências NOVAS deste batch pela UI de Preferências de
// verdade (gear icon no titlebar): roots de projetos (add + remove) e
// notificação do Windows. `launcherDefaults` e o favorito de "donel-dev"
// (campo migrado do T007 pro ConfigStore unificado) são verificados via
// `window.donel.config.*`/`window.donel.projects.*` direto (`evaluate`), sem
// passar pela UI de lançamento real — abrir uma sessão `claude` de verdade
// custaria cota e não é necessário pra provar persistência do CAMPO.
//
// `test.afterAll` restaura TODOS os valores mudados (roots, notificação,
// launcherDefaults, favorito de "donel-dev") pro estado original capturado
// no início do teste — mesma disciplina de higiene de profiles.spec.ts/
// sidebar-favorites.spec.ts (não deixa a máquina real do Alexandre com
// config alterado por um teste automatizado).
//
// FIX (auditoria rodada 5, achado media "playwright.config.ts") — DIFERENTE
// dos outros arquivos deste diretório (ver userDataIsolation.ts), este
// smoke NÃO usa `--user-data-dir` isolado: seu propósito DECLARADO (linha
// 122 abaixo) é provar persistência no path REAL de produção
// (`%APPDATA%\donel-dev\config.json`) — isolar quebraria o próprio objeto do
// teste. A defesa contra vazamento pra OUTROS specs é o `afterAll` acima
// (restaura os valores originais), não isolamento de diretório.

// T801/§B19 (008) — `APP_MAIN`/`REPO_ROOT`/`PROJECT_NAME` vêm de
// `repoUnderTest.ts`: o projeto na sidebar é o `basename` da PASTA de onde a
// suíte roda (numa worktree, `donel-dev-wt-x`), nunca o literal `donel-dev`.
const TEST_ROOT = 'C:\\donel-dev-smoke-t015-root';
const NEW_LAUNCHER_DEFAULTS = { model: 'haiku', effort: 'low', permissionMode: 'plan' } as const;

const NOTIFICATION_LABELS: Record<string, string> = {
  all: 'Todas as transições',
  'permission-only': 'Só permissão pendente',
  none: 'Nenhuma',
};

interface ConfigSnapshot {
  projectRoots: string[];
  notificationPreference: 'all' | 'permission-only' | 'none';
  launcherDefaults: { model: string; effort: string; permissionMode: string };
}

let electronApp: ElectronApplication;
let appWindow: Page;
let original: ConfigSnapshot;
let originalDonelDevFavorite = false;
let donelDevPath = '';

// Copia campo a campo pra um shape MUTÁVEL (config-store.ts devolve
// `readonly`) — evita fricção de tipos ao repassar esses valores de volta
// pra `setProjectRoots`/`setLauncherDefaults` (que aceitam `string[]`/objeto
// mutável) mais abaixo, tanto na restauração (`afterAll`) quanto nas
// asserções deste teste.
async function readConfig(win: Page): Promise<ConfigSnapshot> {
  const config = await win.evaluate(() => window.donel.config.get());
  return {
    projectRoots: [...config.projectRoots],
    notificationPreference: config.notificationPreference,
    launcherDefaults: { ...config.launcherDefaults },
  };
}

async function openPreferences(win: Page): Promise<import('@playwright/test').Locator> {
  await win.getByRole('button', { name: 'Preferências' }).click();
  const dialog = win.getByRole('dialog', { name: 'Preferências' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeAll(async () => {
  electronApp = await electron.launch({ args: [APP_MAIN], cwd: REPO_ROOT });
  appWindow = await electronApp.firstWindow();
  await appWindow.waitForLoadState('domcontentloaded');

  // FIX (auditoria rodada 6, achado media "snapshot capturado dentro do
  // corpo do teste") — ANTES esta captura acontecia nas primeiras linhas do
  // `test(...)` abaixo; se o teste falhasse (ou o worker morresse) ANTES
  // dessas linhas rodarem, `original` ficava `undefined` e o `afterAll`
  // (que roda de qualquer forma) tentava restaurar com um valor inexistente.
  // Movida pra cá — antes de QUALQUER mutação — pra sempre existir quando o
  // `afterAll` precisar dela, mesmo que o teste nunca chegue a rodar.
  original = await readConfig(appWindow);
  const projectsBefore = await appWindow.evaluate(() => window.donel.projects.list());
  const donelDevBefore = projectsBefore.find((project) => project.name === PROJECT_NAME);
  donelDevPath = donelDevBefore?.path ?? '';
  originalDonelDevFavorite = donelDevBefore?.favorite ?? false;
});

test.afterAll(async () => {
  try {
    await appWindow.evaluate(
      async ({ original, originalDonelDevFavorite, donelDevPath }) => {
        await window.donel.config.setProjectRoots(original.projectRoots);
        await window.donel.config.setNotificationPreference(original.notificationPreference);
        await window.donel.config.setLauncherDefaults(original.launcherDefaults as never);
        if (donelDevPath) await window.donel.projects.setFavorite(donelDevPath, originalDonelDevFavorite);
      },
      { original, originalDonelDevFavorite, donelDevPath },
    );
  } catch (error) {
    // FIX (auditoria rodada 6, achado media "`.catch(() => undefined)`
    // engole qualquer falha de restauração silenciosamente") — este é o
    // ÚNICO smoke do diretório que grava no config REAL da máquina
    // (`%APPDATA%\donel-dev\config.json`, ver cabeçalho do arquivo); uma
    // falha silenciosa aqui já contaminou a máquina real do Alexandre uma
    // vez (root fantasma `C:\donel-dev-smoke-t015-root` em `projectRoots`,
    // limpo manualmente na auditoria rodada 6). Loga BEM visível e RE-LANÇA
    // — falha o `afterAll` de propósito, pra aparecer no relatório da suíte
    // em vez de sumir sem rastro.
    // eslint-disable-next-line no-console
    console.error(
      '[config-persistence] FALHA AO RESTAURAR o config real da máquina — projectRoots/notificationPreference/' +
        `launcherDefaults/favorito de ${PROJECT_NAME} podem ter ficado com valores de teste. ` +
        // `donel-dev` aqui é o nome do APP (userData), não da pasta do repo — constante em qualquer worktree.
        'Verifique %APPDATA%\\donel-dev\\config.json manualmente.',
      error,
    );
    throw error;
  } finally {
    await electronApp.close();
  }
});

test('preferências (roots, notificação, launcher defaults, favoritos) sobrevivem a fechar e reabrir o app', async () => {
  test.setTimeout(90_000);

  const targetPreference = original.notificationPreference === 'all' ? 'none' : 'all';

  // 1. Roots + notificação — pela UI de Preferências de verdade.
  let dialog = await openPreferences(appWindow);

  await dialog.getByLabel('Nova pasta-raiz').fill(TEST_ROOT);
  await dialog.getByRole('button', { name: 'Adicionar' }).click();
  await expect(dialog.getByText(TEST_ROOT)).toBeVisible();

  const notificationWrap = dialog.getByTestId('notification-preference-select');
  await notificationWrap.getByRole('button', { name: NOTIFICATION_LABELS[original.notificationPreference] }).click();
  await appWindow.getByRole('option', { name: NOTIFICATION_LABELS[targetPreference] }).click();
  await expect(notificationWrap.getByRole('button', { name: NOTIFICATION_LABELS[targetPreference] })).toBeVisible();

  await appWindow.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // 2. launcherDefaults + favorito — via API direta (evaluate), sem spawnar
  // sessão real (custaria cota — não necessário pra provar persistência do campo).
  await appWindow.evaluate((defaults) => window.donel.config.setLauncherDefaults(defaults as never), NEW_LAUNCHER_DEFAULTS);
  if (donelDevPath) await appWindow.evaluate((p) => window.donel.projects.setFavorite(p, true), donelDevPath);

  // 3. Confirma no ARQUIVO real antes do restart (roteiro batch 5, passo 1:
  // "confirmar também que %APPDATA%\DonelDev\config.json existe e reflete os valores").
  const configPath = path.join(String(process.env.APPDATA), 'donel-dev', 'config.json');
  await expect(async () => {
    expect(existsSync(configPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(onDisk.projectRoots).toContain(TEST_ROOT);
    expect(onDisk.notificationPreference).toBe(targetPreference);
    expect(onDisk.launcherDefaults).toEqual(NEW_LAUNCHER_DEFAULTS);
  }).toPass({ timeout: 5_000 });

  // 4. Restart COMPLETO — fecha o processo inteiro e relança do zero.
  await electronApp.close();
  electronApp = await electron.launch({ args: [APP_MAIN], cwd: REPO_ROOT });
  appWindow = await electronApp.firstWindow();
  await appWindow.waitForLoadState('domcontentloaded');

  // 5. Verifica tudo persistiu — via API (config.json real, sem cache de processo).
  const afterRestart = await readConfig(appWindow);
  expect(afterRestart.projectRoots).toContain(TEST_ROOT);
  expect(afterRestart.notificationPreference).toBe(targetPreference);
  expect(afterRestart.launcherDefaults).toEqual(NEW_LAUNCHER_DEFAULTS);

  const projectsAfter = await appWindow.evaluate(() => window.donel.projects.list());
  expect(projectsAfter.find((project) => project.name === PROJECT_NAME)?.favorite).toBe(true);

  // 6. UI também reflete (reabre Preferências na instância NOVA do app).
  dialog = await openPreferences(appWindow);
  await expect(dialog.getByText(TEST_ROOT)).toBeVisible();
  await expect(
    dialog.getByTestId('notification-preference-select').getByRole('button', { name: NOTIFICATION_LABELS[targetPreference] }),
  ).toBeVisible();

  // 7. Remoção de root também funciona pela UI (não só adição) — limpa o
  // root de teste antes do afterAll (que ainda restaura tudo como rede de segurança).
  await dialog.getByRole('button', { name: `Remover pasta ${TEST_ROOT}` }).click();
  await expect(dialog.getByText(TEST_ROOT)).toHaveCount(0);

  await appWindow.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
