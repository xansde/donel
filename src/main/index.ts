import { app, BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AppConfigDto,
  ArchivePhaseSessionIpcInput,
  DiscoveryTree,
  LauncherDefaultsDto,
  NotificationPreference,
  OpenDiscoveryIpcInput,
  PhaseDefaultsTable,
  ProfileDoctorReportDto,
  ProfileHeadroomMap,
  ProfileSummaryDto,
  ProjectInfo,
  ProjectScanMode,
  PtyCreateOptions,
  PtyCreateResult,
  PhaseArchivedPayload,
  PtyExitInfo,
  SemaphoreUpdate,
  SessionSummaryDto,
  TranscriptChangedPayload,
  WatchPhaseIpcInput,
} from '../shared';
import {
  archivePhaseSession,
  CLAUDE_NOT_FOUND_PREFIX,
  closeDiscovery,
  CONFIG_CHANNELS,
  DEVMODE_CHANNELS,
  focusDiscovery,
  isValidArchivePhaseSessionIpcInput,
  isValidCardId,
  isValidCardIdList,
  isValidOpenDiscoveryIpcInput,
  isValidWatchPhaseIpcInput,
  normalizeSessionName,
  openDiscovery,
  PROFILE_CHANNELS,
  PROJECT_CHANNELS,
  PTY_CHANNELS,
  SEMAPHORE_CHANNELS,
  SESSION_CHANNELS,
  TRANSCRIPT_CHANNELS,
} from '../shared';
import { createSystemResolveDeps, resolveClaudeExecutable } from './claude-executable';
import {
  clearSessionName,
  CONFIG_FILE_NAME,
  createSystemConfigIoDeps,
  defaultAppConfig,
  LEGACY_ACTIVE_PROFILE_FILE_NAME,
  LEGACY_PROJECT_CONFIG_FILE_NAME,
  readAppConfig,
  sanitizePhaseDefaultsTable,
  setSessionName,
  toAppConfigDto,
  toggleFavorite,
  writeAppConfig,
  type AppConfig,
} from './config-store';
import { buildDiscoveryTree } from './discovery-tree';
import { createSystemEsteiraReaderIoDeps } from './esteira-reader';
import { watchEsteiraResult, type EsteiraResultWatcherHandle } from './esteira-result-watcher';
import {
  listEntryColumnCards,
  readBoardFactsFor,
  resolveBoardFactsReader,
  resolveBoardReader,
  type BoardFacts,
  type EntryColumnCard,
} from './taskdex-board-client';
import { writeHooksSettingsFile } from './hooks-settings';
import {
  claudeHomeDir,
  createProfile,
  createSystemProfileCreationIoDeps,
  createSystemProfileDoctorDeps,
  createSystemProfileListDeps,
  createSystemProfileRepairIoDeps,
  listProfiles,
  PRINCIPAL_PROFILE,
  PRINCIPAL_PROFILE_SLUG,
  profileDirPath,
  repairProfileJunctions,
  runProfileDoctor,
  titleCaseFromSlug,
  type ProfileInfo,
} from './profile-manager';
import { createSystemScanDeps, defaultProjectRoots, mergeFavorites, scanProjects, sortProjects } from './project-scanner';
import { PtyManager } from './pty-manager';
// T504 (005-terminal-copy-paste) — clipboard-bridge (T503), aditivo aos
// imports acima (não reordena o bloco existente).
import { hasImage, readText, writeText } from './clipboard-bridge';
import { CLIPBOARD_CHANNELS } from '../shared';
import { HeadroomCache, readAllProfilesHeadroom } from './quota-headroom';
import { resolveClaudeCorrelation } from './session-correlation';
import { defaultClaudeHome, indexProjectSessions, resolveProjectSessionsDir } from './session-indexer';
import { seedProject } from './session-seed';
import { SessionSemaphoreManager } from './session-semaphore-manager';
import { TranscriptWatcherRegistry } from './transcript-watcher';
import { forgetIfOrphan } from '../shared/resumeFailure';
import { removeSession, setPinned, upsertVisit } from '../shared/sessionRegistry';

// Scaffold T003 — janela única com o layout do shell (ui-spec §2).
// PtyManager chega em T004 (este arquivo). ProjectScanner chega no T007
// (este arquivo). SessionIndexer (T012/T013) e ProfileManager (T014) chegam
// nas tasks seguintes (plan.md "Arquitetura de processos"). ConfigStore
// formal chega no T015 (config-store.ts) — `appConfig` abaixo é a fonte de
// verdade única pra favoritos/roots/perfil ativo/defaults do launcher/
// notificação, substituindo os JSONs avulsos que T007/T014 usavam.

const ptyManager = new PtyManager();
// Resolvido uma vez (não muda durante a vida do processo) — plan.md ponto 2.
const claudeResolveDeps = createSystemResolveDeps();
// Idem para o scan de projetos (T007) — mesmo padrão do claude-executable.
const projectScanDeps = createSystemScanDeps();

// T015 — ConfigStore formal (FR-007): carregado de verdade em
// `app.whenReady()` (migração dos JSONs legados de T007/T014 incluída, ver
// config-store.ts) — o valor abaixo é só o placeholder até lá (nunca
// consultado antes do boot terminar, já que todo IPC handler só é
// registrado DEPOIS do `whenReady().then(...)`). `projectRoots` deixa de
// ser uma const fixa: passa a vir de `appConfig.projectRoots` (editável
// pela UI de Preferências, feedback E2E rodada 3).
const configIoDeps = createSystemConfigIoDeps();
let appConfig: AppConfig = defaultAppConfig(defaultProjectRoots(homedir));

// T303/T305 (003-modo-dev) — leitura dos artefatos `.esteira/` em disco;
// injetável (mesmo padrão de `configIoDeps`), resolvido uma vez.
const esteiraReaderIoDeps = createSystemEsteiraReaderIoDeps();

// T311 (Batch B) — de onde vêm os cards da porta de entrada (CA-1). Na Fatia
// 1 não existe cliente de rede ainda (isso é T324/CA-11, com credencial
// dedicada): sem `DONEL_DEVMODE_BOARD_FIXTURE` este leitor devolve lista
// vazia — a porta de entrada existe e não mente, só não tem fonte ainda.
const boardReader = resolveBoardReader(process.env, esteiraReaderIoDeps.readFileText);

// T327 (Batch D) — fonte dos 4 fatos do espelho (CA-12). Mesma degradação do
// `boardReader`: sem fixture (e enquanto não houver um `callTool` real para
// `createSystemBoardFactsReader`), nenhum card tem fato — a árvore continua
// inteira, só não recebe anotação. Leitura pura, nunca escreve no board.
const boardFactsReader = resolveBoardFactsReader(process.env, esteiraReaderIoDeps.readFileText);

/**
 * T315 (Batch B) — um watcher de manifesto por ETAPA vigiada (CA-6), chave =
 * `discovery:card:marco:fase`. Vive aqui (e não no renderer) porque `fs.watch`
 * é main; o renderer só assina o push `devMode:phaseArchived`. Nada aqui
 * ESCREVE em disco — é watch de leitura, invariante 5 preservada.
 */
const esteiraResultWatchers = new Map<string, EsteiraResultWatcherHandle>();

function phaseWatchKey(input: { discoveryCardId: string; cardId: string; marcoId: string; phase: string }): string {
  return `${input.discoveryCardId}:${input.cardId}:${input.marcoId}:${input.phase}`;
}

function disposeAllEsteiraResultWatchers(): void {
  for (const handle of esteiraResultWatchers.values()) handle.dispose();
  esteiraResultWatchers.clear();
}

// T014 — ProfileManager (FR-005, FR-012, CA-3). `profilePathDeps` é a única
// dependência de path (homedir) reaproveitada por toda função pura do
// módulo. `activeProfileSlug`/`activeProfileConfigDir` vivem em memória
// (persistidos no ConfigStore, T015) — toda sessão `claude` nova (T005/T008)
// nasce com o `CLAUDE_CONFIG_DIR` do perfil ativo NESTE INSTANTE (FR-005:
// "trocar de perfil afeta apenas sessões novas" — abas já abertas já
// receberam seu env por VALOR na criação, ver PtyManager.create).
const profilePathDeps = { homedir };
let activeProfileSlug: string = PRINCIPAL_PROFILE_SLUG;
let activeProfileConfigDir: string | undefined;
// FIX (feedback E2E rodada 5) — nome de exibição do perfil ativo, mantido ao
// lado de `activeProfileSlug`/`activeProfileConfigDir` (mesmos pontos de
// atualização: boot e `profiles:activate` abaixo) só pra devolver no
// `pty:create` de sessão claude (ver `PtyCreateResult.profile`) — a
// statusbar (App.tsx) usa isso pra saber com que perfil CADA ABA nasceu,
// distinto do perfil ATIVO global (que pode já ter mudado quando o foco
// volta pra essa aba).
let activeProfileName: string = PRINCIPAL_PROFILE.name;
const headroomCache = new HeadroomCache();

// T009 — semáforo de sessões (FR-010). `getRecentLines` reaproveita o ring
// buffer que o PtyManager já mantém (plan.md ponto 8) como sinal B da
// heurística de fallback (spike §"Fallback heurístico").
const semaphoreManager = new SessionSemaphoreManager({ getRecentLines: (ptyId) => ptyManager.getPreview(ptyId) });
/** Path do `--settings` adicional (hooks-settings.ts) — resolvido uma vez no boot, reaproveitado por todo spawn de sessão claude. `null` até `app.whenReady()` rodar. */
let hooksSettingsPath: string | null = null;

// Achado do T009 (ao escrever o `--settings` de hooks pela primeira vez):
// sem `setName`, o Electron só resolve o nome do app ("donel-dev", de
// package.json) quando invocado como `electron .` (dev, `npm run dev`) — ao
// rodar o build direto por caminho de script (`electron out/main/index.js`,
// exatamente como o smoke roteirizado e a instalação real via atalho fazem),
// ele cai pro default "Electron", e `app.getPath('userData')` (usado aqui E
// pelo `config.json` do ConfigStore, T015) vira `%APPDATA%\Electron` — uma
// pasta genérica compartilhada por QUALQUER outro app Electron mal-nomeado
// nesta máquina. `setName` força o nome certo em todo modo de execução,
// antes de qualquer `getPath('userData')`.
app.setName('donel-dev');

// Windows: sem isso, `new Notification()` sai atribuída a "Electron" (ou
// falha em silêncio fora do dev) — plan.md, risco "Notification API do
// Electron sem app.setAppUserModelId no Windows".
app.setAppUserModelId('com.seazone.doneldev');

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  const unsubscribeData = ptyManager.onData((ptyId, data) => {
    mainWindow.webContents.send(PTY_CHANNELS.data, ptyId, data);
  });
  const unsubscribeExit = ptyManager.onExit((ptyId, exitCode, signal) => {
    const info: PtyExitInfo = { exitCode, signal };
    mainWindow.webContents.send(PTY_CHANNELS.exit, ptyId, info);

    // T009 — onExit do node-pty (evento do SO) é a fonte de verdade pra
    // "encerrada"/"falha" (spike: kill forçado nunca dispara SessionEnd).
    // Só reage a ptyIds que o semáforo de fato registrou (sessão claude
    // real, T005+); uma futura aba de terminal livre (FR-008/T010) nunca
    // passou por `registerSession`, então isso é um no-op silencioso pra ela.
    if (semaphoreManager.getSnapshot(ptyId)) {
      semaphoreManager.onProcessExit(ptyId, exitCode);
      semaphoreManager.unregisterSession(ptyId);
    }

    // T412 (004) — baixa do watcher de transcript. AQUI e não no `SessionEnd`:
    // kill forçado não dispara o hook, e um watcher sobrevivente é handle
    // vazado. No-op para aba de terminal livre (nunca abriu watcher).
    transcriptWatchers.stop(ptyId);
  });
  const unsubscribeSemaphore = semaphoreManager.onUpdate((update: SemaphoreUpdate) => {
    mainWindow.webContents.send(SEMAPHORE_CHANNELS.update, update);
  });

  // Fechar a janela mata todos os PTYs dela — evita processos powershell.exe
  // órfãos (plan.md risco de vazamento, DoD do ciclo de vida chega em T010).
  mainWindow.on('closed', () => {
    unsubscribeData();
    unsubscribeExit();
    unsubscribeSemaphore();
    // A janela morrendo mata os PTYs; os watchers deles vão junto (o `onExit`
    // de cada um já daria baixa, mas não depender disso é o que garante zero
    // handle sobrevivendo ao fechamento).
    transcriptWatchers.disposeAll();
    // T315 (003-modo-dev) — mesma higiene do registry de transcript: nenhum
    // `fs.watch` sobrevive ao fechamento da janela.
    disposeAllEsteiraResultWatchers();
    ptyManager.killAll();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * T412 (004-nomear-sessoes) — um watcher de transcript por aba `claude` VIVA
 * (não só a em foco: senão "troco de aba e o nome não segue"). Chave = `ptyId`,
 * porque é o `PtyManager.onExit` — a fonte de verdade de morte de sessão,
 * inclusive em kill forçado, onde o `SessionEnd` NÃO dispara (spike T002) — que
 * dá baixa neles.
 */
const transcriptWatchers = new TranscriptWatcherRegistry();

/**
 * Path do `.jsonl` da sessão. O CLI o deriva do `cwd` (slug do path absoluto) e
 * do diretório de config ATIVO — com um perfil ativo, `CLAUDE_CONFIG_DIR`
 * aponta para o diretório do perfil, e o transcript vive lá dentro, não em
 * `~/.claude`. Usa o mesmo `activeProfileConfigDir` passado ao spawn, para o
 * watcher não vigiar um arquivo que nunca vai aparecer.
 */
function resolveTranscriptPath(sessionId: string, cwd: string | undefined, claudeConfigDir: string | undefined): string {
  const claudeHome = claudeConfigDir ?? defaultClaudeHome();
  return join(resolveProjectSessionsDir(cwd ?? homedir(), claudeHome), `${sessionId}.jsonl`);
}

/**
 * T710/CA-11 (2º momento) — caminho do `.jsonl` de cada sessão spawnada NESTA
 * execução do app, gravado no momento do spawn.
 *
 * Existe para o `sessions:forgetIfOrphan` conferir o arquivo EXATO: o caminho
 * depende do perfil de NASCIMENTO da aba (`CLAUDE_CONFIG_DIR`), e o perfil ativo
 * pode ter mudado entre o spawn e a falha — re-derivar pelo perfil de agora
 * poderia dar "arquivo ausente" para uma sessão que existe no home de outro
 * perfil, e apagar uma entrada boa. Chave = `sessionId` (não `ptyId`) porque é
 * essa a chave do registro de sessões.
 */
const spawnedTranscriptPaths = new Map<string, string>();

function startTranscriptWatcher(ptyId: string, filePath: string, sessionId: string): void {
  transcriptWatchers.start(ptyId, {
    sessionId,
    filePath,
    onChange: (payload: TranscriptChangedPayload) => {
      // Mesmo mecanismo de push do semáforo e do `pty:data` — nada de um
      // segundo caminho de notificação para o renderer.
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(TRANSCRIPT_CHANNELS.changed, payload);
      }
    },
  });
}

function registerPtyIpcHandlers(): void {
  ipcMain.handle(PTY_CHANNELS.create, (_event, options: PtyCreateOptions): PtyCreateResult => {
    if (options.sessionType === 'claude') {
      // T005 — spawna o `claude` CLI direto no PTY (plan.md ponto 1), não
      // dentro de um shell. Sem resolução → CA-5: o renderer reconhece o
      // prefixo e mostra o banner com o caminho esperado (nunca uma aba
      // quebrada sem explicação).
      const resolved = resolveClaudeExecutable(claudeResolveDeps);
      if (!resolved.found) {
        throw new Error(`${CLAUDE_NOT_FOUND_PREFIX}${resolved.expectedPath}`);
      }

      // T008 — argv do Launcher (CommandBuilder, FR-003/CA-1); vazio
      // preserva o comportamento antigo (T005: sessão sem flags).
      const launcherArgs = options.args ?? [];

      // T009 — correlação sessão<->aba (spike: `--session-id <uuid>`
      // determinístico) + hooks do semáforo (`--settings`, soma aditiva,
      // nunca toca ~/.claude/settings.json do usuário). Degrada com
      // graça se o servidor do semáforo não subiu no boot (app.whenReady):
      // a sessão continua funcionando, só sem os indicadores de estado.
      const { correlationId, extraArgs } = resolveClaudeCorrelation(launcherArgs, randomUUID);
      const semaphoreArgs = hooksSettingsPath ? ['--settings', hooksSettingsPath] : [];
      const finalArgs = [...launcherArgs, ...extraArgs, ...semaphoreArgs];

      const ptyId = ptyManager.create({
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        // FIX ambiente genérico (28/07) — `launch` embrulha shim `.cmd`/`.ps1`
        // (npm -g) no interpretador; ConPTY não executa script direto.
        command: resolved.launch.command,
        args: [...resolved.launch.argsPrefix, ...finalArgs],
        // T014 (FR-005/CA-3) — perfil ativo NO MOMENTO da criação da aba;
        // `undefined` pro perfil Principal (sem override de env).
        claudeConfigDir: activeProfileConfigDir,
      });

      if (hooksSettingsPath) {
        semaphoreManager.registerSession(ptyId, correlationId);
      }

      // T412 (004) — reflexo AO VIVO do `/rename` (CA-4). O path do `.jsonl` já
      // é conhecido aqui: o id da sessão foi IMPOSTO no spawn logo acima.
      const transcriptPath = resolveTranscriptPath(correlationId, options.cwd, activeProfileConfigDir);
      // T710 — guardado ANTES de qualquer coisa poder falhar: é o caminho que o
      // `forgetIfOrphan` vai conferir se esta retomada morrer (ver comentário de
      // `spawnedTranscriptPaths`).
      spawnedTranscriptPaths.set(correlationId, transcriptPath);
      startTranscriptWatcher(ptyId, transcriptPath, correlationId);

      // FIX (feedback E2E rodada 5) — perfil de NASCIMENTO desta sessão
      // (mesmo `activeProfileSlug`/Name usados em `claudeConfigDir` acima,
      // por VALOR — trocar de perfil depois não reescreve isto). Só pra
      // 'claude' (branch abaixo, shell, nunca aplica `CLAUDE_CONFIG_DIR` —
      // não tem "perfil" que fizesse sentido devolver aqui).
      // T404 (004) — `correlationId` é o id da sessão do Claude (imposto no
      // spawn acima, ou herdado do `-r` numa retomada); devolvê-lo aqui é o
      // que dá ao renderer a chave para nomear/persistir esta sessão.
      return { ptyId, claudeSessionId: correlationId, profile: { slug: activeProfileSlug, name: activeProfileName } };
    }

    const ptyId = ptyManager.create(options);
    return { ptyId };
  });

  ipcMain.on(PTY_CHANNELS.input, (_event, ptyId: string, data: string) => {
    ptyManager.input(ptyId, data);
  });

  ipcMain.on(PTY_CHANNELS.resize, (_event, ptyId: string, cols: number, rows: number) => {
    ptyManager.resize(ptyId, cols, rows);
  });

  ipcMain.on(PTY_CHANNELS.kill, (_event, ptyId: string) => {
    ptyManager.kill(ptyId);
  });

  ipcMain.handle(PTY_CHANNELS.preview, (_event, ptyId: string): string[] => {
    return ptyManager.getPreview(ptyId);
  });
}

// T504 (005-terminal-copy-paste) — canais `clipboard:*` (T503 clipboard-bridge,
// plan.md decisão 6: clipboard vive no main, nunca no renderer). As três
// funções já degradam sozinhas em caso de exceção (clipboard-bridge.ts) —
// nada a fazer aqui além de repassar.
function registerClipboardIpcHandlers(): void {
  ipcMain.handle(CLIPBOARD_CHANNELS.hasImage, (): boolean => hasImage());

  ipcMain.handle(CLIPBOARD_CHANNELS.readText, (): string => readText());

  ipcMain.handle(CLIPBOARD_CHANNELS.writeText, (_event, text: string): void => {
    writeText(text);
  });
}

/** `%APPDATA%\donel-dev\config.json` (T015, config-store.ts) — só chamável após `app.whenReady()`. */
function getAppConfigPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE_NAME);
}

/** Paths dos JSONs avulsos legados (T007/T014) — só usados pela migração de 1ª leitura (config-store.ts `readAppConfig`). */
function legacyConfigPaths(): { projectConfigPath: string; activeProfilePath: string } {
  const userDataDir = app.getPath('userData');
  return {
    projectConfigPath: join(userDataDir, LEGACY_PROJECT_CONFIG_FILE_NAME),
    activeProfilePath: join(userDataDir, LEGACY_ACTIVE_PROFILE_FILE_NAME),
  };
}

/** Escrita atômica (FR-007) do `appConfig` em memória — chamada depois de TODA mutação (favoritos, roots, perfil ativo, defaults do launcher, notificação). */
function persistAppConfig(): void {
  writeAppConfig(getAppConfigPath(), appConfig, configIoDeps);
}

/** Scan + merge de favoritos + ordenação — a mesma pipeline usada por list e favorite (T007), agora sobre `appConfig.projectRoots`/`appConfig.favorites` (T015). */
function listProjectsWithFavorites(): ProjectInfo[] {
  const scanned = scanProjects(appConfig.projectRoots, projectScanDeps, appConfig.projectScanMode);
  return sortProjects(mergeFavorites(scanned, appConfig.favorites));
}

function registerProjectIpcHandlers(): void {
  ipcMain.handle(PROJECT_CHANNELS.list, (): ProjectInfo[] => listProjectsWithFavorites());

  ipcMain.handle(PROJECT_CHANNELS.favorite, (_event, path: string, favorite: boolean): ProjectInfo[] => {
    appConfig = { ...appConfig, favorites: toggleFavorite(appConfig.favorites, path, favorite) };
    persistAppConfig();
    return listProjectsWithFavorites();
  });
}

/** Roots vazias (após trim)/duplicadas nunca chegam no `appConfig` — mesma disciplina defensiva do resto do ConfigStore (nunca propaga lixo pro scan de projetos). Preserva a ORDEM recebida (1ª ocorrência de cada root). */
function sanitizeProjectRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * T015 — UI de Preferências (FR-007, feedback E2E rodada 3 "roots
 * configuráveis" + rodada 4 "notificação configurável") + `launcherDefaults`
 * (semeado a cada "▶ Iniciar" do Launcher, App.tsx `handleLaunch`).
 */
function registerConfigIpcHandlers(): void {
  ipcMain.handle(CONFIG_CHANNELS.get, (): AppConfigDto => toAppConfigDto(appConfig));

  ipcMain.handle(CONFIG_CHANNELS.setProjectRoots, (_event, roots: string[]): AppConfigDto => {
    appConfig = { ...appConfig, projectRoots: sanitizeProjectRoots(roots) };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  ipcMain.handle(CONFIG_CHANNELS.setNotificationPreference, (_event, preference: NotificationPreference): AppConfigDto => {
    appConfig = { ...appConfig, notificationPreference: preference };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  /** FIX ambiente genérico (28/07) — critério da listagem de projetos; valor desconhecido degrada pro default. */
  ipcMain.handle(CONFIG_CHANNELS.setProjectScanMode, (_event, mode: ProjectScanMode): AppConfigDto => {
    appConfig = { ...appConfig, projectScanMode: mode === 'all' ? 'all' : 'markers' };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  ipcMain.handle(CONFIG_CHANNELS.setLauncherDefaults, (_event, defaults: LauncherDefaultsDto): AppConfigDto => {
    appConfig = { ...appConfig, launcherDefaults: defaults };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  /** T708 (007) — substitui a lista INTEIRA de projetos com o grupo "Favoritos" colapsado (CA-1). */
  ipcMain.handle(CONFIG_CHANNELS.setCollapsedFavorites, (_event, collapsed: string[]): AppConfigDto => {
    appConfig = { ...appConfig, collapsedFavorites: Array.isArray(collapsed) ? collapsed.filter((path) => typeof path === 'string') : [] };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });
}

/**
 * T307 (003-modo-dev, Batch A) — canais `devMode:*` (CA-21/CA-4/CA-19).
 * Payload inválido (cardId/repoPath vazios, fase desconhecida) é NO-OP — o
 * main devolve o `AppConfigDto` atual sem mutar (validação pura em
 * `src/shared/devMode.ts`, testada isolada). **Nenhum canal aqui escreve no
 * TaskDex ou no vault** (invariante 5/CA-19) — só disco de leitura
 * (`esteira-reader.ts`/`discovery-tree.ts`) e o `ConfigStore` local.
 */
function registerDevModeIpcHandlers(): void {
  ipcMain.handle(DEVMODE_CHANNELS.get, (): AppConfigDto => toAppConfigDto(appConfig));

  ipcMain.handle(DEVMODE_CHANNELS.openDiscovery, (_event, input: OpenDiscoveryIpcInput): AppConfigDto => {
    if (!isValidOpenDiscoveryIpcInput(input)) return toAppConfigDto(appConfig);
    appConfig = {
      ...appConfig,
      devMode: openDiscovery(appConfig.devMode, {
        cardId: input.cardId,
        repoPath: input.repoPath,
        epicId: input.epicId,
        openedAt: Date.now(),
      }),
    };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  ipcMain.handle(DEVMODE_CHANNELS.focusDiscovery, (_event, cardId: string): AppConfigDto => {
    if (!isValidCardId(cardId)) return toAppConfigDto(appConfig);
    appConfig = { ...appConfig, devMode: focusDiscovery(appConfig.devMode, cardId) };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  ipcMain.handle(DEVMODE_CHANNELS.closeDiscovery, (_event, cardId: string): AppConfigDto => {
    if (!isValidCardId(cardId)) return toAppConfigDto(appConfig);
    appConfig = { ...appConfig, devMode: closeDiscovery(appConfig.devMode, cardId, Date.now()) };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  ipcMain.handle(DEVMODE_CHANNELS.archivePhaseSession, (_event, input: ArchivePhaseSessionIpcInput): AppConfigDto => {
    if (!isValidArchivePhaseSessionIpcInput(input)) return toAppConfigDto(appConfig);
    appConfig = {
      ...appConfig,
      devMode: archivePhaseSession(
        appConfig.devMode,
        { cardId: input.cardId, marcoId: input.marcoId, phase: input.phase },
        { sessionId: input.sessionId, profileSlug: input.profileSlug, archivedAt: Date.now() },
      ),
    };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  ipcMain.handle(DEVMODE_CHANNELS.getDefaults, (): AppConfigDto => toAppConfigDto(appConfig));

  /** Tudo ou nada (mesma regra de `sanitizePhaseDefaultsTable`, T306): tabela malformada não muda o que já estava salvo. */
  ipcMain.handle(DEVMODE_CHANNELS.setDefaults, (_event, defaults: PhaseDefaultsTable): AppConfigDto => {
    appConfig = { ...appConfig, devMode: { ...appConfig.devMode, phaseDefaults: sanitizePhaseDefaultsTable(defaults) } };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  /** CA-7 — monta a árvore do discovery pedido a partir do disco. `cardId` sem discovery aberto devolve árvore vazia (nunca lança). */
  ipcMain.handle(DEVMODE_CHANNELS.readTree, (_event, cardId: string): DiscoveryTree => {
    const repoPath = isValidCardId(cardId) ? (appConfig.devMode.discoveries[cardId]?.repoPath ?? '') : '';
    if (!repoPath) return { discoveryCardId: cardId, marcos: [], focusedMarcoId: null, allMarcosComplete: false };
    return buildDiscoveryTree(repoPath, cardId, appConfig.devMode.archivedPhaseSessions, esteiraReaderIoDeps);
  });

  /** T311/CA-1 — cards das 3 colunas de entrada do board configurado. Sem board/sem fonte = `[]` (porta desligada, nunca erro). */
  ipcMain.handle(DEVMODE_CHANNELS.listEntryCards, async (): Promise<readonly EntryColumnCard[]> => {
    return listEntryColumnCards(appConfig.devMode.boardConfig, boardReader);
  });

  /**
   * T327/CA-12 — os 4 fatos do board para os cards do discovery EM FOCO (a
   * lista vem do renderer; o main nunca varre o board). Payload inválido é
   * no-op (`{}`), card sem fato some do mapa. **Leitura pura** — não existe
   * canal simétrico de escrita (invariante 5/CA-14).
   */
  ipcMain.handle(DEVMODE_CHANNELS.readBoardFacts, async (_event, cardIds: readonly string[]): Promise<Record<string, BoardFacts>> => {
    if (!isValidCardIdList(cardIds)) return {};
    return readBoardFactsFor(cardIds, boardFactsReader);
  });

  /**
   * T315/CA-6 — liga o watcher do `<fase>-result.json` daquela etapa. O
   * evento volta pelo `sender` que pediu o watch (nunca um broadcast global).
   * Idempotente: pedir duas vezes a mesma etapa não abre dois `fs.watch`.
   */
  ipcMain.handle(DEVMODE_CHANNELS.watchPhase, (event, input: WatchPhaseIpcInput): void => {
    if (!isValidWatchPhaseIpcInput(input)) return;
    const repoPath = appConfig.devMode.discoveries[input.discoveryCardId]?.repoPath;
    if (!repoPath) return;

    const key = phaseWatchKey(input);
    if (esteiraResultWatchers.has(key)) return;

    const sender = event.sender;
    const handle = watchEsteiraResult({
      repoPath,
      fase: input.phase,
      cardId: input.cardId,
      marcoId: input.marcoId,
      // ACHADO DO SMOKE (T322): o diretório `handoffs/<card_id>/` só nasce
      // quando a SKILL chega ao fim — e uma fase da Esteira leva minutos ou
      // horas. Com o default do módulo (1s × 30 = 30s) o watcher desistia
      // muito antes do manifesto existir, e o arquivamento do CA-6 nunca
      // disparava fora de um teste. Janela de espera aqui é ~1h (3s × 1200),
      // um timer barato; passado isso a fase segue visível como travada
      // (CA-15) — só o arquivamento automático deixa de acontecer.
      retryMs: 3_000,
      maxRetries: 1_200,
      onArchived: (archived) => {
        if (sender.isDestroyed()) return;
        const payload: PhaseArchivedPayload = {
          discoveryCardId: input.discoveryCardId,
          cardId: archived.cardId,
          marcoId: archived.marcoId,
          phase: archived.fase,
          manifestPath: archived.manifestPath,
        };
        sender.send(DEVMODE_CHANNELS.phaseArchived, payload);
      },
    });
    esteiraResultWatchers.set(key, handle);
  });

  ipcMain.handle(DEVMODE_CHANNELS.unwatchPhase, (_event, input: WatchPhaseIpcInput): void => {
    if (!isValidWatchPhaseIpcInput(input)) return;
    const key = phaseWatchKey(input);
    esteiraResultWatchers.get(key)?.dispose();
    esteiraResultWatchers.delete(key);
  });
}

/**
 * T013 — índice de sessões anteriores por projeto (FR-004, CA-2). Delega
 * inteiramente pro SessionIndexer (T012, TDD já fechado — não reescrito
 * aqui): stream das primeiras linhas, nunca o arquivo inteiro, `[]` sem
 * lançar pra projeto que nunca abriu sessão. Handler async porque
 * `indexProjectSessions` é async (leitura de disco); `ipcMain.handle` já
 * espera a Promise antes de responder o `invoke` do renderer.
 */
function registerSessionIpcHandlers(): void {
  ipcMain.handle(SESSION_CHANNELS.list, async (_event, projectPath: string): Promise<SessionSummaryDto[]> => {
    return indexProjectSessions(projectPath);
  });

  /**
   * T406 (004) — primeira escrita do domínio de sessões. A validação do C5
   * (`normalizeSessionName`) roda AQUI, não só na UI, porque é este handler
   * que persiste: nome vazio depois do trim apaga a entrada; senão grava
   * `{ name, seenTitle, updatedAt }`, onde `seenTitle` é o `custom-title` que a
   * UI exibia na hora da edição (insumo do dirty-check do C2). `sessionId`
   * vazio é ignorado — aba `shell` não tem sessão do Claude e nomeia só em
   * memória (C4), então nunca deveria chegar aqui.
   */
  ipcMain.handle(
    SESSION_CHANNELS.setName,
    (_event, sessionId: string, name: string, seenTitle: string | null): AppConfigDto => {
      if (typeof sessionId !== 'string' || !sessionId) return toAppConfigDto(appConfig);

      const normalized = normalizeSessionName(name);
      const stampedSeenTitle = typeof seenTitle === 'string' && seenTitle ? seenTitle : null;

      const sessionNames =
        normalized === null
          ? clearSessionName(appConfig.sessionNames, sessionId)
          : setSessionName(appConfig.sessionNames, sessionId, {
              name: normalized,
              seenTitle: stampedSeenTitle,
              updatedAt: new Date().toISOString(),
            });

      appConfig = { ...appConfig, sessionNames };
      persistAppConfig();
      return toAppConfigDto(appConfig);
    },
  );

  /**
   * T705 (007-favoritos-sessoes) — upsert de uma visita no registro (D9/CA-7).
   * Só o RENDERER chama (plan.md §Fatia 2: um escritor só, o main só valida o
   * payload — a mesma disciplina defensiva do `setName` acima, com `typeof`
   * explícito mesmo o contrato TS já dizendo `string`). `upsertVisit` já é
   * no-op para `sessionId`/`projectPath`/`label` vazios (sessionRegistry.ts),
   * então a checagem aqui é só a primeira linha de defesa contra IPC malformado.
   */
  ipcMain.handle(
    SESSION_CHANNELS.registerVisit,
    (_event, sessionId: string, projectPath: string, label: string): AppConfigDto => {
      if (typeof sessionId !== 'string' || typeof projectPath !== 'string' || typeof label !== 'string') {
        return toAppConfigDto(appConfig);
      }
      appConfig = { ...appConfig, sessionRegistry: upsertVisit(appConfig.sessionRegistry, { sessionId, projectPath, label, atMs: Date.now() }) };
      persistAppConfig();
      return toAppConfigDto(appConfig);
    },
  );

  /** T705/CA-5 — fixa/desfixa a SESSÃO (persistido); `setPinned` (sessionRegistry.ts) já é no-op pra sessionId inexistente. */
  ipcMain.handle(SESSION_CHANNELS.setPinned, (_event, sessionId: string, pinned: boolean): AppConfigDto => {
    if (typeof sessionId !== 'string' || !sessionId) return toAppConfigDto(appConfig);
    appConfig = { ...appConfig, sessionRegistry: setPinned(appConfig.sessionRegistry, sessionId, pinned === true) };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  /** T705/CA-11 — "esquecer" uma entrada órfã (retomar falhou, `.jsonl` sumiu). Canal PRÓPRIO — não reaproveita `setPinned` (desfixar e esquecer são operações diferentes). */
  ipcMain.handle(SESSION_CHANNELS.forget, (_event, sessionId: string): AppConfigDto => {
    if (typeof sessionId !== 'string' || !sessionId) return toAppConfigDto(appConfig);
    appConfig = { ...appConfig, sessionRegistry: removeSession(appConfig.sessionRegistry, sessionId) };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  /**
   * T710/CA-11 (2º momento) — o renderer viu a retomada morrer com código != 0
   * (`shouldForgetOnResumeFailure`, sinal medido em
   * `specs/008-fechar-pendencias/medicao-t710.md`) e pede o esquecimento. Aqui
   * mora a PROVA: só remove se o `.jsonl` daquela sessão não existir mesmo.
   * É o que impede um exit code != 0 de outra origem (cota estourada, `claude`
   * não encontrado, Ctrl+C precoce) de apagar uma entrada boa.
   *
   * O caminho conferido é o gravado NO SPAWN (`spawnedTranscriptPaths`, perfil
   * de nascimento da aba); o fallback re-deriva pelo `projectPath` da entrada
   * com o perfil ATIVO, para a sessão que nasceu em outra execução do app.
   */
  ipcMain.handle(SESSION_CHANNELS.forgetIfOrphan, (_event, sessionId: string): AppConfigDto => {
    if (typeof sessionId !== 'string' || !sessionId) return toAppConfigDto(appConfig);
    const entry = appConfig.sessionRegistry[sessionId];
    if (!entry) return toAppConfigDto(appConfig);

    const transcriptPath = spawnedTranscriptPaths.get(sessionId) ?? resolveTranscriptPath(sessionId, entry.projectPath, activeProfileConfigDir);
    appConfig = {
      ...appConfig,
      sessionRegistry: forgetIfOrphan(appConfig.sessionRegistry, sessionId, existsSync(transcriptPath)),
    };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });

  /**
   * T706/CA-8 — a ÚNICA leitura de disco desta feature; delega inteiramente
   * pro `seedProject` (T706, TDD já fechado): a guarda dura ("projeto já tem
   * entrada → não lê disco") vive lá, não aqui, para ser testável sem subir o
   * Electron. `claudeHome` é o do PERFIL ATIVO (mesmo valor usado em
   * `resolveTranscriptPath`/`claudeConfigDir` do spawn) — os transcripts do
   * perfil ativo vivem lá, não necessariamente em `~/.claude`.
   */
  ipcMain.handle(SESSION_CHANNELS.seedProject, async (_event, projectPath: string): Promise<AppConfigDto> => {
    if (typeof projectPath !== 'string' || !projectPath) return toAppConfigDto(appConfig);
    const sessionRegistry = await seedProject(
      appConfig.sessionRegistry,
      projectPath,
      appConfig.sessionNames,
      { indexProjectSessions },
      activeProfileConfigDir,
    );
    appConfig = { ...appConfig, sessionRegistry };
    persistAppConfig();
    return toAppConfigDto(appConfig);
  });
}

/** Sempre inclui o Principal + varre `~/.claude-profiles/*` de novo a cada chamada (mesmo espírito de `listProjectsWithFavorites` — lista pequena, I/O local, sem necessidade de cache próprio aqui). */
function currentProfileList(): ProfileInfo[] {
  return listProfiles(createSystemProfileListDeps(homedir));
}

function toProfileSummaryDto(profile: ProfileInfo): ProfileSummaryDto {
  return { name: profile.name, slug: profile.slug, isPrimary: profile.isPrimary, active: profile.slug === activeProfileSlug };
}

/** Doctor/repair podem ser chamados por slug que não está (mais) na listagem atual — sintetiza um `ProfileInfo` a partir do slug em vez de silenciosamente cair pro Principal (que mentiria "saudável" pra um perfil que não existe). */
function resolveProfileOrSynthesize(slug: string): ProfileInfo {
  const existing = currentProfileList().find((profile) => profile.slug === slug);
  if (existing) return existing;
  if (slug === PRINCIPAL_PROFILE_SLUG) return PRINCIPAL_PROFILE;
  return { name: titleCaseFromSlug(slug), slug, configDir: profileDirPath(slug, profilePathDeps), isPrimary: false };
}

/**
 * T014 — ProfileManager (FR-005, FR-012, CA-3). GATE HUMANO: a mecânica de
 * isolamento por `CLAUDE_CONFIG_DIR` foi validada ponta-a-ponta pelo
 * Alexandre em 2026-07-23 (login real concorrente, ver addendum de
 * `specs/001-mvp/spike-t001-resultado.md`) — mas o app em si NUNCA lê/grava/
 * exibe credenciais; qualquer conta nova cadastrada aqui só fica "pronta de
 * verdade" depois de um `/login` real dentro do terminal daquele perfil.
 */
function registerProfileIpcHandlers(): void {
  ipcMain.handle(PROFILE_CHANNELS.list, (): ProfileSummaryDto[] => currentProfileList().map(toProfileSummaryDto));

  ipcMain.handle(PROFILE_CHANNELS.create, async (_event, name: string): Promise<ProfileSummaryDto[]> => {
    // Mesma resolução do `claude` usada pro spawn de sessão (T005) — o
    // bootstrap do `.claude.json` do perfil (spike seção 4/5) precisa do
    // mesmo executável; CA-5 (claude ausente) degrada com graça aqui também
    // (createSystemProfileCreationIoDeps trata `claudeExecutablePath: null`
    // como no-op no passo de bootstrap, não como erro fatal). Handler async
    // — `createProfile` aguarda o bootstrap sem travar o event loop do main
    // (ver comentário de topo de `ProfileCreationIoDeps.runBootstrapPrompt`).
    const resolved = resolveClaudeExecutable(claudeResolveDeps);
    const io = createSystemProfileCreationIoDeps(resolved.found ? resolved.launch : null, profilePathDeps);
    await createProfile(name, profilePathDeps, io);
    return currentProfileList().map(toProfileSummaryDto);
  });

  ipcMain.handle(PROFILE_CHANNELS.activate, (_event, slug: string): ProfileSummaryDto[] => {
    const profiles = currentProfileList();
    const target = profiles.find((profile) => profile.slug === slug);
    // Slug desconhecido = no-op silencioso (lista devolvida sem o campo
    // `active` mudar) — não há perfil válido pra ativar.
    if (target) {
      activeProfileSlug = target.slug;
      activeProfileConfigDir = target.configDir;
      activeProfileName = target.name; // FIX (feedback E2E rodada 5) — mesmo ponto de atualização de activeProfileSlug/activeProfileConfigDir acima.
      // T015 — perfil ativo agora persiste dentro do ConfigStore unificado
      // (antes: active-profile.json próprio, T014).
      appConfig = { ...appConfig, activeProfileSlug: target.slug };
      persistAppConfig();
    }
    return profiles.map(toProfileSummaryDto);
  });

  ipcMain.handle(PROFILE_CHANNELS.doctor, (_event, slug: string): ProfileDoctorReportDto => {
    const profile = resolveProfileOrSynthesize(slug);
    return runProfileDoctor(profile, claudeHomeDir(profilePathDeps), createSystemProfileDoctorDeps(profilePathDeps));
  });

  ipcMain.handle(PROFILE_CHANNELS.repair, (_event, slug: string): ProfileDoctorReportDto => {
    const profile = resolveProfileOrSynthesize(slug);
    const claudeHome = claudeHomeDir(profilePathDeps);
    const doctorDeps = createSystemProfileDoctorDeps(profilePathDeps);
    const report = runProfileDoctor(profile, claudeHome, doctorDeps);
    repairProfileJunctions(profile, report, claudeHome, createSystemProfileRepairIoDeps());
    // Re-roda o doctor pós-reparo — devolve o estado REAL, não um "healthy" otimista.
    return runProfileDoctor(profile, claudeHome, doctorDeps);
  });

  ipcMain.handle(PROFILE_CHANNELS.headroom, async (_event, rawOptions?: unknown): Promise<ProfileHeadroomMap> => {
    // T205 — payload vem do renderer via IPC; nunca confiar cegamente
    // (poderia ser qualquer coisa vinda de um preload comprometido/versão
    // desalinhada) — só aceita `{ force: true }`, qualquer outra forma vira
    // `force: false` (comportamento anterior, respeita cache).
    const force =
      typeof rawOptions === 'object' && rawOptions !== null && (rawOptions as { force?: unknown }).force === true;
    const targets = currentProfileList().map((profile) => ({ slug: profile.slug, configDir: profile.configDir }));
    return readAllProfilesHeadroom(targets, headroomCache, undefined, { force });
  });
}

void app.whenReady().then(async () => {
  // T009 — sobe o servidor local do semáforo e grava o `--settings` ANTES de
  // registrar os handlers de PTY (o primeiro `pty:create` de uma sessão
  // claude já precisa do path pronto). Falha aqui não derruba o app —
  // `hooksSettingsPath` fica `null` e as sessões nascem sem semáforo
  // (degradação, não crash — mesmo espírito do catch de `projects.list`).
  try {
    const port = await semaphoreManager.start();
    hooksSettingsPath = writeHooksSettingsFile(app.getPath('userData'), port);
  } catch (error) {
    console.error('[donel-dev] semáforo de sessões não subiu (T009) — sessões claude vão nascer sem indicador de estado:', error);
  }

  // T015 — carrega o ConfigStore unificado ANTES de qualquer coisa que
  // dependa dele: scan de projetos com os roots persistidos, perfil ativo
  // persistido. Migra dos JSONs avulsos legados (T007/T014) se `config.json`
  // ainda não existir nesta máquina (ver comentário de topo de
  // config-store.ts) — nunca lança, cai nos defaults na pior hipótese.
  appConfig = readAppConfig(getAppConfigPath(), defaultAppConfig(defaultProjectRoots(homedir)), legacyConfigPaths(), configIoDeps);

  // T014 — perfil ativo persistido ANTES de registrar os handlers de PTY (o
  // primeiro `pty:create` de sessão claude já precisa do
  // `activeProfileConfigDir` certo). Slug persistido que não existe mais
  // (perfil removido do disco manualmente) cai pro Principal, nunca lança.
  const bootProfile = currentProfileList().find((profile) => profile.slug === appConfig.activeProfileSlug) ?? PRINCIPAL_PROFILE;
  activeProfileSlug = bootProfile.slug;
  activeProfileConfigDir = bootProfile.configDir;
  activeProfileName = bootProfile.name; // FIX (feedback E2E rodada 5) — mesmo ponto de atualização de activeProfileSlug/activeProfileConfigDir acima.
  // Slug persistido pode ter sido normalizado pro Principal acima (perfil
  // morto) — reflete de volta no config em memória pra próxima escrita não
  // reintroduzir um slug inexistente.
  if (appConfig.activeProfileSlug !== bootProfile.slug) {
    appConfig = { ...appConfig, activeProfileSlug: bootProfile.slug };
  }

  registerPtyIpcHandlers();
  registerProjectIpcHandlers();
  registerSessionIpcHandlers();
  registerProfileIpcHandlers();
  registerConfigIpcHandlers();
  registerClipboardIpcHandlers(); // T504 (005-terminal-copy-paste)
  registerDevModeIpcHandlers(); // T307 (003-modo-dev)
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  ptyManager.killAll();
  semaphoreManager.dispose();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
