import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_MAIN, PROJECT_NAME, REPO_ROOT } from './repoUnderTest';
import { createIsolatedUserDataDir, removeIsolatedUserDataDir } from './userDataIsolation';

// Smoke da T014 (ProfileManager + headroom + UI de perfis — FR-005, FR-012,
// CA-3). Instância própria de Electron (mesmo padrão das outras specs deste
// diretório) — não compartilha janela com terminal.spec.ts/model-injection.spec.ts.
//
// Roteiro pedido pela task: criar um perfil de teste novo
// ("e2e-profile-test"), doctor verde, dropdown lista os perfis, ativar o
// perfil e spawnar uma aba claude que prova o isolamento por
// `CLAUDE_CONFIG_DIR` (spike seção 4/5: o CLI não faz fallback silencioso
// pra sessão global autenticada) SEM exigir login humano. Limpa o perfil e2e
// criado ao final (`afterAll`, roda mesmo se o teste falhar).
//
// CORREÇÃO em relação ao texto literal da task ("mostra 'Not logged in'"):
// esse texto é o comportamento do `claude -p` NÃO-interativo (o único modo
// que o spike T001 testou). O CommandBuilder desta app nunca usa `-p` —
// toda sessão spawnada pelo Donel Dev é interativa, e uma sessão interativa
// num perfil novo mostra o wizard de 1º uso (tema -> "Select login method"),
// nunca "Not logged in" sozinha — avançar além de "Select login method"
// dispararia um fluxo OAuth REAL (abrir browser), inaceitável num teste
// automatizado. Ver comentário no passo 6 abaixo pra evidência e decisão.
//
// Nomes dos 6 dirs linkados por junction — mesma lista de PROFILE_LINK_DIRS
// (src/main/profile-manager.ts); duplicada aqui de propósito, como as outras
// specs deste diretório fazem com constantes do main process (nunca
// importam src/main direto — só `window.donel.*`/o app rodando de verdade).
const PROFILE_LINK_DIR_NAMES = ['projects', 'skills', 'commands', 'rules', 'plugins', 'templates'];

const E2E_PROFILE_NAME = 'e2e-profile-test';
const E2E_PROFILE_DIR = join(homedir(), '.claude-profiles', E2E_PROFILE_NAME);

// T801/§B19 (008) — `APP_MAIN`/`REPO_ROOT`/`PROJECT_NAME` vêm de
// `repoUnderTest.ts`: o projeto na sidebar é o `basename` da PASTA de onde a
// suíte roda (numa worktree, `donel-dev-wt-x`), nunca o literal `donel-dev`.

/**
 * Remove o diretório do perfil e2e com segurança: as 6 junctions são
 * removidas via `rmdirSync` (remove SÓ o link, nunca o alvo — confirmado
 * empiricamente antes de escrever este smoke: `rmdirSync` num reparse point
 * do Windows não segue o link) ANTES do `rmSync` recursivo no resto —
 * defesa em profundidade pra nunca arriscar apagar `~/.claude/skills` etc.
 * de verdade. No-op silencioso se o diretório não existir.
 */
function cleanupE2eProfileDir(): void {
  if (!existsSync(E2E_PROFILE_DIR)) return;
  for (const dirName of PROFILE_LINK_DIR_NAMES) {
    const linkPath = join(E2E_PROFILE_DIR, dirName);
    try {
      rmdirSync(linkPath);
    } catch {
      // Não era uma junction (nunca chegou a ser criada) ou já foi removida — ok.
    }
  }
  rmSync(E2E_PROFILE_DIR, { recursive: true, force: true });
}

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;

test.beforeAll(async () => {
  // Defensivo: uma execução anterior que crashou antes do cleanup não deve
  // vazar pra esta (perfil já existente faria "Criar perfil" ser um no-op
  // silencioso sobre um estado velho, mascarando o que este smoke prova).
  cleanupE2eProfileDir();

  userDataDir = createIsolatedUserDataDir('profiles');
  electronApp = await electron.launch({ args: [APP_MAIN, `--user-data-dir=${userDataDir}`], cwd: REPO_ROOT });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  // FIX B11 (medido em 2026-07-24, não presumido): este arquivo falhava com
  // `"afterAll" hook timeout of 30000ms exceeded` — o CORPO do teste passava.
  // O backlog atribuía a falha a "drift do CLI v2.1.219" (a asserção de
  // "Let's get started"), o que foi REFUTADO por sonda direta: o CLI v2.1.219
  // ainda imprime exatamente essa string, com apóstrofo ASCII (U+0027), num
  // perfil fresco. A causa real é o teardown: `electronApp.close()` espera o
  // processo Electron morrer de verdade, incluindo o teardown do PTY da
  // sessão claude que este teste deixa VIVA no wizard de tema — sob carga
  // (várias sessões claude concorrentes, comum neste ambiente) isso passa dos
  // 30s default de hook. Mesmo achado e mesmo fix já aplicados em
  // `tabs-lifecycle.spec.ts` na rodada 6; este arquivo tinha ficado de fora.
  test.setTimeout(90_000);
  // `finally` para as duas limpezas: se o close estourar mesmo com a folga,
  // o diretório isolado e o perfil e2e não podem ficar órfãos (mesmo achado
  // da auditoria da rodada 6 sobre resíduo em %TEMP%).
  try {
    await electronApp.close();
  } finally {
    removeIsolatedUserDataDir(userDataDir);
    cleanupE2eProfileDir();
  }
});

test('T014 — criar perfil, doctor verde, listar no dropdown, ativar e spawnar sessão claude isolada (tela de login pedida, sem login humano — FR-005/FR-012/CA-3)', async () => {
  test.setTimeout(120_000);

  // 0. FIX (decisão A, 2026-07-23) — o app nasce com ZERO abas agora (empty
  // state, App.tsx `INITIAL_TABS`); a antiga aba "Sessão" default (nascida
  // sozinha no boot, sob o perfil Principal — nenhum perfil de teste ainda
  // ativado) deixou de existir. Este teste ainda precisa de UMA aba nascida
  // sob Principal ANTES de ativar o perfil e2e (é a prova do passo 4 mais
  // abaixo: trocar o perfil ATIVO global não muda o perfil de NASCIMENTO de
  // uma aba já aberta) — reproduz isso clicando no corpo do "＋ Nova sessão"
  // (handleQuickNewClaudeSession) já aqui no início, com Principal ainda
  // sendo o único perfil que existe.
  //
  // FIX (auditoria rodada 6 ciclo 2, achado media "CTA do titlebar reproduz
  // o bug do empty state em 1 clique") — sem `lastLaunch`/
  // `selectedProjectPath` (boot limpo, primeiro clique de toda a suíte), o
  // clique abre o Launcher (nesta altura, o único jeito de escolher um
  // projeto) — escolhe `donel-dev` (já confiável nesta máquina). Isso também
  // grava `lastLaunch` via `handleLaunch`.
  //
  // FIX (teste manual 27/07) — o corpo do "＋ Nova sessão" passou a abrir o
  // Launcher SEMPRE, não mais só na ausência de `lastLaunch`. O clique do
  // passo 5 mais abaixo (que antes reaproveitava o mesmo corpo pra spawnar
  // direto com `lastLaunch`) foi trocado pro item "Rápida (última config)"
  // do dropdown — esse sim continua indo direto, sem abrir o Launcher.
  await window.getByRole('button', { name: '＋ Nova sessão', exact: true }).click();
  const launcher = window.locator('[data-testid="launcher"]');
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: 'Selecione um projeto' }).click();
  await window.getByRole('option', { name: PROJECT_NAME, exact: true }).click();
  await launcher.getByRole('radio', { name: 'haiku', exact: true }).click();
  await launcher.getByRole('button', { name: '▶ Iniciar' }).click();

  const principalTab = window.locator('[role="tab"]').last();
  await expect(principalTab).toBeVisible();
  await expect(principalTab).toHaveAttribute('aria-selected', 'true');

  // 1. Abre o dropdown de perfis (badge no titlebar — ProfileSwitcher.tsx).
  const trigger = window.locator('[data-testid="profile-switcher-trigger"] button');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const switcher = window.locator('[data-testid="profile-switcher"]');
  await expect(switcher).toBeVisible();
  await expect(window.getByRole('dialog', { name: 'Perfis de conta' })).toBeVisible();

  // Principal sempre presente (FR-005 — "o perfil principal é o próprio ~/.claude").
  await expect(switcher.locator('[data-testid="profile-row"][data-slug="principal"]')).toBeVisible();

  // 2. Criar o perfil de teste (FR-005) — nome digitado no form embutido no dropdown.
  await switcher.getByLabel('Novo perfil').fill(E2E_PROFILE_NAME);
  await switcher.getByRole('button', { name: 'Criar perfil' }).click();

  const newRow = switcher.locator(`[data-testid="profile-row"][data-slug="${E2E_PROFILE_NAME}"]`);
  await expect(newRow).toBeVisible({ timeout: 30_000 });

  // Prova no FILESYSTEM real (não só na UI) que as 6 junctions + metadado existem — mesmo espírito de tabs-lifecycle.spec.ts (tasklist real, não confia só na tela).
  await expect(async () => {
    expect(existsSync(E2E_PROFILE_DIR)).toBe(true);
    const entries = readdirSync(E2E_PROFILE_DIR);
    for (const dirName of PROFILE_LINK_DIR_NAMES) expect(entries).toContain(dirName);
    expect(entries).toContain('.donel-profile.json');
  }).toPass({ timeout: 5_000 });

  // 3. Doctor verde (DoD explícito da task). MUDANÇA (T207/CA-7, 002-quota-headroom):
  // a lista ficou enxuta — perfil saudável não renderiza MAIS nenhum texto de
  // status ("Perfil OK" removido, testid `profile-doctor-ok` não existe mais).
  // A prova de "doctor rodou e está verde" agora é a AUSÊNCIA do aviso de erro
  // (`profile-doctor-warning`) — `toPass` dá tempo do doctor assíncrono
  // (`refreshDoctorFor`, disparado na abertura do dropdown/criação do perfil)
  // responder antes de considerar a ausência como prova (mesma janela de 15s
  // do wait antigo, sem depender de um testid que não existe mais).
  await expect(async () => {
    expect(await newRow.locator('[data-testid="profile-doctor-warning"]').count()).toBe(0);
  }).toPass({ timeout: 15_000 });
  await expect(newRow).not.toContainText('Junctions com problema');

  // 4. Ativar o perfil (CA-3 — "troco pra B") — a linha não segue a
  // convenção "Tecnologia Claude {n}" (nome de teste arbitrário), então
  // ProfileSwitcher.tsx renderiza um botão genérico com o nome cru em vez do
  // AccountBadge do design-system.
  await newRow.getByRole('button', { name: E2E_PROFILE_NAME }).click();
  await expect(newRow.getByRole('button', { name: E2E_PROFILE_NAME })).toContainText(E2E_PROFILE_NAME);

  // Fecha o dropdown (Escape — Modal.tsx) antes de abrir a sessão nova.
  await window.keyboard.press('Escape');
  await expect(switcher).toBeHidden();

  // Titlebar reflete o perfil ativo (accountLabel via onActiveProfileLabelChange, App.tsx statusbar também) — confirma que a troca "pegou" antes de spawnar a sessão.
  await expect(window.locator('[data-testid="profile-switcher-trigger"]')).toContainText(E2E_PROFILE_NAME);

  // FIX (feedback E2E rodada 5) — "statusbar deve mostrar a conta com que a
  // sessão EM FOCO foi criada" (specs/001-mvp/feedback-e2e.md). `principalTab`
  // (passo 0, ainda em foco aqui — nenhuma aba nova foi criada desde então)
  // nasceu SOB O PERFIL PRINCIPAL, antes da ativação acima; mesmo com o
  // perfil ATIVO global agora sendo `E2E_PROFILE_NAME`, a statusbar tem
  // que continuar mostrando o perfil de NASCIMENTO da aba em foco
  // ("Sessão: Principal") — SEM o fix, ela mostraria o perfil ativo global
  // (`E2E_PROFILE_NAME`), sugerindo (errado) que a aba trocou de conta.
  //
  // FIX (auditoria rodada 5, achado alta "regressão de cota") — `toContainText`
  // em vez de `toHaveText`: o rótulo agora carrega ` · <cota>` (percent ou
  // "—") depois do nome, e o valor exato da cota não é determinístico neste
  // ambiente de teste (perfil e2e sem quota-axi real) — a prova AQUI é o
  // NOME da conta de nascimento, não o número da cota.
  const statusbarAccount = window.locator('[data-testid="statusbar-account"]');
  await expect(statusbarAccount).toContainText('Sessão: Principal');

  // 5. Spawna uma sessão claude nova reaproveitando o `lastLaunch` gravado no
  // passo 0 acima — não é mais "sem projeto/modelo específico" (auditoria
  // rodada 6 ciclo 2), mas isso não importa pra esta prova — o que valida o
  // isolamento (passo 6) é o estado de AUTH da sessão nova, independente de
  // cwd/modelo.
  //
  // FIX (teste manual 27/07) — o corpo do "＋ Nova sessão" agora SEMPRE abre
  // o Launcher (não spawna mais direto mesmo com `lastLaunch` gravado); o
  // atalho que reaproveita a última config virou o item "Rápida (última
  // config)" do dropdown.
  await window.getByRole('button', { name: 'Mais opções de ＋ Nova sessão' }).click();
  await window.getByRole('menuitem', { name: 'Rápida (última config)' }).click();

  const newTab = window.locator('[role="tab"]').last();
  await expect(newTab).toBeVisible();
  await expect(newTab).toHaveAttribute('aria-selected', 'true');

  // FIX (feedback E2E rodada 5) — a aba NOVA (em foco agora) nasceu sob o
  // perfil recém-ativado — statusbar troca pra refletir ESTA aba, não mais
  // a anterior. `toContainText` pelo mesmo motivo do assert acima.
  await expect(statusbarAccount).toContainText(`Sessão: ${E2E_PROFILE_NAME}`);

  // 6. PROVA do isolamento (spike seção 4/5 + addendum 2026-07-23), com uma
  // CORREÇÃO em relação ao texto literal pedido pela task: a task descrevia
  // "mostra 'Not logged in'" — essa string é o comportamento do `claude -p`
  // NÃO-interativo (validado no spike). Só que o CommandBuilder desta app
  // (src/shared/commandBuilder.ts) NUNCA usa `-p` — toda sessão spawnada pelo
  // Donel Dev é INTERATIVA. Verificação empírica feita ANTES de escrever este
  // smoke (node-pty direto, mesmo binário/mesmo profile fresco): uma sessão
  // interativa num perfil novo mostra primeiro o wizard de 1º uso ("Welcome
  // to Claude Code" -> seletor de tema) e só DEPOIS de aceitar o tema chega
  // em "Select login method" — nunca imprime "Not logged in" sozinha, e
  // avançar mais um passo (selecionar um método) dispara "Opening browser to
  // sign in…" com uma URL de OAuth REAL. Prosseguir até esse ponto seria
  // iniciar um login de verdade num teste automatizado — inaceitável (regra
  // do projeto: o app nunca toca credenciais; login é sempre ato humano no
  // terminal). "Select login method" é PROVA equivalente (e mais segura) do
  // isolamento: uma sessão que tivesse herdado a conta global não pediria
  // método de login nenhum — ela simplesmente funcionaria. Aceita o tema
  // default (Enter) e PARA — nenhuma tecla é enviada depois disso.
  const activePane = window.locator('[data-testid="terminal-pane"]:visible');
  await expect(activePane).toHaveCount(1);
  await expect(async () => {
    expect(await activePane.innerText()).toContain("Let's get started");
  }).toPass({ timeout: 20_000 });

  await activePane.click();
  await window.keyboard.press('Enter'); // aceita o tema em destaque — único input enviado a esta sessão.

  await expect(async () => {
    expect(await activePane.innerText()).toContain('Select login method');
  }).toPass({ timeout: 20_000 });
  // Nunca avança daqui — selecionar uma opção abriria um fluxo OAuth real.

  // FIX (feedback E2E rodada 5) — aba de terminal livre (FR-008) nunca
  // aplica `CLAUDE_CONFIG_DIR` (PtyManager.create) — não tem "perfil de
  // nascimento" nenhum, então a statusbar mostra um rótulo neutro em vez de
  // repetir o nome de um perfil que não se aplica a ela.
  await window.getByRole('button', { name: 'Mais opções de ＋ Nova sessão' }).click();
  await window.getByRole('menuitem', { name: 'Terminal (shell livre)' }).click();
  const shellTab = window.locator('[role="tab"]').last();
  await expect(shellTab).toHaveAttribute('aria-selected', 'true');
  await expect(statusbarAccount).toHaveText('Terminal (sem conta)');

  // Higiene: devolve a conta ativa pra Principal antes de fechar o app —
  // não deixa esta execução do smoke com um perfil de teste (que vai ser
  // apagado no afterAll) como "ativo" persistido pro próximo boot real.
  await trigger.click();
  await expect(switcher).toBeVisible();
  await switcher.locator('[data-testid="profile-row"][data-slug="principal"]').getByRole('button').first().click();
  await window.keyboard.press('Escape');
});
