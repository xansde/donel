import { execSync } from 'node:child_process';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT } from '../smoke/repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from '../smoke/userDataIsolation';

// Smoke permanente de MODO DEV (receita do diagnóstico do bug StrictMode,
// 2026-07-23, ver feedback-e2e.md rodada 1 e specs/001-mvp/CLAUDE.md) —
// prova, contra o React DEV build de verdade (StrictMode double-invoca
// efeitos), que uma aba nova continua VIVA e DIGITÁVEL. Antes do fix
// (`disposedRef` booleano nunca resetado no 2º mount, TerminalPane.tsx), o
// PTY do primeiro mount morria e a aba ficava presa em "sessão sem processo
// vivo" — só reproduzível com o build de DESENVOLVIMENTO do React
// (`npm run dev`); os smokes em tests/smoke/ rodam contra o build de
// PRODUÇÃO (`out/renderer/`), que não double-invoca, por isso nunca
// pegaram. `main`/`preload` continuam sendo o build de produção normal —
// só o RENDERER precisa vir de um dev server pra StrictMode valer.

// T801/§B19 (008) — `APP_MAIN`/`REPO_ROOT`/`PROJECT_NAME` vêm de
// `repoUnderTest.ts`: o projeto na sidebar é o `basename` da PASTA de onde a
// suíte roda (numa worktree, `donel-dev-wt-x`), nunca o literal `donel-dev`.
const RENDERER_ROOT = path.join(__dirname, '../../src/renderer');

let viteServer: ViteDevServer;
let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;

/** PIDs vivos de `imageName` agora, via `tasklist` real — mesmo helper de tabs-lifecycle.spec.ts (diferença de PID, nunca contagem absoluta). */
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

/** Novos PIDs de `imageName` que apareceram depois de `before` — reavalia até achar exatamente `count` (`toPass`, tolera o polling de `tasklist`). Mesmo helper de tabs-lifecycle.spec.ts. */
async function waitForExactlyNewPids(imageName: string, before: Set<number>, count: number, timeoutMs = 20_000): Promise<number[]> {
  let added: number[] = [];
  await expect(async () => {
    const now = listPids(imageName);
    added = [...now].filter((pid) => !before.has(pid));
    expect(added.length).toBe(count);
  }).toPass({ timeout: timeoutMs });
  return added;
}

test.beforeAll(async () => {
  // Dev server de verdade do renderer (mesma root/plugin de
  // electron.vite.config.ts "renderer") — React resolve pro build de
  // DESENVOLVIMENTO aqui (StrictMode double-invoke ativo), diferente de
  // `npm run build` (produção, tests/smoke/).
  viteServer = await createServer({
    root: RENDERER_ROOT,
    plugins: [react()],
    logLevel: 'warn',
    server: { strictPort: false },
  });
  await viteServer.listen();
  const rendererUrl = viteServer.resolvedUrls?.local[0];
  if (!rendererUrl) throw new Error('Vite dev server não resolveu nenhuma URL local.');

  // FIX (auditoria rodada 5, achado media "playwright.config.ts") — mesmo
  // isolamento de `%APPDATA%` real dos smokes em tests/smoke/
  // (userDataIsolation.ts): sem isto, `launcherDefaults`/config real da
  // máquina do Alexandre vazava pra este smoke também.
  userDataDir = createIsolatedUserDataDir('dev-mode');
  electronApp = await electron.launch({
    args: [APP_MAIN, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
  await viteServer?.close();
  if (userDataDir) removeIsolatedUserDataDir(userDataDir);
});

test('modo dev (StrictMode ativo): aba nova via launcher fica viva e digitável', async () => {
  test.setTimeout(60_000);

  // Confirma que a janela realmente carregou do DEV SERVER (não do
  // `out/renderer/index.html` empacotado, produção — que os smokes em
  // tests/smoke/ já cobrem) — é essa troca de origem que faz o React
  // resolver pro build de DESENVOLVIMENTO (StrictMode double-invoke ativo).
  // Senão este smoke não estaria provando nada diferente dos outros.
  expect(window.url().startsWith('http://')).toBe(true);
  await expect(window.locator('script[src="/@vite/client"]')).toHaveCount(1);

  const claudeBaseline = listPids('claude.exe');

  // Painel do Launcher agora é colapsável (feedback E2E rodada 3) — abre
  // pela seta do "＋ Nova sessão" → "Sessão Claude".
  await window.getByRole('button', { name: 'Mais opções de ＋ Nova sessão' }).click();
  await window.getByRole('menuitem', { name: 'Sessão Claude' }).click();

  const launcher = window.locator('[data-testid="launcher"]');
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: 'Selecione um projeto' }).click();
  await window.getByRole('option', { name: PROJECT_NAME, exact: true }).click();
  await launcher.getByRole('radio', { name: 'haiku', exact: true }).click();
  await launcher.getByLabel('Nome').fill('dev-mode-smoke');
  await launcher.getByRole('button', { name: '▶ Iniciar' }).click();

  const newTab = window.locator('[role="tab"]', { hasText: 'dev-mode-smoke' });
  await expect(newTab).toBeVisible();
  await expect(newTab).toHaveAttribute('aria-selected', 'true');

  // Processo real por trás da aba — prova de "viva" além da UI: exatamente
  // 1 `claude.exe` novo (sem o double-spawn órfão do bug original, que
  // deixava um processo morto gerenciado + um vivo órfão, ou os dois
  // mortos).
  await waitForExactlyNewPids('claude.exe', claudeBaseline, 1, 30_000);

  const activePane = window.locator('[data-testid="terminal-pane"]:visible');
  await expect(activePane).toHaveCount(1);

  // "Viva": o terminal renderiza conteúdo real (não fica em branco preso em
  // "connecting" — sintoma exato do bug original) e nenhum dos overlays de
  // falha aparece.
  await expect(async () => {
    const text = await activePane.innerText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('CLAUDE_NOT_FOUND');
    expect(text).not.toContain('Falha ao iniciar');
  }).toPass({ timeout: 20_000 });
  await expect(window.locator('[data-testid="session-ended-overlay"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="claude-not-found-banner"]')).toHaveCount(0);

  await activePane.click();
  if ((await activePane.innerText()).includes('trust this folder')) {
    await window.keyboard.press('Enter');
  }
  await expect(async () => {
    const text = await activePane.innerText();
    expect(text.toLowerCase()).toContain('claude code');
  }).toPass({ timeout: 15_000 });

  // "Digitável": prova o round-trip teclado -> stdin do PTY -> CLI -> render
  // sem submeter turno nenhum (sem Enter, sem custo de API — a prova de
  // "digitável" é o eco local do CLI, não uma resposta do modelo).
  const marker = `dev-strictmode-${Date.now()}`;
  await window.keyboard.type(marker, { delay: 20 });
  await expect(async () => {
    expect(await activePane.innerText()).toContain(marker);
  }).toPass({ timeout: 10_000 });

  // Limpa o input sem submeter (Ctrl+U — comum em CLIs baseados em
  // readline/ink pra limpar a linha corrente).
  await window.keyboard.press('Control+U');

  expect(electronApp.windows().length).toBeGreaterThan(0);
});
