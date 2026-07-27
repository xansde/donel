import { appendFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT, SESSIONS_DIR } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke da Fase C da 006 (T611/T612) — o `%` de contexto consumido aparece na
// toolbar POR ABA, atualiza sozinho quando o transcript recebe um turno novo, e
// muda de estado acima de 100% da smart zone (CA-1, CA-5, CA-8, CA-9).
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
//
// FORA DESTE SMOKE, de propósito: CA-6 (trocar o modelo recalcula o `%`). Os
// controles da toolbar só habilitam com o semáforo em `waiting`, o que exige um
// turno real do modelo — a prova de CA-6 está no unit puro
// (`tests/contextWindow.test.ts`: os mesmos 134.602 tokens dão 45% em opus e 67%
// em haiku) e o passo com sessão viva fica no roteiro E2E humano (T614).

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

test('T611/T612 — o % de contexto aparece na toolbar da aba, atualiza com o turno novo e vira alerta acima de 100%', async () => {
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

  // 2. CA-4: sessão recém-nascida, sem nenhum turno → `—`, nunca `0%`.
  const indicator = appWindow.locator('[data-testid="session-context"]');
  await expect(indicator).toHaveText('contexto —');
  await expect(indicator).not.toHaveAttribute('data-over-zone', 'true');

  // O denominador depende do modelo ativo da aba: com `userData` isolado, o
  // default do Brief 3 é `fable` (janela 1M → zona de 300k). A asserção fica
  // explícita para o teste falhar com diagnóstico, e não com um número errado,
  // se esse default mudar.
  const modelGroup = appWindow.getByRole('radiogroup', { name: 'Modelo (sessão viva)' });
  const activeModel = (await modelGroup.locator('[role="radio"][aria-checked="true"]').innerText()).trim();
  expect(['fable', 'opus', 'sonnet'], `modelo ativo ${activeModel} tem zona diferente de 300k`).toContain(activeModel);

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

  // 4. Turno novo dentro da zona: 290 + 132.807 + 1.505 = 134.602 → 45% de 300k.
  appendFileSync(transcriptPath, usageLine(290, 132_807, 1_505), 'utf8');
  await expect(indicator).toHaveText('contexto 45%', { timeout: 5_000 });
  await expect(indicator).not.toHaveAttribute('data-over-zone', 'true');

  // CA-7: o tooltip mostra a zona usada como denominador E a janela real.
  const tooltip = await indicator.getAttribute('title');
  expect(tooltip).toContain('134.602 / 300.000 tokens da smart zone');
  expect(tooltip).toContain(`janela ${activeModel} 1.000.000`);

  // 5. CA-8/CA-9: turno que passa da smart zone → 127% (sem teto) e estado de
  //    alerta. 380.000 = 300.000 + 60.000 + 20.000.
  appendFileSync(transcriptPath, usageLine(300_000, 60_000, 20_000), 'utf8');
  await expect(indicator).toHaveText('contexto 127%', { timeout: 5_000 });
  await expect(indicator).toHaveAttribute('data-over-zone', 'true');

  // 6. C1: o número é o contexto AGORA, não acumulado — um turno menor (o que um
  //    `/compact` produz) faz o `%` CAIR e o alerta sair.
  appendFileSync(transcriptPath, usageLine(150, 20_000, 0), 'utf8');
  // Timeout maior que os anteriores por um motivo MEDIDO, não por superstição:
  // na primeira execução deste smoke este passo ficou 5 s inteiros exibindo o
  // valor anterior e passou com folga maior. Um append único seguido de silêncio
  // é o pior caso para `fs.watch` no Windows (evento coalescido/perdido não tem
  // nada depois para "consertá-lo"); numa sessão real o CLI escreve várias
  // linhas por turno, então o próximo evento chega em seguida. Registrado como
  // dívida nomeada em `specs/backlog.md` §B15.
  await expect(indicator).toHaveText('contexto 7%', { timeout: 20_000 });
  await expect(indicator).not.toHaveAttribute('data-over-zone', 'true');

  // 7. Fecha a aba (mata o PTY e o watcher) — não deixa sujeira para os outros.
  await tab.getByRole('button', { name: new RegExp(`^Fechar aba ${uiName}`) }).click();
  const closeModal = appWindow.getByRole('dialog', { name: 'Fechar sessão?' });
  if (await closeModal.isVisible().catch(() => false)) {
    await closeModal.getByRole('button', { name: 'Fechar sessão', exact: true }).click();
  }
  await expect(appWindow.locator('[role="tab"]')).toHaveCount(0);
});

test('aba de terminal livre (shell) não mostra indicador de contexto (CA-4/CA-5)', async () => {
  test.setTimeout(60_000);

  // A toolbar inteira só existe para abas `claude` — em shell não há nem
  // modelo/esforço nem contexto. É a prova de que o indicador é por-sessão.
  await appWindow.getByRole('button', { name: 'Mais opções de ＋ Nova sessão' }).click();
  await appWindow.getByRole('menuitem', { name: 'Terminal' }).click();

  await expect(appWindow.locator('[role="tab"]')).toHaveCount(1);
  await expect(appWindow.locator('[data-testid="session-details"]')).toHaveCount(0);
  await expect(appWindow.locator('[data-testid="session-context"]')).toHaveCount(0);
});
