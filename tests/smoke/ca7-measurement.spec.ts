import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// T712 (007-favoritos-sessoes) — MEDIÇÃO OBRIGATÓRIA do CA-7: tempo do
// `domcontentloaded` até a sidebar pintada com o registro CHEIO (5 favoritos
// × 5 sessões recentes + 1 fixada cada = 30 linhas).
//
// DECISÃO DO ALEXANDRE, 2026-07-26: **desvio aceito**. O alvo original da spec
// era < 100 ms; a medição real deu 103–167 ms, e o diagnóstico mostrou que o
// custo é de BOOT PRÉ-EXISTENTE (bundle bloqueando o `domcontentloaded` +
// `config:get` e `projects:list` em dois `useEffect` sequenciais), não algo
// introduzido pela 007. Ele aceitou o número medido.
// Consequência para este teste: `CA7_TARGET_MS` deixa de ser ALVO e passa a ser
// CERCA DE REGRESSÃO — larga o suficiente (~1,5× o pior caso observado) para
// falhar só quando o boot piorar de verdade, e não por variação de carga da
// máquina. Se algum dia a otimização de boot entrar (§B20 do backlog), aperte
// esta cerca junto.
//
// Polling APERTADO (loop próprio abaixo, checando a cada round-trip do
// `locator.count()`), nunca `expect().toPass` — lição da 004
// (`specs/004-nomear-sessoes/medicao-t403.md`): o backoff exponencial do
// `toPass` do Playwright reportou 852 ms para algo que levava ~350 ms; o
// número medido era do AMOSTRADOR, não do app.
//
// O número em si é calculado inteiramente do lado do BROWSER
// (`performance.now()` − `domContentLoadedEventEnd`, os dois lidos na MESMA
// chamada de `evaluate`), pra não misturar o relógio do processo Node/
// Playwright com o do processo renderer — a única latência de fora que entra
// no número é o round-trip do `evaluate` final, inevitável em qualquer medição
// feita de fora do processo medido.

const APP_MAIN = path.join(__dirname, '../../out/main/index.js');
const APP_CWD = path.join(__dirname, '../..');
const RECENT_PER_PROJECT = 5;
const FAVORITES_COUNT = 5;
/** Cerca de regressão, não alvo (ver decisão de 26/07 no topo). Pior caso medido: 167 ms. */
const CA7_REGRESSION_FENCE_MS = 250;

let electronApp: ElectronApplication;
let appWindow: Page;
let userDataDir: string;

async function launchApp(): Promise<void> {
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: APP_CWD });
  appWindow = await electronApp.firstWindow();
  await appWindow.waitForLoadState('domcontentloaded');
}

test.afterAll(async () => {
  test.setTimeout(90_000); // folga do B11 para o close com PTY vivo
  try {
    await electronApp?.close();
  } finally {
    if (userDataDir) removeIsolatedUserDataDir(userDataDir);
  }
});

test('T712/CA-7 — domcontentloaded → sidebar com o registro cheio (5×6 linhas), medido com polling apertado', async () => {
  test.setTimeout(60_000);

  // 1. Descobre projetos REAIS já escaneados nesta máquina — nunca inventar
  // paths que não existem no disco (o "missing" da sidebar é um estado real
  // do produto, não o que queremos medir aqui: CA-7 é sobre o caso comum).
  userDataDir = createIsolatedUserDataDir('ca7-discover');
  await launchApp();
  const projects = await appWindow.evaluate(() => window.donel.projects.list());
  expect(projects.length, 'precisa de ao menos 5 projetos reais nesta máquina pra medir com o registro cheio').toBeGreaterThanOrEqual(
    FAVORITES_COUNT,
  );
  const chosenProjects = projects.slice(0, FAVORITES_COUNT);
  await electronApp.close();
  removeIsolatedUserDataDir(userDataDir);

  // 2. Monta um config.json com os 5 favoritos + registro CHEIO, ESCRITO
  // DIRETO NO DISCO — a medição é do BOOT (D9/CA-7: ler bytes, nunca varrer
  // `.jsonl`), não de uma sequência de IPCs feita depois do app já de pé.
  userDataDir = createIsolatedUserDataDir('ca7-measurement');
  const sessionRegistry: Record<string, unknown> = {};
  for (const project of chosenProjects) {
    for (let i = 0; i < RECENT_PER_PROJECT; i += 1) {
      const sessionId = randomUUID();
      sessionRegistry[sessionId] = {
        sessionId,
        projectPath: project.path,
        label: `sessão ${i + 1} de ${project.name}`,
        lastActivityAt: Date.now() - i * 1_000,
        pinned: false,
      };
    }
    const pinnedId = randomUUID();
    sessionRegistry[pinnedId] = {
      sessionId: pinnedId,
      projectPath: project.path,
      label: `fixada de ${project.name}`,
      lastActivityAt: Date.now() - 999_000,
      pinned: true,
    };
  }

  const config = {
    version: 1,
    projectRoots: [],
    favorites: chosenProjects.map((project) => project.path),
    activeProfileSlug: 'principal',
    launcherDefaults: { model: 'fable', effort: 'high', permissionMode: 'acceptEdits' },
    notificationPreference: 'permission-only',
    sessionNames: {},
    theme: 'dark',
    sessionRegistry,
    collapsedFavorites: [], // todos EXPANDIDOS — "registro cheio" tem de estar visível de verdade
  };
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(join(userDataDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  // 3. Boot com o config já pronto no disco, e polling APERTADO até as 30
  // linhas (5 grupos × 6 sessões) estarem montadas. CRÍTICO: a contagem E o
  // cálculo do tempo decorrido acontecem na MESMA chamada de `evaluate` —
  // inteiramente dentro do processo renderer, sem round-trip do protocolo do
  // Playwright entre "detectei que pintou" e "medi quanto levou". Medir os
  // dois em passos separados reintroduziria exatamente o erro do amostrador
  // que a lição da 004 avisa (852 ms medidos por algo que levava ~350 ms).
  await launchApp();

  const rowsSelector = 'section[aria-label="Favoritos"] button[aria-pressed]';
  const expectedRows = FAVORITES_COUNT * (RECENT_PER_PROJECT + 1);
  const pollDeadlineMs = Date.now() + 10_000;
  let elapsedMs: number | null = null;
  let lastCount = 0;
  for (;;) {
    const result = await appWindow.evaluate(
      ({ selector, expectedRows }) => {
        const count = document.querySelectorAll(selector).length;
        if (count !== expectedRows) return { done: false, count };
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        return { done: true, count, elapsedMs: performance.now() - nav.domContentLoadedEventEnd };
      },
      { selector: rowsSelector, expectedRows },
    );
    lastCount = result.count;
    if (result.done) {
      elapsedMs = result.elapsedMs!;
      break;
    }
    if (Date.now() > pollDeadlineMs) {
      throw new Error(`timeout aguardando a sidebar pintar o registro cheio: ${lastCount}/${expectedRows} linhas montadas`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `CA-7 medido: ${elapsedMs!.toFixed(2)} ms (faixa aceita em 26/07: 103–167 ms · cerca de regressão: ${CA7_REGRESSION_FENCE_MS} ms) — ${expectedRows} linhas`,
  );
  // Vermelho aqui significa **regressão de boot**, não o desvio já aceito: o
  // número sai de polling apertado numa única chamada de `evaluate` (sem o erro
  // de amostrador da 004), então não é ruído de medição. Diagnóstico e candidatos
  // de otimização: specs/007-favoritos-sessoes/medicao-ca7.md e §B20 do backlog.
  expect(elapsedMs).toBeLessThan(CA7_REGRESSION_FENCE_MS);
});
