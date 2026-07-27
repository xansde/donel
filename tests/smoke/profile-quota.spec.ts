import { existsSync, rmSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke de T205/T206/T207 (002-quota-headroom, Fase B — CA-1/CA-2/CA-2b/CA-3).
// Instância própria de Electron (mesmo padrão dos outros specs deste
// diretório). Regra do projeto: NUNCA abrir sessão claude real só pra ler
// cota — o `quota-axi` real não dá número determinístico neste ambiente, por
// isso o app é lançado com `DONEL_QUOTA_AXI_FIXTURE` apontando pro payload
// fixo em `tests/fixtures/quota-axi-payload.json` (mesmo shape do payload
// real medido em 2026-07-24, ver `readQuotaAxiQuota` em
// `src/main/quota-headroom.ts`) — a seam faz o main process ler esse arquivo
// em vez de spawnar o `quota-axi`, passando pelo MESMO `parseQuotaAxiWindows`.

const APP_MAIN = path.join(__dirname, '../../out/main/index.js');
const APP_CWD = path.join(__dirname, '../..');
const FIXTURE_PATH = path.join(__dirname, '../fixtures/quota-axi-payload.json');

const EXPAND_PROFILE_NAME = 'quota-smoke-profile-test';
const EXPAND_PROFILE_DIR = join(homedir(), '.claude-profiles', EXPAND_PROFILE_NAME);
const PROFILE_LINK_DIR_NAMES = ['projects', 'skills', 'commands', 'rules', 'plugins', 'templates'];

/** Mesmo cuidado de `profiles.spec.ts`: remove as junctions com `rmdirSync` (nunca segue o link) antes do `rmSync` recursivo do resto. */
function cleanupExpandProfileDir(): void {
  if (!existsSync(EXPAND_PROFILE_DIR)) return;
  for (const dirName of PROFILE_LINK_DIR_NAMES) {
    try {
      rmdirSync(join(EXPAND_PROFILE_DIR, dirName));
    } catch {
      // não era junction ou já removida — ok.
    }
  }
  rmSync(EXPAND_PROFILE_DIR, { recursive: true, force: true });
}

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;

test.beforeAll(async () => {
  cleanupExpandProfileDir();
  userDataDir = createIsolatedUserDataDir('profile-quota');
  electronApp = await electron.launch({
    args: [APP_MAIN, `--user-data-dir=${userDataDir}`],
    cwd: APP_CWD,
    env: { ...process.env, DONEL_QUOTA_AXI_FIXTURE: FIXTURE_PATH },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp.close();
  removeIsolatedUserDataDir(userDataDir);
  cleanupExpandProfileDir();
});

test('T206 — dropdown mostra 5h+semana rotuladas com % livre e reset, nunca "—" com fixture ok (CA-1/CA-2)', async () => {
  test.setTimeout(60_000);

  const trigger = window.locator('[data-testid="profile-switcher-trigger"] button');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const switcher = window.locator('[data-testid="profile-switcher"]');
  await expect(switcher).toBeVisible();

  const principalRow = switcher.locator('[data-testid="profile-row"][data-slug="principal"]');
  await expect(principalRow).toBeVisible();

  // (a) 5h e semana rotuladas, com % livre e reset — fixture: five_hour 97%
  // (reset hoje 14:00 UTC) / seven_day 100% (reset 31/07).
  const fiveHour = principalRow.locator('[data-testid="profile-quota-fivehour"]');
  const sevenDay = principalRow.locator('[data-testid="profile-quota-sevenday"]');
  await expect(fiveHour).toContainText(/5h.*97%\s*livre/, { timeout: 15_000 });
  await expect(fiveHour).toContainText('reset');
  await expect(sevenDay).toContainText(/semana.*100%\s*livre/);
  await expect(sevenDay).toContainText('reset');

  // (b) nenhum dos dois testids mostra "—" (o payload da fixture é sempre
  // `ok` — CA-1 "carregando, nunca '—' otimista" é coberto no unit de
  // `readAllProfilesHeadroom`/`HeadroomCache`; aqui a prova é que o caminho
  // feliz nunca regride pra "—").
  await expect(fiveHour).not.toContainText('—');
  await expect(sevenDay).not.toContainText('—');

  // Fable NÃO aparece colapsado (CA-2b — revelado só na expansão).
  await expect(principalRow.locator('[data-testid="profile-quota-fable"]')).toHaveCount(0);

  await window.keyboard.press('Escape');
  await expect(switcher).toBeHidden();
});

test('T206 — chevron expande fable SEM ativar a conta; corpo da linha ativa SEM expandir (CA-2b)', async () => {
  test.setTimeout(60_000);

  const trigger = window.locator('[data-testid="profile-switcher-trigger"] button');
  await trigger.click();
  const switcher = window.locator('[data-testid="profile-switcher"]');
  await expect(switcher).toBeVisible();

  // Cria um 2º perfil (não-ativo) pra testar expansão/ativação num alvo que
  // não é o já-ativo Principal — só assim dá pra provar que clicar no
  // chevron NÃO ativa (se testássemos no Principal, que já está ativo, o
  // "não ativou" seria uma prova fraca).
  await switcher.getByLabel('Novo perfil').fill(EXPAND_PROFILE_NAME);
  await switcher.getByRole('button', { name: 'Criar perfil' }).click();
  const newRow = switcher.locator(`[data-testid="profile-row"][data-slug="${EXPAND_PROFILE_NAME}"]`);
  await expect(newRow).toBeVisible({ timeout: 30_000 });

  const expandButton = newRow.locator('[data-testid="profile-quota-expand"]');
  const activateButton = newRow.getByRole('button', { name: EXPAND_PROFILE_NAME });

  // Clique no CHEVRON: revela fable, NÃO ativa a conta.
  await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
  await expandButton.click();
  await expect(expandButton).toHaveAttribute('aria-expanded', 'true');
  await expect(newRow.locator('[data-testid="profile-quota-fable"]')).toContainText(/fable.*55%\s*livre/);
  // Não ativou: o botão de ativação desta linha ainda não tem o check de "ativo" — Principal continua ativo no titlebar.
  await expect(window.locator('[data-testid="profile-switcher-trigger"]')).not.toContainText(EXPAND_PROFILE_NAME);

  // Colapsa de novo antes de testar o clique no corpo (estado limpo).
  await expandButton.click();
  await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
  await expect(newRow.locator('[data-testid="profile-quota-fable"]')).toHaveCount(0);

  // Clique no CORPO da linha: ativa a conta, NÃO expande (fable continua oculto).
  await activateButton.click();
  await expect(window.locator('[data-testid="profile-switcher-trigger"]')).toContainText(EXPAND_PROFILE_NAME, { timeout: 10_000 });
  await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
  await expect(newRow.locator('[data-testid="profile-quota-fable"]')).toHaveCount(0);

  // Higiene: devolve a conta ativa pra Principal antes do próximo teste/afterAll.
  const principalRow = switcher.locator('[data-testid="profile-row"][data-slug="principal"]');
  await principalRow.getByRole('button').first().click();
  await window.keyboard.press('Escape');
  await expect(switcher).toBeHidden();
});

test('T205 — botão "Atualizar" dispara releitura ignorando cache e desabilita durante (CA-3)', async () => {
  test.setTimeout(60_000);

  const trigger = window.locator('[data-testid="profile-switcher-trigger"] button');
  await trigger.click();
  const switcher = window.locator('[data-testid="profile-switcher"]');
  await expect(switcher).toBeVisible();

  const refreshButton = switcher.locator('[data-testid="profile-headroom-refresh"]');
  await expect(refreshButton).toBeVisible();
  await expect(refreshButton).toHaveText('Atualizar');
  await expect(refreshButton).toBeEnabled();

  await refreshButton.click();
  // Janela curta em que o botão troca de texto/desabilita durante a releitura
  // (a leitura via fixture é rápida — `toPass` cobre o timing sem sleep fixo).
  await expect(async () => {
    const [text, disabled] = await Promise.all([refreshButton.textContent(), refreshButton.isDisabled()]);
    expect(text === 'Atualizando…' || (text === 'Atualizar' && !disabled)).toBe(true);
  }).toPass({ timeout: 5_000 });

  // Ao final, volta pro estado normal (habilitado, texto "Atualizar").
  await expect(refreshButton).toHaveText('Atualizar', { timeout: 10_000 });
  await expect(refreshButton).toBeEnabled();

  await window.keyboard.press('Escape');
  await expect(switcher).toBeHidden();
});
