import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke do fix pós-gate (feedback E2E rodada 4, item 5 — "input do nome do
// perfil perde o foco enquanto digita"). CAUSA RAIZ REAL (achada nesta
// task, ver comentário em ProfileSwitcher.tsx): não era refresh periódico
// de quota nem input recriado (hipótese da auditoria) — o `onClose` do
// Modal era uma arrow function inline, identidade NOVA a cada tecla
// digitada (cada tecla re-renderiza o ProfileSwitcher via `setNewProfileName`).
// O `useEffect(..., [open, onClose])` do foco-trap do Modal.tsx
// (design-system) via a dependência mudar e refazia `first.focus()` a cada
// tecla, roubando o foco pra primeira linha de perfil do dropdown. Fix:
// `onClose` estabilizado com `useCallback`.
//
// Instância própria de Electron (mesmo padrão dos outros smokes deste
// diretório). Não cria perfil de verdade (não clica "Criar perfil") — só
// prova continuidade de foco durante a digitação, fecha o modal com Escape
// e não deixa nenhum resíduo (sem junctions/diretório de perfil pra limpar).

const APP_MAIN = path.join(__dirname, '../../out/main/index.js');
const APP_CWD = path.join(__dirname, '../..');

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('profile-switcher-focus');
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: APP_CWD });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp.close();
  removeIsolatedUserDataDir(userDataDir);
});

test('campo "Novo perfil" mantém o foco durante toda a digitação e o valor final fica completo', async () => {
  test.setTimeout(60_000);

  const trigger = window.locator('[data-testid="profile-switcher-trigger"] button');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const switcher = window.locator('[data-testid="profile-switcher"]');
  await expect(switcher).toBeVisible();

  const input = switcher.getByLabel('Novo perfil');
  await input.click();
  await expect(async () => {
    expect(await input.evaluate((el) => document.activeElement === el)).toBe(true);
  }).toPass({ timeout: 2_000 });

  // Nome fictício longo (sem nome de pessoa/cliente real — LGPD) digitado
  // caractere a caractere: assere foco contínuo a CADA tecla, não só no
  // fim (o bug reaparecia a cada tecla, um `.fill()` ou checagem só no
  // final não teria pego).
  const longName = 'Perfil de Teste com Nome Bem Comprido Para Forcar Varios Re-renders';
  let typed = '';
  for (const char of longName) {
    await window.keyboard.type(char);
    typed += char;

    const stillFocused = await input.evaluate((el) => document.activeElement === el);
    expect(stillFocused, `perdeu o foco depois de digitar "${typed}"`).toBe(true);
  }

  await expect(input).toHaveValue(longName);

  // Fecha sem criar o perfil (Escape — Modal.tsx) — este smoke não deixa
  // nenhum perfil/junction residual pra limpar.
  await window.keyboard.press('Escape');
  await expect(switcher).toBeHidden();
});
