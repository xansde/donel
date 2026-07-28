import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, REPO_ROOT } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// T322 (003-modo-dev, Batch B) — smoke completo da Fatia 1: condução e mapa.
//
// Isolado do `%APPDATA%` real (userData temp) e do BOARD real: a porta de
// entrada é alimentada por um arquivo de fixture
// (`DONEL_DEVMODE_BOARD_FIXTURE`, ver `taskdex-board-client.ts`) — nenhuma
// chamada de rede, nenhum token. O `.esteira/` é uma fixture em tmpdir,
// escrita por este arquivo; nada é lido do repo de verdade.
//
// UMA sessão `claude` real é aberta de propósito: o teste mais importante da
// feature é "o comando aparece ESCRITO no prompt e NÃO foi enviado", e isso
// só existe contra um PTY real. **Nenhum Enter é pressionado sobre o comando
// armado** — pressioná-lo dispararia uma skill de verdade (custo/quota), e o
// que a spec exige provar é justamente o contrário: que o app parou ali.

const CARD_DISCOVERY = 'SZI-900';
const CARD_M1 = 'SZI-901';
const CARD_M2 = 'SZI-902';
const CARD_LIVRE = 'SZI-999';
const CARD_FORA = 'SZI-500';

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;
let fixtureRepo: string;
let worktreeDir: string;
/** Mesmo caminho de `worktreeDir` com barras normais — é assim que o `ctx.md` declara (e é o que o app usa como `cwd`). */
let worktreeDeclared: string;
let boardFixturePath: string;

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function ctxPath(fase: string, cardId: string): string {
  return path.join(fixtureRepo, '.esteira', fase, `${cardId}-ctx.md`);
}

function resultPath(fase: string, cardId: string): string {
  return path.join(fixtureRepo, '.esteira', fase, 'handoffs', cardId, `${fase}-result.json`);
}

function manifest(cardId: string, fase: string, status: string, outputs: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      card_id: cardId,
      fase,
      status,
      started_at: '2026-07-27T10:00:00Z',
      finished_at: '2026-07-27T10:30:00Z',
      executor: 'claude',
      model: 'opus',
      effort: 'high',
      outputs,
      registrations: { vault: { path: null, section: null } },
    },
    null,
    2,
  );
}

/** PIDs vivos de `imageName` agora — mesmo helper de tabs-lifecycle/dev-mode (diferença de PID, nunca contagem absoluta). */
function listPids(imageName: string): Set<number> {
  let output: string;
  try {
    output = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /FO CSV /NH`, { encoding: 'utf8' });
  } catch {
    return new Set();
  }
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"')) continue;
    const cols = trimmed.split('","').map((col) => col.replace(/^"|"$/g, ''));
    const pid = Number(cols[1]);
    if (Number.isFinite(pid)) pids.add(pid);
  }
  return pids;
}

function newPids(before: Set<number>): number[] {
  return [...listPids('claude.exe')].filter((pid) => !before.has(pid));
}

test.beforeAll(async () => {
  fixtureRepo = mkdtempSync(path.join(os.tmpdir(), 'modo-dev-esteira-'));
  worktreeDir = mkdtempSync(path.join(os.tmpdir(), 'modo-dev-worktree-'));
  worktreeDeclared = worktreeDir.split(path.sep).join('/');

  // --- Fixture do `.esteira/` (o que a Esteira já grava em disco) ---------
  // Discovery concluído, com o fanout de 2 marcos (CA-14: o mapa card→marco
  // vem daqui, nunca do prefixo [Mx] do título do card).
  write(ctxPath('discovery', CARD_DISCOVERY), '---\ncard_id: SZI-900\n---\n\n# ctx\n');
  write(
    resultPath('discovery', CARD_DISCOVERY),
    manifest(CARD_DISCOVERY, 'discovery', 'success', {
      summary: 'discovery ok',
      fanout_cards: [
        { card_id: CARD_M1, marco_id: 'M1' },
        { card_id: CARD_M2, marco_id: 'M2' },
      ],
    }),
  );

  // M1: plano concluído (com artefatos declarados) e implementar TRAVADO
  // (ctx.md presente, sem manifesto, sem sessão viva) — é o estado que
  // dispara a sequência de dois comandos do CA-16.
  write(ctxPath('plano', CARD_M1), '---\ncard_id: SZI-901\n---\n\n# ctx do plano\n');
  write(
    resultPath('plano', CARD_M1),
    manifest(CARD_M1, 'plano', 'success', {
      summary: 'plano ok',
      artifact_paths: ['specs/003/spec.md', 'specs/003/plan.md'],
      e2e_path: 'specs/003/e2e.md',
    }),
  );
  // D3 — worktree/branch no frontmatter do ctx.md da fase implementar.
  write(
    ctxPath('implementar', CARD_M1),
    `---\ncard_id: ${CARD_M1}\nworktree_path: ${worktreeDeclared}\nbranch: feature/szi-901\n---\n\n# ctx\n`,
  );

  // --- Board mockado (arquivo, nunca rede) --------------------------------
  boardFixturePath = path.join(fixtureRepo, 'board-fixture.json');
  write(
    boardFixturePath,
    JSON.stringify([
      { cardId: CARD_DISCOVERY, column: 'discovery', title: 'Frente grande' },
      { cardId: CARD_M1, column: 'plano', title: 'Marco 1' },
      { cardId: CARD_M2, column: 'plano', title: 'Marco 2' },
      { cardId: CARD_LIVRE, column: 'backlog', title: 'Card sem discovery' },
      // CA-1 — coluna fora das 3 de entrada: NUNCA pode aparecer.
      { cardId: CARD_FORA, column: 'concluido', title: 'Card concluído' },
    ]),
  );

  // --- Config semeado no userData isolado ---------------------------------
  // Discovery já ABERTO (para o card de Plano ter um pai a focar) e uma etapa
  // ARQUIVADA em OUTRO perfil (CA-22). `phaseDefaults` com haiku/low prova que
  // a tabela do CA-4 é config editável, não constante de código.
  userDataDir = createIsolatedUserDataDir('dev-mode-conducao');
  const phaseEntry = (commandTemplate: string, opensOwnSession: boolean) => ({
    model: 'haiku',
    effort: 'low',
    commandTemplate,
    opensOwnSession,
  });
  write(
    path.join(userDataDir, 'config.json'),
    JSON.stringify({
      version: 1,
      projectRoots: [path.dirname(fixtureRepo)],
      favorites: [],
      activeProfileSlug: 'principal',
      launcherDefaults: { model: 'haiku', effort: 'low', permissionMode: 'acceptEdits' },
      notificationPreference: 'none',
      sessionNames: {},
      theme: 'dark',
      sessionRegistry: {},
      collapsedFavorites: [],
      devMode: {
        discoveries: {
          [CARD_DISCOVERY]: { cardId: CARD_DISCOVERY, repoPath: fixtureRepo, epicId: null, openedAt: 1, closedAt: null },
        },
        focusedDiscoveryId: null,
        archivedPhaseSessions: {
          [`${CARD_M1}:M1:plano`]: { sessionId: 'sess-antiga', profileSlug: 'outra-conta', archivedAt: 1 },
        },
        phaseDefaults: {
          discovery: phaseEntry('/esteira-discovery {card_id}', true),
          plano: phaseEntry('/esteira-plano {card_id}', true),
          implementar: phaseEntry('/esteira-implementar {card_id} ultracode', true),
          validar: phaseEntry('/esteira-validar {card_id}', true),
          concluir: phaseEntry('/esteira-concluir {card_id}', false),
        },
        boardConfig: { workspaceId: 'ws-smoke', teamId: 'team-smoke' },
      },
    }),
  );

  electronApp = await electron.launch({
    args: [APP_MAIN, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: { ...process.env, DONEL_DEVMODE_BOARD_FIXTURE: boardFixturePath },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
  if (userDataDir) removeIsolatedUserDataDir(userDataDir);
  // Limpeza best-effort: no Windows o `claude.exe` que rodou com `cwd` na
  // worktree pode ainda segurar o handle do diretório por alguns ms depois do
  // app fechar (EBUSY). Falhar a suíte por causa de um rmdir de fixture seria
  // um falso vermelho — o diretório é temp e o SO recolhe.
  for (const dir of [fixtureRepo, worktreeDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignorado de propósito — ver comentário acima
    }
  }
});

test('Modo Dev — Fatia 1 de ponta a ponta: entrada, condução sem Enter, mapa e arquivamento', async () => {
  test.setTimeout(240_000);
  const claudeBaseline = listPids('claude.exe');

  // === T310/CA-20 — liga o modo ==========================================
  await window.locator('[data-testid="devmode-toggle"] input[role="switch"]').check();
  await expect(window.locator('[data-testid="devmode-entry"]')).toBeVisible();
  // A tela de hoje foi OCULTADA, não desmontada.
  await expect(window.locator('[data-testid="today-sidebar"]')).toBeHidden();

  // === T311/CA-1 — só as 3 colunas de entrada aparecem ====================
  await expect(window.locator(`[data-testid="devmode-entry-card-${CARD_DISCOVERY}"]`)).toBeVisible();
  await expect(window.locator(`[data-testid="devmode-entry-card-${CARD_M1}"]`)).toBeVisible();
  await expect(window.locator(`[data-testid="devmode-entry-card-${CARD_LIVRE}"]`)).toBeVisible();
  await expect(window.locator(`[data-testid="devmode-entry-card-${CARD_FORA}"]`)).toHaveCount(0);

  // === T311/CA-2 — card vinculado aparece MARCADO =========================
  await expect(window.locator(`[data-testid="devmode-entry-linked-${CARD_DISCOVERY}"]`)).toBeVisible();
  await expect(window.locator(`[data-testid="devmode-entry-linked-${CARD_M1}"]`)).toBeVisible();
  await expect(window.locator(`[data-testid="devmode-entry-linked-${CARD_LIVRE}"]`)).toHaveCount(0);

  // === T311/CA-2 — card de PLANO abre o discovery PAI, não um novo ========
  await window.locator(`[data-testid="devmode-entry-card-${CARD_M2}"] button`).click();
  const toast = window.locator('[role="status"]');
  await expect(toast).toContainText(`Discovery ${CARD_DISCOVERY} em foco`);
  // D4 — Toast informativo: nenhuma ação de desfazer.
  await expect(toast.locator('button')).toHaveCount(0);
  // Nenhum discovery novo nasceu: o card de Plano continua marcado como
  // vinculado ao PAI (se tivesse criado um discovery próprio, o mapa abriria
  // com o card do marco no topo).
  await expect(window.locator('[data-testid="devmode-map"]')).toBeVisible();

  // === T316/CA-7 — a árvore inteira: 2 marcos × 5 nós =====================
  await expect(window.locator('[data-testid="devmode-map-marco-M1"]')).toBeVisible();
  await expect(window.locator('[data-testid="devmode-map-marco-M2"]')).toBeVisible();
  await expect(window.locator('[data-testid="devmode-map-marco-M1"] button')).toHaveCount(5);
  // Marco em foco tem marcação distinta.
  await expect(window.locator('[data-testid="devmode-map-marco-M1"]')).toHaveAttribute('data-focused', 'true');
  await expect(window.locator('[data-testid="devmode-map-marco-M2"]')).toHaveAttribute('data-focused', 'false');
  // Legenda dos DOIS eixos (fase × sessão) no rodapé — item verificável.
  const legend = window.locator('[data-testid="devmode-map-legend"]');
  await expect(legend).toContainText('Fase');
  await expect(legend).toContainText('Sessão');
  await expect(legend).toContainText('Travada');
  await expect(legend).toContainText('Aguardando resposta');

  // === T319/CA-15 — os 5 estados chegam certos na peça certa ==============
  await expect(window.locator('[data-testid="devmode-phase-button-plano"]')).toHaveAttribute('data-status', 'done');
  await expect(window.locator('[data-testid="devmode-phase-button-implementar"]')).toHaveAttribute('data-status', 'stuck');
  await expect(window.locator('[data-testid="devmode-phase-button-validar"]')).toHaveAttribute('data-status', 'not-started');

  // === T314/CA-5 — botão sempre clicável, slot de trava VAZIO na Fatia 1 ==
  await expect(window.locator('[data-testid="devmode-phase-button-implementar"]')).toBeEnabled();
  await expect(window.locator('[data-testid="devmode-phase-slot-implementar"]')).toHaveText('');

  // === T320/CA-22 — etapa arquivada em outra conta avisa, sem bloquear ====
  await expect(window.locator('[data-testid="devmode-phase-profile-warning-plano"]')).toContainText('outra-conta');
  await expect(window.locator('[data-testid="devmode-phase-button-plano"]')).toBeEnabled();

  // === T313/C6 — `concluir` sem aba em foco: avisa e NÃO cria sessão ======
  await window.locator('[data-testid="devmode-phase-button-concluir"]').click();
  await expect(toast).toContainText('Sem sessão Claude em foco');
  expect(newPids(claudeBaseline)).toHaveLength(0);

  // === T317/CA-8,CA-10,CA-18 + T318/CA-9 — nó expandido e retomada ========
  // Clicar no nó `plano` (concluído, COM session-id arquivado) expande o nó E
  // retoma a sessão daquela etapa — é o que o CA-9 pede literalmente.
  await window.locator('[data-testid="devmode-map-marco-M1"] button').nth(1).click();
  const artifacts = window.locator('[data-testid="devmode-node-artifact"]');
  await expect(artifacts).toHaveCount(5); // 2 artifact_paths + e2e_path + ctx.md + result.json
  await expect(window.locator('[data-testid="devmode-node-artifacts"]')).toContainText('specs/003/spec.md');
  await expect(window.locator('[data-testid="devmode-node-skill"]')).toHaveText('/esteira-plano');
  // CA-18 — sem recibo de vault: indicador discreto, nunca "incompleto"/erro.
  await expect(window.locator('[data-testid="devmode-node-no-receipt"]')).toBeVisible();
  // CA-9 — retomada pelo `-r <session-id>` arquivado (argv real, hook de teste).
  await expect(window.locator('[data-testid="devmode-last-session"]')).toHaveText('claude -r sess-antiga');
  // CA-22 — a etapa rodou em outra conta: avisa, e retoma assim mesmo.
  await expect(toast).toContainText('outra-conta');
  await expect(window.locator('[data-testid="devmode-node-profile-warning"]')).toContainText('outra-conta');
  // A sessão retomada de verdade subiu (1 processo novo) — só depois disso a
  // contagem do próximo passo é determinística.
  await expect(async () => {
    expect(newPids(claudeBaseline)).toHaveLength(1);
  }).toPass({ timeout: 60_000 });

  // === T312/CA-3 — O GESTO CENTRAL: escreve e PARA ========================
  // `implementar` está TRAVADA: a sequência do CA-16 tem dois passos, e só o
  // primeiro pode sair agora (o segundo depende de um Enter humano que este
  // teste deliberadamente não dá).
  const beforeImplementar = listPids('claude.exe');
  await window.locator('[data-testid="devmode-phase-button-implementar"]').click();

  // T312 — argv da tabela do CA-4 (editada no config: haiku/low) e `cwd` na
  // WORKTREE declarada no ctx.md (D3), não no repo.
  await expect(window.locator('[data-testid="devmode-last-session"]')).toHaveText('claude --model haiku --effort low');
  await expect(window.locator('[data-testid="devmode-last-session"]')).toHaveAttribute('data-cwd', worktreeDeclared);

  const activePane = window.locator('[data-testid="terminal-pane"]:visible');
  await expect(activePane).toHaveCount(1);
  // Diálogo de confiança de pasta (tmpdir nunca é confiada): responde como
  // humano. É o ÚNICO Enter deste teste — e ele nunca cai sobre o comando
  // armado, que só é escrito depois disto.
  await expect(async () => {
    const text = await activePane.innerText();
    if (text.includes('trust this folder') || text.includes('Do you trust')) {
      await activePane.click();
      await window.keyboard.press('Enter');
    }
    expect(text.toLowerCase()).toContain('claude code');
  }).toPass({ timeout: 90_000 });

  const armed = window.locator('[data-testid="devmode-armed"]');
  await expect(armed).toContainText(`/esteira-liberar ${CARD_M1}`, { timeout: 60_000 });
  // CA-16 — NUNCA os dois comandos ao mesmo tempo.
  await expect(armed).not.toContainText('/esteira-implementar');

  // O texto está no PROMPT do CLI (escrito de verdade) e NÃO foi submetido:
  // nenhuma linha de output do CLI processando o comando.
  await expect(async () => {
    expect(await activePane.innerText()).toContain(`/esteira-liberar ${CARD_M1}`);
  }).toPass({ timeout: 30_000 });
  const paneText = await activePane.innerText();
  expect(paneText).not.toContain('Unknown slash command');
  expect(paneText).not.toContain('esteira-liberar: ');

  // Exatamente UMA sessão nova (o `concluir` de antes não criou nenhuma).
  await expect(async () => {
    expect(newPids(beforeImplementar)).toHaveLength(1);
  }).toPass({ timeout: 30_000 });

  // === T313/C6 — `concluir` COM aba em foco: pré-digita nela, sem PTY novo =
  const beforeConcluir = listPids('claude.exe');
  await window.locator('[data-testid="devmode-phase-button-concluir"]').click();
  await expect(armed).toContainText(`/esteira-concluir ${CARD_M1}`, { timeout: 60_000 });
  expect(newPids(beforeConcluir)).toHaveLength(0);

  // === T310/CA-20 — desligar preserva a tela de hoje E as abas ============
  const tabsBefore = await window.locator('[role="tab"]').count();
  const pidsBefore = listPids('claude.exe');
  await window.locator('[data-testid="devmode-toggle"] input[role="switch"]').uncheck();
  await expect(window.locator('[data-testid="today-sidebar"]')).toBeVisible();
  await expect(window.locator('[data-testid="devmode-entry"]')).toHaveCount(0);
  expect(await window.locator('[role="tab"]').count()).toBe(tabsBefore);
  expect([...listPids('claude.exe')].sort()).toEqual([...pidsBefore].sort()); // nenhum PTY recriado
  await window.locator('[data-testid="devmode-toggle"] input[role="switch"]').check();
  await expect(window.locator('[data-testid="devmode-map"]')).toBeVisible();

  // === T315/CA-6 — arquivamento pelo MANIFESTO ============================
  // Manifesto de FALHA não arquiva: a aba fica aberta (CA-6 literal).
  write(resultPath('implementar', CARD_M1), manifest(CARD_M1, 'implementar', 'failed', { summary: 'falhou' }));
  await window.waitForTimeout(2_000);
  expect(await window.locator('[role="tab"]').count()).toBe(tabsBefore);

  // Manifesto de SUCESSO fecha a aba daquela etapa.
  write(resultPath('implementar', CARD_M1), manifest(CARD_M1, 'implementar', 'success', { summary: 'ok' }));
  await expect(window.locator('[role="tab"]')).toHaveCount(tabsBefore - 1, { timeout: 30_000 });

  // === T321/CA-23 — encerramento automático ===============================
  for (const cardId of [CARD_M1, CARD_M2]) {
    write(ctxPath('concluir', cardId), `---\ncard_id: ${cardId}\n---\n\n# ctx\n`);
    write(resultPath('concluir', cardId), manifest(cardId, 'concluir', 'success', { summary: 'done' }));
  }
  // Força uma releitura do disco pelo mesmo caminho que o usuário usaria.
  await window.locator('[data-testid="devmode-toggle"] input[role="switch"]').uncheck();
  await window.locator('[data-testid="devmode-toggle"] input[role="switch"]').check();
  await expect(window.locator(`[data-testid="devmode-entry-linked-${CARD_DISCOVERY}"]`)).toHaveCount(0, { timeout: 30_000 });
  await expect(window.locator('[data-testid="devmode-map"]')).toHaveCount(0);
});
