import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// T508 (005-terminal-copy-paste) — smoke roteirizado: prova que o decisor
// (`resolveTerminalKeyAction`, T501) está LIGADO no caminho real do
// `TerminalPane` (T506/T507), não só testado contra um descritor de tecla
// fabricado à mão (unit puro, tests/terminalKeymap.test.ts).
//
// Cobertura automatizada aqui: só a aba SHELL, CA-6 ("zero regressão no
// terminal livre") — `Ctrl+C` sem seleção mata um processo real em execução
// (`ping -t`), a MESMA prova que o Windows Terminal (a referência da spec)
// daria. Custo zero de cota (terminal livre, sem sessão `claude` — mesmo
// espírito de `empty-state.spec.ts`).
//
// DECISÃO REGISTRADA (tasks.md T508: "se [...] se mostrar caro demais,
// registrar aqui a decisão e cobrir só por E2E manual — não inflar o
// smoke"): a metade CLAUDE do DoD ("aba claude não emite `\x03`") NÃO tem
// prova automatizada equivalente neste arquivo. Provar isso de verdade
// exigiria OU consumir um turno real de API (uma execução longa que o
// Ctrl+C não pode matar — a própria dor original da spec.md) OU expor um
// hook só-de-teste no TerminalPane que este lote não pediu (fora de escopo,
// tasks.md "Não implemente nada fora do tasks.md"). Só confirmar que o
// processo `claude` PERMANECE VIVO após um Ctrl+C sem seleção não seria
// prova suficiente: um CLI ocioso no prompt tende a sobreviver a um `\x03`
// cru de qualquer jeito (SIGINT só interrompe algo em EXECUÇÃO) — esse
// teste passaria igual ANTES e DEPOIS da correção, um sinal falso-positivo
// pior que nenhum sinal. A prova real de CA-1/CA-2 para aba claude já
// existe em dois lugares: (1) exaustiva em `tests/terminalKeymap.test.ts`
// (T501, matriz completa da tabela, unit puro); (2) o passo (a),
// OBRIGATÓRIO, do roteiro E2E manual (T509/T510) — "Ctrl+C sem seleção
// DURANTE uma execução longa; a execução NÃO PODE morrer" — com um turno
// real do modelo, a única forma honesta de provar isso.

const APP_MAIN = path.join(__dirname, '../../out/main/index.js');
const APP_CWD = path.join(__dirname, '../..');

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('terminal-copy-paste');
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: APP_CWD });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp.close();
  removeIsolatedUserDataDir(userDataDir);
});

/**
 * Espera o texto RENDERIZADO do pane mudar entre leituras sucessivas
 * (~700ms de intervalo) — prova de que o processo está produzindo output
 * novo. NÃO usa contagem de linhas: o viewport do xterm tem altura FIXA
 * (linhas antigas rolam pra fora), então `innerText().split('\n').length`
 * fica constante mesmo com o processo vivo e produzindo — só o CONTEÚDO
 * muda.
 */
async function waitForChangingOutput(pane: Locator, timeoutMs: number): Promise<void> {
  let previous = await pane.innerText();
  await expect(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const current = await pane.innerText();
    const changed = current !== previous;
    previous = current;
    expect(changed).toBe(true);
  }).toPass({ timeout: timeoutMs });
}

/**
 * Espera o texto renderizado ESTABILIZAR (duas leituras sucessivas iguais,
 * ~700ms de intervalo) — prova de que o processo parou de produzir output.
 * `ping -t` nunca pausa sozinho (uma linha por segundo, indefinidamente, até
 * ser morto) — "parou de mudar" só pode significar que o processo morreu de
 * verdade, não uma pausa transitória.
 */
async function waitForStableOutput(pane: Locator, timeoutMs: number): Promise<void> {
  let previous = await pane.innerText();
  await expect(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const current = await pane.innerText();
    const stable = current === previous;
    previous = current;
    expect(stable).toBe(true);
  }).toPass({ timeout: timeoutMs });
}

test('aba shell: Ctrl+C sem seleção mata um processo real em execução (CA-6, zero regressão no terminal livre)', async () => {
  test.setTimeout(60_000);

  await window.getByRole('button', { name: 'Mais opções de ＋ Nova sessão' }).click();
  await window.getByRole('menuitem', { name: 'Terminal (shell livre)' }).click();

  const terminalPane = window.locator('[data-testid="terminal-pane"]');
  await expect(terminalPane).toBeVisible();

  await expect(async () => {
    const text = await terminalPane.innerText();
    expect(text.length).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });

  await terminalPane.click();
  await window.keyboard.type('ping -t 127.0.0.1', { delay: 20 });
  await window.keyboard.press('Enter');

  // Confirma que o `ping` está de fato rodando e produzindo output contínuo
  // ANTES de tentar matá-lo — senão o teste não prova nada.
  await waitForChangingOutput(terminalPane, 15_000);

  await window.keyboard.press('Control+C');

  // Diagnóstico prévio (node-pty direto, mesma stack): o SIGINT leva até
  // ~2,5 s pra de fato parar o `ping.exe` (algumas respostas já em voo
  // continuam chegando) — 10 s de folga generosa.
  await waitForStableOutput(terminalPane, 10_000);

  // Confirmação extra: fica estável por mais 2 s (não é uma pausa
  // coincidente entre dois pings de 1 s — se o processo sobrevivesse, uma
  // linha nova apareceria aqui).
  const stableText = await terminalPane.innerText();
  await window.waitForTimeout(2_000);
  expect(await terminalPane.innerText()).toBe(stableText);
});

// FIX (teste manual 27/07, "Ctrl+V cola duas vezes") — a nossa colagem
// (clipboard bridge → pty.input) convivia com o paste NATIVO do Chromium no
// textarea oculto do xterm (o keydown não recebia preventDefault), e o texto
// entrava em dobro. Este teste asserta ocorrência ÚNICA — `toContain` não
// pega dobra ("XX" contém "X"); contagem pega.
test('aba shell: Ctrl+V cola o texto do clipboard UMA única vez', async () => {
  test.setTimeout(60_000);

  await window.getByRole('button', { name: 'Mais opções de ＋ Nova sessão' }).click();
  await window.getByRole('menuitem', { name: 'Terminal (shell livre)' }).click();

  const panes = window.locator('[data-testid="terminal-pane"]');
  const terminalPane = panes.last();
  await expect(terminalPane).toBeVisible();

  await expect(async () => {
    const text = await terminalPane.innerText();
    expect(text.length).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });

  // Marcador único desta execução, escrito no clipboard REAL do Electron
  // (processo main) — mesmo clipboard que o bridge lê.
  const marker = `PASTE-UMA-VEZ-${Date.now().toString(36)}`;
  await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), marker);

  await terminalPane.click();
  await window.keyboard.press('Control+V');

  // O marcador precisa aparecer (a colagem aconteceu)...
  await expect(async () => {
    expect(await terminalPane.innerText()).toContain(marker);
  }).toPass({ timeout: 10_000 });

  // ...e depois de estabilizar, EXATAMENTE uma vez (a dobra aparecia como
  // "markermarker" na mesma linha ou em linhas seguidas — qualquer segunda
  // ocorrência falha a contagem).
  await window.waitForTimeout(1_500);
  const text = await terminalPane.innerText();
  const occurrences = text.split(marker).length - 1;
  expect(occurrences).toBe(1);
});
