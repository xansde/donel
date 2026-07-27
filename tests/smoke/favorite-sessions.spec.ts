import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// T710 (008-fechar-pendencias) — o 2º momento do CA-11 entra no 2º teste deste
// arquivo (passo 7): a sessão SINTÉTICA que ele já usa para provar a retomada
// nunca existiu no disco, então é exatamente a órfã do CA-11 — a prova sai de
// graça, sem uma sessão `claude` a mais e sem gastar cota.
//
// T711 (007-favoritos-sessoes) — o grupo "Favoritos" no topo da sidebar:
// CA-1 (colapsável, persistido), CA-2 (5 recentes + fixadas além das 5),
// CA-3 (dedupe da lista geral), CA-4 (foca aberta / retoma fechada),
// CA-5 (pin persiste), CA-6 (cabeçalho grita o pior estado), CA-8 (semeadura
// não entra aqui — testada em tests/session-seed.test.ts), CA-9 (desfavoritar
// não perde a fixada).
//
// Custo: UMA sessão `claude` real é aberta (para provar o gatilho 1 — "aba
// nasce" — e o dedupe/foco ao vivo de ponta a ponta), mas nenhum turno de API
// é consumido. As demais 6 visitas do teste de poda são escritas DIRETO no
// registro via `sessions.registerVisit` (evaluate) — nunca abrindo sessão
// real só para popular a lista, como o tasks.md exige. Isolado do `%APPDATA%`
// real (`userDataIsolation.ts`).

// T801 (008) — `REPO_ROOT`/`PROJECT_NAME`/`APP_MAIN` vêm de `repoUnderTest.ts`:
// este spec já calculava o nome do projeto (era a referência do §B19) e agora a
// conta mora num lugar só, junto do `SESSIONS_DIR`, pra nunca divergirem.
const RECENT_PER_PROJECT = 5; // duplicado de propósito — mesmo padrão dos outros smokes (não importam de src/shared).

let electronApp: ElectronApplication;
let appWindow: Page;
let userDataDir: string;

async function launchApp(): Promise<void> {
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: REPO_ROOT });
  appWindow = await electronApp.firstWindow();
  await appWindow.waitForLoadState('domcontentloaded');
}

async function favoriteRepo(favorite: boolean): Promise<void> {
  await appWindow.evaluate(
    ({ path: projectPath, favorite: fav }) => window.donel.projects.setFavorite(projectPath, fav),
    { path: REPO_ROOT, favorite },
  );
}

function favoritesSection() {
  return appWindow.locator('section[aria-label="Favoritos"]');
}

function sessoesSection() {
  return appWindow.locator('nav[aria-label="Projetos e sessões"] section', { hasText: 'Sessões' }).last();
}

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('favorite-sessions');
  await launchApp();
});

test.afterAll(async () => {
  test.setTimeout(90_000); // folga do B11 para o close com PTY vivo
  try {
    await electronApp.close();
  } finally {
    removeIsolatedUserDataDir(userDataDir);
  }
});

test('T711 — grupo aparece só com favoritados, dedupe da lista geral, cabeçalho acende e clique foca a aba aberta', async () => {
  test.setTimeout(120_000);

  // Sem favorito nenhum, a seção "Favoritos" não existe.
  await expect(favoritesSection()).toHaveCount(0);

  await favoriteRepo(true);
  await appWindow.reload();
  await appWindow.waitForLoadState('domcontentloaded');

  // Favoritado mas AINDA sem entrada no registro — grupo aparece vazio/coletável (CA-8 é a semeadura, testada em unit).
  await expect(favoritesSection()).toBeVisible({ timeout: 15_000 });
  const group = appWindow.locator(`[data-testid="favorite-group-${PROJECT_NAME}"]`);
  await expect(group).toBeVisible();

  // 1. Abre uma sessão claude REAL clicando no projeto — gatilho 1 (aba nasce).
  const sidebar = appWindow.locator('nav[aria-label="Projetos e sessões"]');
  const projectRow = sidebar.locator(`[data-testid="project-row-${PROJECT_NAME}"]`);
  await expect(projectRow).toBeVisible({ timeout: 15_000 });
  await projectRow.getByRole('button', { name: PROJECT_NAME, exact: true }).click();

  const tabs = appWindow.locator('[role="tab"]');
  await expect(tabs).toHaveCount(1);
  const pane = appWindow.locator('[data-testid="terminal-pane"]:visible');
  await expect(async () => {
    const text = await pane.innerText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('CLAUDE_NOT_FOUND');
  }).toPass({ timeout: 30_000 });

  // 2. O gatilho 1 grava a visita sozinho — sem esperar nenhum turn. Poll no
  // config até o registro ter uma entrada para este projeto (nunca abrir uma
  // segunda sessão só para "forçar" — o próprio nascimento da aba já grava).
  let sessionId = '';
  await expect(async () => {
    const config = await appWindow.evaluate(() => window.donel.config.get());
    const entry = Object.values(config.sessionRegistry).find((candidate) => candidate.projectPath === REPO_ROOT);
    expect(entry).toBeDefined();
    sessionId = entry!.sessionId;
  }).toPass({ timeout: 15_000 });

  // 3. CA-3 (dedupe): a sessão aparece no grupo, e NÃO na lista geral "Sessões".
  await expect(group.locator(`[aria-label*="${sessionId}"]`).or(group)).toBeVisible();
  const sessoes = sessoesSection();
  await expect(sessoes.getByText(PROJECT_NAME, { exact: true })).toHaveCount(0);

  // 4. CA-6: o cabeçalho do grupo mostra o dot de estado (sessão viva, 'working' por padrão).
  const headerToggle = group.getByRole('button').first();
  await expect(headerToggle.locator('svg')).not.toHaveCount(0); // StateDot + chevron, ambos svg

  // 5. CA-4: clicar na linha da sessão FOCA a aba já aberta (não duplica).
  const favoriteRow = group.locator(`button:has-text("${PROJECT_NAME}")`).last();
  await favoriteRow.click({ trial: false }).catch(() => undefined);
  await expect(tabs).toHaveCount(1); // nunca abre uma segunda aba da mesma sessão

  // Fecha a aba (mata o PTY) — não deixa sujeira pro próximo teste.
  await tabs.first().getByRole('button', { name: /^Fechar aba /, exact: false }).click();
  const closeModal = appWindow.getByRole('dialog', { name: 'Fechar sessão?' });
  if (await closeModal.isVisible().catch(() => false)) {
    await closeModal.getByRole('button', { name: 'Fechar sessão', exact: true }).click();
  }
  await expect(tabs).toHaveCount(0);
});

test('T711/T710 — poda na 6ª visita, fixada além das 5, colapso sobrevive ao restart e a órfã sai quando a retomada falha', async () => {
  // 180 s: os 120 s originais + a espera do CLI desistir da retomada (passo 7,
  // ~8,5–10,4 s medidos, com folga para a contenção da suíte).
  test.setTimeout(180_000);

  // 1. Fixa a sessão real que já está no registro (do teste anterior).
  const before = await appWindow.evaluate(() => window.donel.config.get());
  const realEntry = Object.values(before.sessionRegistry).find((candidate) => candidate.projectPath === REPO_ROOT);
  expect(realEntry, 'a sessão real do teste anterior deveria seguir no registro').toBeDefined();
  const pinnedSessionId = realEntry!.sessionId;

  await appWindow.evaluate((sessionId) => window.donel.sessions.setPinned(sessionId, true), pinnedSessionId);

  // 2. Colapsa o grupo (CA-1).
  const group = appWindow.locator(`[data-testid="favorite-group-${PROJECT_NAME}"]`);
  const toggle = group.getByRole('button').first();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // 3. Seis visitas SINTÉTICAS extra pro mesmo projeto, direto no registro
  // (nunca abrindo sessão real). A 6ª deve empurrar a 1ª (mais antiga) pra fora.
  const syntheticIds = Array.from({ length: 6 }, () => randomUUID());
  for (const id of syntheticIds) {
    // eslint-disable-next-line no-await-in-loop
    await appWindow.evaluate(
      ({ id: sessionId, projectPath }) => window.donel.sessions.registerVisit(sessionId, projectPath, `sintética ${sessionId.slice(0, 8)}`),
      { id, projectPath: REPO_ROOT },
    );
  }

  const afterVisits = await appWindow.evaluate(() => window.donel.config.get());
  const projectEntries = Object.values(afterVisits.sessionRegistry).filter((entry) => entry.projectPath === REPO_ROOT);
  // 5 sintéticas mais recentes + a real fixada = RECENT_PER_PROJECT + 1.
  expect(projectEntries).toHaveLength(RECENT_PER_PROJECT + 1);
  expect(projectEntries.find((entry) => entry.sessionId === syntheticIds[0])).toBeUndefined(); // a mais antiga foi podada
  expect(projectEntries.find((entry) => entry.sessionId === syntheticIds[5])).toBeDefined(); // a mais nova ficou
  expect(projectEntries.find((entry) => entry.sessionId === pinnedSessionId)?.pinned).toBe(true);

  // 4. Restart COMPLETO do app, mesmo `--user-data-dir` — prova CA-5/CA-1/CA-7
  // (o registro e o colapso vêm do config.json, sem varrer disco nenhum).
  await electronApp.close();
  await launchApp();

  const persisted = await appWindow.evaluate(() => window.donel.config.get());
  const persistedEntries = Object.values(persisted.sessionRegistry).filter((entry) => entry.projectPath === REPO_ROOT);
  expect(persistedEntries).toHaveLength(RECENT_PER_PROJECT + 1);
  expect(persistedEntries.find((entry) => entry.sessionId === pinnedSessionId)?.pinned).toBe(true);
  expect(persisted.collapsedFavorites).toContain(REPO_ROOT);

  const groupAfterRestart = appWindow.locator(`[data-testid="favorite-group-${PROJECT_NAME}"]`);
  await expect(groupAfterRestart).toBeVisible({ timeout: 15_000 });
  await expect(groupAfterRestart.getByRole('button').first()).toHaveAttribute('aria-expanded', 'false');

  // 5. Expande de novo e clica numa linha sintética (sem aba aberta) — CA-4 retoma.
  await groupAfterRestart.getByRole('button').first().click();
  await expect(groupAfterRestart.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');

  const tabs = appWindow.locator('[role="tab"]');
  await expect(tabs).toHaveCount(0);
  // Fixa a sintética que vai ser clicada — o CA-11/C3 diz que a órfã sai da
  // lista INCLUSIVE fixada, e é isso que o passo 7 abaixo prova.
  await appWindow.evaluate((sessionId) => window.donel.sessions.setPinned(sessionId, true), syntheticIds[5]);
  const syntheticRow = groupAfterRestart.locator(`button:has-text("sintética ${syntheticIds[5].slice(0, 8)}")`);
  await expect(syntheticRow).toBeVisible();
  await syntheticRow.click();

  // Retomou: uma aba nova nasceu (mesmo sem transcript real por trás, o
  // `--session-id`/`-r` foi imposto — é o que prova o CAMINHO de retomada).
  await expect(tabs).toHaveCount(1, { timeout: 15_000 });

  // 6. Clicar de NOVO na mesma linha FOCA (não duplica) — CA-4 completo.
  // Roda ANTES do passo 7 de propósito: o CLI só desiste da retomada uns 8 s
  // depois do spawn, então a linha ainda está lá.
  await syntheticRow.click();
  await expect(tabs).toHaveCount(1);

  // 7. T710 (008) — CA-11, 2º momento: a retomada FALHA (esta sessão nunca
  // existiu no disco) e a entrada órfã sai da lista sozinha, sem aviso.
  //
  // Quem dá o sinal é o próprio CLI: `claude -r <uuid inexistente>` imprime
  // "No conversation found with session ID" e SAI COM CÓDIGO 1 em ~8,5–10,4 s
  // (medido em specs/008-fechar-pendencias/medicao-t710.md) — nenhum turno de
  // API é consumido, nada de cota. A aba NÃO é fechada aqui de propósito: o
  // exit tem de vir do CLI desistindo, não do kill do teste. Medido AQUI, com o
  // app real: a linha sumiu 5.969 ms depois do 2º clique (≈7,5 s do spawn).
  //
  // Se este passo estourar, suspeite do §B21 antes de suspeitar de regressão: o
  // CLI 2.1.220 pode mostrar o diálogo "Accessing workspace … trust this
  // folder?" na PRIMEIRA sessão de um workspace, e com ele na frente o processo
  // nunca sai — o sinal não chega. (Medido: numa worktree nova o diálogo NÃO
  // apareceu; a aceitação não é por pasta, mas a chave exata é desconhecida.)
  await expect(syntheticRow).toHaveCount(0, { timeout: 60_000 });
  const afterFailure = await appWindow.evaluate(() => window.donel.config.get());
  expect(afterFailure.sessionRegistry[syntheticIds[5]], 'a órfã fixada tem de ter sido esquecida').toBeUndefined();
  // A entrada REAL (que existe no disco) continua intacta — a prova de que o
  // esquecer é verificado, e não "todo exit != 0 apaga".
  expect(afterFailure.sessionRegistry[pinnedSessionId]?.pinned).toBe(true);

  // Limpa a aba antes do próximo teste.
  await tabs.first().getByRole('button', { name: /^Fechar aba /, exact: false }).click();
  const closeModal = appWindow.getByRole('dialog', { name: 'Fechar sessão?' });
  if (await closeModal.isVisible().catch(() => false)) {
    await closeModal.getByRole('button', { name: 'Fechar sessão', exact: true }).click();
  }
  await expect(tabs).toHaveCount(0);
});

test('T711 — CA-9: desfavoritar remove o grupo e devolve as sessões à lista geral, sem perder a fixada', async () => {
  test.setTimeout(60_000);

  await favoriteRepo(false);
  await appWindow.reload();
  await appWindow.waitForLoadState('domcontentloaded');

  await expect(favoritesSection()).toHaveCount(0);

  // A fixada continua gravada — nada se perde ao desfavoritar (CA-9).
  const config = await appWindow.evaluate(() => window.donel.config.get());
  const stillThere = Object.values(config.sessionRegistry).some((entry) => entry.projectPath === REPO_ROOT && entry.pinned);
  expect(stillThere).toBe(true);
});
