import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, REPO_ROOT } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// T323 (003-modo-dev, Batch B) — MEDIÇÃO OBRIGATÓRIA do C1 e do C2. Nenhum
// dos dois números é estimado: os dois saem daqui, e viram cerca de regressão
// em ~2× o pior caso MEDIDO (mesmo método de 006/007/008).
//
//  - **C2 — montagem do mapa** (`devMode:readTree`: ler os manifestos do disco
//    e montar marcos × fases): alvo `< 200 ms` para até 5 marcos. Polling
//    APERTADO dentro de UMA chamada de `evaluate` — nunca `expect().toPass`
//    (lição da 004: o backoff do `toPass` mediu 852 ms para algo de ~350 ms;
//    o número era do amostrador, não do app).
//  - **C1 — RAM**: delta entre "Uso geral" e "Modo Dev ligado" com um
//    discovery de ~3 marcos, via `app.getAppMetrics()` (working set REAL dos
//    processos do Electron, medido pelo SO — não `performance.memory` do
//    heap JS). Alvo `+50 MB`.
//
// Números medidos e o racional das cercas: `specs/003-modo-dev/medicao-mapa.md`
// e `specs/003-modo-dev/medicao-ram.md`.

/**
 * Cerca de regressão do C2 (chamadas com cache quente) — ~2× o pior caso
 * medido em 27/07 (23,2 ms em 9 execuções; ver `medicao-mapa.md`).
 */
const MAP_BUILD_FENCE_MS = 50;
/**
 * Cerca de regressão da 1ª chamada do C2 (cache de disco frio) — regra 6
 * (tasks.md T323, mesmo método de 006/007/008): cerca = ~2× o pior caso
 * MEDIDO, nunca o alvo literal da spec. Pior caso frio registrado em
 * `medicao-mapa.md` (27/07): 169,0 ms → 2× = 338 ms.
 * `medicao-mapa.md` já documentava esse desvio ("margem curta: 169 ms contra
 * um alvo de 200 ms") e escolheu deliberadamente o alvo da spec (200 ms) por
 * ser mais apertado que a cerca de 2× — mas 200 ms é apertado DEMAIS pra ser
 * cerca de regressão: rodando numa máquina EM USO (28/07) o cold bateu 492 ms
 * e 309 ms, sem nenhuma regressão de código — só carga da máquina. Uma cerca
 * de regressão tem que sobreviver a variância legítima de máquina; o alvo de
 * produto (< 200 ms) continua documentado em `medicao-mapa.md`, só não é
 * mais o que este smoke guarda.
 */
const COLD_CALL_FENCE_MS = 338;
/**
 * Cerca de regressão do C1. Aqui a regra "~2× o pior caso medido" (39,0 MB ×
 * 2 = 78 MB) daria uma cerca MAIOR que o alvo do produto (+50 MB do C1) —
 * uma cerca assim não protegeria nada. Vale a mais APERTADA das duas: o
 * próprio alvo da spec. Faixa medida em 27/07: 28,2–40,7 MB
 * (ver `medicao-ram.md`, inclusive a margem curta que isso deixa).
 */
const RAM_DELTA_FENCE_MB = 50;

const DISCOVERY_3 = 'MED-300';
const DISCOVERY_5 = 'MED-500';
const PHASES = ['discovery', 'plano', 'implementar', 'validar', 'concluir'] as const;

let electronApp: ElectronApplication;
let appWindow: Page;
let userDataDir: string;
let fixtureRepo: string;

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function manifest(cardId: string, fase: string, outputs: Record<string, unknown> = {}): string {
  return JSON.stringify({
    card_id: cardId,
    fase,
    status: 'success',
    started_at: '2026-07-27T10:00:00Z',
    finished_at: '2026-07-27T10:30:00Z',
    executor: 'claude',
    model: 'opus',
    effort: 'high',
    outputs,
    registrations: { vault: { path: null, section: null } },
  });
}

/** Discovery COMPLETO: N marcos × 5 fases, cada fase com `ctx.md` + `result.json` — o pior caso de leitura. */
function seedDiscovery(discoveryCardId: string, marcoCount: number): void {
  const fanout = Array.from({ length: marcoCount }, (_, index) => ({
    card_id: `${discoveryCardId}-M${index + 1}`,
    marco_id: `M${index + 1}`,
  }));
  write(path.join(fixtureRepo, '.esteira', 'discovery', `${discoveryCardId}-ctx.md`), '---\n---\n# ctx\n');
  write(
    path.join(fixtureRepo, '.esteira', 'discovery', 'handoffs', discoveryCardId, 'discovery-result.json'),
    manifest(discoveryCardId, 'discovery', { fanout_cards: fanout }),
  );

  for (const [index, entry] of fanout.entries()) {
    for (const fase of PHASES) {
      write(
        path.join(fixtureRepo, '.esteira', fase, `${entry.card_id}-ctx.md`),
        `---\ncard_id: ${entry.card_id}\nworktree_path: C:/wt/${entry.card_id}\nbranch: feature/${entry.card_id}\n---\n# ctx\n`,
      );
      // O `concluir` do ÚLTIMO marco fica sem manifesto de propósito: com
      // TODOS os marcos concluídos o discovery encerra sozinho (CA-23/T321,
      // comportamento correto) e o mapa sai da tela — não haveria o que medir.
      if (index === fanout.length - 1 && fase === 'concluir') continue;
      write(
        path.join(fixtureRepo, '.esteira', fase, 'handoffs', entry.card_id, `${fase}-result.json`),
        manifest(entry.card_id, fase, { artifact_paths: ['specs/x/spec.md', 'specs/x/plan.md'], documents: ['docs/processos/x.md'] }),
      );
    }
  }
}

test.beforeAll(async () => {
  fixtureRepo = mkdtempSync(path.join(os.tmpdir(), 'modo-dev-medicao-'));
  seedDiscovery(DISCOVERY_3, 3);
  seedDiscovery(DISCOVERY_5, 5);

  userDataDir = createIsolatedUserDataDir('dev-mode-medicao');
  const discovery = (cardId: string) => ({ cardId, repoPath: fixtureRepo, epicId: null, openedAt: 1, closedAt: null });
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
        discoveries: { [DISCOVERY_3]: discovery(DISCOVERY_3), [DISCOVERY_5]: discovery(DISCOVERY_5) },
        focusedDiscoveryId: DISCOVERY_3,
        archivedPhaseSessions: {},
        boardConfig: null,
      },
    }),
  );

  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: REPO_ROOT });
  appWindow = await electronApp.firstWindow();
  await appWindow.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  test.setTimeout(90_000);
  try {
    await electronApp?.close();
  } finally {
    if (userDataDir) removeIsolatedUserDataDir(userDataDir);
    try {
      rmSync(fixtureRepo, { recursive: true, force: true });
    } catch {
      // best-effort (ver dev-mode-conducao-mapa.spec.ts)
    }
  }
});

/** Working set REAL somado de todos os processos do Electron, em MB (medido pelo SO, via `app.getAppMetrics`). */
async function workingSetMb(): Promise<number> {
  const metrics = await electronApp.evaluate(({ app }) => app.getAppMetrics());
  const totalKb = metrics.reduce((sum, entry) => sum + (entry.memory?.workingSetSize ?? 0), 0);
  return totalKb / 1024;
}

/** Mediana de N amostras espaçadas — o working set oscila com GC; uma amostra só seria ruído, não medida. */
async function medianWorkingSetMb(samples: number): Promise<number> {
  const values: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    values.push(await workingSetMb());
    await appWindow.waitForTimeout(400);
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

test('C2 — montagem do mapa (5 marcos) fica abaixo da cerca de regressão', async () => {
  test.setTimeout(120_000);

  // O número é calculado inteiramente do lado do RENDERER, numa única chamada
  // de `evaluate`: nada do relógio do processo Node/Playwright entra nele.
  const result = await appWindow.evaluate(async (cardId) => {
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = performance.now();
      await window.donel.devMode.readTree(cardId);
      times.push(performance.now() - started);
    }
    const cold = times[0];
    const warm = times.slice(1).sort((a, b) => a - b);
    return { cold, min: warm[0], median: warm[Math.floor(warm.length / 2)], max: warm[warm.length - 1] };
  }, DISCOVERY_5);

  // eslint-disable-next-line no-console
  console.log(
    `C2 medido (5 marcos × 5 fases, 50 manifestos + 50 ctx.md): 1ª chamada ${result.cold.toFixed(2)} ms · ` +
      `min ${result.min.toFixed(2)} ms · mediana ${result.median.toFixed(2)} ms · máx ${result.max.toFixed(2)} ms ` +
      `(alvo da spec: 200 ms · cerca quente: ${MAP_BUILD_FENCE_MS} ms · cerca fria: ${COLD_CALL_FENCE_MS} ms)`,
  );

  expect(result.max).toBeLessThan(MAP_BUILD_FENCE_MS);
  // Cerca de regressão da 1ª chamada (cache frio) — ver `COLD_CALL_FENCE_MS`
  // acima e `specs/003-modo-dev/medicao-mapa.md` pro número medido (169 ms)
  // e o racional completo do porquê não é mais o alvo literal de 200 ms.
  expect(result.cold).toBeLessThan(COLD_CALL_FENCE_MS);
});

test('C1 — RAM: ligar o Modo Dev com um discovery de 3 marcos fica abaixo da cerca', async () => {
  test.setTimeout(120_000);

  // Baseline "Uso geral": app aberto, Modo Dev DESLIGADO, sem sessão nenhuma.
  await expect(appWindow.locator('[data-testid="devmode-toggle"]')).toBeVisible();
  const baselineMb = await medianWorkingSetMb(5);

  await appWindow.locator('[data-testid="devmode-toggle"] input[role="switch"]').check();
  await expect(appWindow.locator('[data-testid="devmode-map"]')).toBeVisible();
  await expect(appWindow.locator('[data-testid="devmode-map-marco-M3"]')).toBeVisible();
  const devModeMb = await medianWorkingSetMb(5);

  const deltaMb = devModeMb - baselineMb;
  // eslint-disable-next-line no-console
  console.log(
    `C1 medido: uso geral ${baselineMb.toFixed(1)} MB · Modo Dev (3 marcos) ${devModeMb.toFixed(1)} MB · ` +
      `delta ${deltaMb.toFixed(1)} MB (alvo da spec: +50 MB · cerca: ${RAM_DELTA_FENCE_MB} MB)`,
  );

  // Cerca == alvo do C1 (ver comentário de `RAM_DELTA_FENCE_MB`).
  expect(deltaMb).toBeLessThan(RAM_DELTA_FENCE_MB);
});
