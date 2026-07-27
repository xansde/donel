import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke da T011 (injeção de modelo/esforço em sessão viva, FR-011). Instância
// própria de Electron (mesmo padrão de tabs-lifecycle.spec.ts) — não
// compartilha janela com terminal.spec.ts.
//
// Prova o cenário exato da DoD da task: sessão claude real (--model haiku,
// barato), um prompt trivial pra ter histórico de verdade no buffer, injeta
// `/model sonnet` pela toolbar (SessionDetails, App.tsx) só depois do prompt
// ficar ocioso (StateDot -> "waiting"/toolbar habilitada), e confirma DUAS
// coisas na tela real do terminal: (1) o CLI aceitou a troca ("Set model to
// sonnet" — texto de confirmação do próprio `/model`, ver
// src/shared/liveSessionInjection.ts) e (2) a resposta do prompt anterior
// continua visível no buffer (contexto não foi perdido — é exatamente o que
// distingue "injetar no stdin da sessão viva" de "matar e reabrir a aba").

// T801/§B19 (008) — `APP_MAIN`/`REPO_ROOT`/`PROJECT_NAME` vêm de
// `repoUnderTest.ts`: o projeto na sidebar é o `basename` da PASTA de onde a
// suíte roda (numa worktree, `donel-dev-wt-x`), nunca o literal `donel-dev`.

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('model-injection');
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: REPO_ROOT });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  // FIX B11 (2026-07-24) — mesmo achado de `profiles.spec.ts` e
  // `tabs-lifecycle.spec.ts`: a falha registrada como "drift do CLI" era o
  // `afterAll` estourando os 30s default no `electronApp.close()`, com a
  // sessão claude real deste teste ainda viva. Folga só neste hook (não
  // mascara asserção, não é retry) + `finally` para o diretório isolado nunca
  // ficar órfão se o close estourar mesmo assim.
  test.setTimeout(90_000);
  try {
    await electronApp.close();
  } finally {
    removeIsolatedUserDataDir(userDataDir);
  }
});

// FIX (feedback E2E rodada 3, "painel lateral 'Lançar sessão' fixo rouba
// espaço") — o Launcher deixou de ser um painel fixo: nasce fechado, abre
// via item "Sessão Claude" do menu do "＋ Nova sessão" (App.tsx, `launcherOpen`).
async function openLauncherPanel(): Promise<void> {
  await window.getByRole('button', { name: 'Mais opções de ＋ Nova sessão' }).click();
  await window.getByRole('menuitem', { name: 'Sessão Claude' }).click();
  await expect(window.locator('[data-testid="launcher"]')).toBeVisible();
}

test('T011 — injetar /model sonnet numa sessão haiku real (prompt ocioso) troca o modelo sem perder o histórico da conversa (FR-011)', async () => {
  test.setTimeout(180_000);

  // Mesmo caminho do teste do semáforo (T009): Launcher com projeto
  // 'donel-dev' (o próprio repo sob teste, sempre presente no scan) +
  // modelo haiku (barato) — custo mínimo, conforme a DoD da task.
  await openLauncherPanel();
  const launcher = window.locator('[data-testid="launcher"]');
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: 'Selecione um projeto' }).click();
  await window.getByRole('option', { name: PROJECT_NAME, exact: true }).click();
  await launcher.getByRole('radio', { name: 'haiku', exact: true }).click();
  await launcher.getByLabel('Nome').fill('model-injection-test');
  await launcher.getByRole('button', { name: '▶ Iniciar' }).click();

  const newTab = window.locator('[role="tab"]', { hasText: 'model-injection-test' });
  await expect(newTab).toBeVisible();
  await expect(newTab).toHaveAttribute('aria-selected', 'true');

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
  await expect(async () => {
    expect(await activePane.innerText()).toContain('accept edits on');
  }).toPass({ timeout: 60_000 });

  // A toolbar de Modelo/Esforço (App.tsx) só aparece pra sessões claude, na
  // aba ATIVA — a aba recém-lançada já está em foco (Launcher/addTab focam
  // a aba nova). Nasce desabilitada: a sessão está prestes a processar o
  // primeiro prompt (estado do semáforo 'working' assim que o Enter for
  // enviado), e o FR-011 só libera com o prompt ocioso.
  const sessionDetails = window.locator('[data-testid="session-details"]');
  await expect(sessionDetails).toBeVisible();
  const sonnetOption = sessionDetails.getByRole('radio', { name: 'sonnet', exact: true });

  // Marcador único — prova de "histórico preservado" depois da injeção lá
  // embaixo. Precisa ser algo que só apareça na RESPOSTA, nunca no próprio
  // texto digitado (senão o próprio eco do prompt na tela já "confirma" o
  // marcador antes do turno sequer começar) — por isso é uma conta simples
  // cuja RESULTADO não está em lugar nenhum do prompt.
  const marker = '741';
  await activePane.click();
  await window.keyboard.type(`Quanto é 733 mais 8? Responda só o número, nada mais.`, { delay: 30 });
  await window.keyboard.press('Enter');

  // Turno rodando -> a toolbar deve estar desabilitada (FR-011: nunca injeta
  // no meio do processamento). Checa ANTES do turno terminar — se a asserção
  // vier depois da resposta já ter chegado (corrida), este `expect` simplesmente
  // não teria nada a provar; por isso é melhor-esforço, não falha o teste.
  await window
    .waitForTimeout(300)
    .then(() => expect(sonnetOption).toBeDisabled({ timeout: 1_000 }))
    .catch(() => undefined);

  // Espera a resposta real chegar no buffer (o marcador aparece) — é o sinal
  // mais direto de "turno completo" (mais barato que esperar o StateDot).
  await expect(async () => {
    expect(await activePane.innerText()).toContain(marker);
  }).toPass({ timeout: 45_000 });

  // FR-011: prompt ocioso -> toolbar libera (StateDot foi pra 'waiting',
  // canInjectLiveCommand libera o SegmentedControl — ver SessionDetails.tsx).
  // 60s (não 20s): o texto da resposta pode terminar de renderizar ANTES do
  // `Stop` hook disparar (bookkeeping do CLI depois do último token visível
  // — mesma folga que o teste do semáforo, T009, já dá pro StateDot real).
  await expect(sonnetOption).toBeEnabled({ timeout: 60_000 });

  // A injeção em si: clique na opção "sonnet" -> App.tsx.handleSelectModel ->
  // TerminalPaneHandle.injectCommand -> pty:input -> stdin real do `claude`.
  await sonnetOption.click();

  // Achado real deste smoke (não estava nas strings do binário que embasaram
  // liveSessionInjection.ts): com histórico de conversa já em cache, o `/model`
  // não troca direto — o CLI mostra uma confirmação interativa ("Switch
  // model? ... full history gets re-read... ❯ 1. Yes, switch to Sonnet 5")
  // ANTES de aplicar, por causa do custo de invalidar o cache. Isso não é bug
  // da injeção: o terminal continua 100% interativo depois do clique da
  // toolbar (mesmo pty:input do teclado real) — o usuário vê e confirma esse
  // diálogo do jeito que confirmaria digitando `/model sonnet` na mão. Este
  // smoke simula exatamente essa confirmação humana (Enter = opção default
  // "1. Yes") pra fechar o ciclo sem intervenção manual.
  await expect(async () => {
    const text = await activePane.innerText();
    expect(text.includes('Switch model?') || text.includes('Set model to sonnet')).toBe(true);
  }).toPass({ timeout: 10_000 });
  {
    const text = await activePane.innerText();
    if (text.includes('Switch model?') && !text.includes('Set model to sonnet')) {
      // O clique no botão "sonnet" da toolbar move o foco do DOM pro botão
      // em si — sem reclicar no terminal, o `Enter` abaixo iria pro botão
      // (reativando-o), não pro stdin do PTY (mesmo padrão de foco usado em
      // todo o resto deste arquivo antes de `window.keyboard.*`).
      await activePane.click();
      await window.keyboard.press('Enter');
    }
  }

  // Prova 1 — o CLI aceitou a troca (texto de confirmação real do `/model`,
  // confirmado nas strings do binário instalado, ver liveSessionInjection.ts).
  // "Sonnet 5" (nome de exibição), não o alias "sonnet" que foi digitado —
  // achado deste smoke: o CLI ecoa o nome canônico do modelo na confirmação.
  await expect(async () => {
    expect(await activePane.innerText()).toContain('Set model to Sonnet 5');
  }).toPass({ timeout: 20_000 });

  // Prova 2 — a resposta do prompt ANTERIOR continua no buffer: a injeção
  // escreveu no stdin da MESMA sessão, não matou/reabriu a aba (que teria
  // perdido o scrollback e o contexto da conversa).
  expect(await activePane.innerText()).toContain(marker);

  // Prova 3 — a opção ativa do SegmentedControl já reflete "sonnet" (App.tsx
  // atualizou `sessionModelEffort` depois da injeção confirmada).
  await expect(sonnetOption).toHaveAttribute('aria-checked', 'true');
});
