// Tipos IPC compartilhados entre main/preload/renderer (plan.md "Arquitetura
// de processos"). CommandBuilder chega em T006 (TDD); os tipos abaixo cobrem
// os canais `pty:*` introduzidos em T004. Canais `projects:*` chegam no T007
// (src/shared/projects.ts) — os demais (sessions:*, profiles:*, config:*)
// chegam junto das tasks que os implementam.

import type { DonelConfigApi } from './config';
import type { DonelDevModeApi } from './devMode';
import type { DonelProfilesApi } from './profiles';
import type { DonelProjectsApi } from './projects';
import type { DonelSessionsApi } from './sessions';

export { PROJECT_CHANNELS, sortProjects } from './projects';
export type { DonelProjectsApi, ProjectInfo } from './projects';

export { SESSION_CHANNELS, TRANSCRIPT_CHANNELS } from './sessions';
export type { DonelSessionsApi, SessionSummaryDto, TranscriptChangedPayload } from './sessions';

export { PROFILE_CHANNELS, parseAccountNumber } from './profiles';
export type {
  DonelProfilesApi,
  JunctionIssueDto,
  ProfileDoctorReportDto,
  ProfileHeadroomMap,
  ProfileQuota,
  ProfileSummaryDto,
  QuotaWindow,
} from './profiles';

// T710 (007/CA-11 2º momento) — decisão de esquecer a entrada órfã quando a
// retomada falha. Puro; medição do sinal em specs/008-fechar-pendencias/.
export { RESUME_FAILURE_WINDOW_MS, forgetIfOrphan, resumedSessionIdFromArgs, shouldForgetOnResumeFailure } from './resumeFailure';
export type { ResumeFailureSignal } from './resumeFailure';

export { CONFIG_CHANNELS } from './config';
export type { AppConfigDto, DonelConfigApi, LauncherDefaultsDto, NotificationPreference, ProjectScanMode, SessionNamesMap } from './config';

// 003-modo-dev (T301/T307) — estado próprio do Modo Dev + canais `devMode:*`.
export {
  DEVMODE_CHANNELS,
  archivePhaseSession,
  archivedPhaseSessionKey,
  closeDiscovery,
  focusDiscovery,
  isArchivedSessionProfileMismatch,
  isValidArchivePhaseSessionIpcInput,
  isValidCardId,
  isValidCardIdList,
  isValidOpenDiscoveryIpcInput,
  isValidWatchPhaseIpcInput,
  linkDiscoveryRepo,
  openDiscovery,
} from './devMode';
export type {
  ArchivedPhaseSession,
  ArchivedPhaseSessions,
  ArchivePhaseSessionIpcInput,
  ArchivePhaseSessionKey,
  DevModeBoardConfig,
  DevModeDiscoveries,
  DevModeDiscovery,
  DevModeState,
  DonelDevModeApi,
  EsteiraPhase,
  OpenDiscoveryIpcInput,
  PhaseArchivedPayload,
  PhaseDefault,
  PhaseDefaultsTable,
  WatchPhaseIpcInput,
} from './devMode';

export { DEFAULT_PHASE_DEFAULTS, resolveCommandText } from './devModeDefaults';

// T307 — `DiscoveryTree` é o retorno de `devMode:readTree`; definido em
// `../main/discovery-tree.ts` (módulo com fs) mas reexportado aqui como TIPO
// só, para preload/renderer importarem de um lugar só (`../shared`), como
// todo o resto desta API. `import type` erasa no build: nenhum runtime do
// renderer/preload passa a depender de `node:fs`.
export type { ArtifactCandidate, ArtifactCandidateKind, DiscoveryTree, MarcoNode, PhaseNode } from '../main/discovery-tree';
/** T311/T327 — card da porta de entrada (CA-1) e os 4 fatos do espelho (CA-12); mesmo motivo do `DiscoveryTree` acima: tipo só, `import type` erasa no build. */
export type { BoardFacts, EntryColumn, EntryColumnCard } from '../main/taskdex-board-client';

/** T325/T326 (Batch C) — a árvore já anotada pelo espelho, consumida pela UI do mapa (T327/T328). */
export type { AnnotatedDiscoveryTree, AnnotatedMarcoNode, AnnotatedPhaseNode, PhaseDivergence } from './boardAnnotation';
export { annotateTree, detectPhaseDivergence } from './boardAnnotation';
export type { EsteiraResultManifest, PhaseArtifacts } from '../main/esteira-reader';
export type { PhaseStatus } from './phaseState';

// 004-nomear-sessoes — resolução do nome exibido de uma sessão (T401) e
// validação do nome digitado (T406). Usados no main (persistência) e no
// renderer (label da aba e da sidebar).
export {
  SESSION_NAME_MAX_LENGTH,
  extractCustomTitle,
  extractCustomTitleFromLine,
  normalizeSessionName,
  reconcileStoredName,
  resolveSessionName,
} from './sessionName';
export type { ResolveSessionNameInput, StoredSessionName } from './sessionName';

// 005-terminal-copy-paste (T502) — decisor puro tecla -> ação (copiar/colar/
// interromper por tipo de aba), usado pelo TerminalPane via
// `attachCustomKeyEventHandler`. Ver src/shared/terminalKeymap.ts.
export { IMAGE_PASTE_SEQUENCE, resolveTerminalKeyAction } from './terminalKeymap';
export type { TerminalKeyAction, TerminalKeyContext, TerminalKeyDescriptor } from './terminalKeymap';

/** Nomes dos canais IPC do domínio PTY (plan.md linha 37). */
export const PTY_CHANNELS = {
  create: 'pty:create',
  input: 'pty:input',
  resize: 'pty:resize',
  kill: 'pty:kill',
  data: 'pty:data',
  exit: 'pty:exit',
  preview: 'pty:preview',
} as const;

export interface PtyCreateOptions {
  /** Colunas iniciais (medidas pelo xterm/addon-fit no renderer). */
  cols: number;
  /** Linhas iniciais (medidas pelo xterm/addon-fit no renderer). */
  rows: number;
  /** Diretório de trabalho; default = home do usuário (T004 não tem contexto de projeto ainda). */
  cwd?: string;
  /**
   * 'shell' (default) = terminal livre (FR-008), spawna powershell.exe.
   * 'claude' (T005) = spawna o `claude` CLI direto no PTY (FR-006, plan.md
   * ponto 1) — o main process resolve o executável (PATH → fallback
   * `~/.local/bin/claude.exe`) e responde com erro CA-5 se não encontrar.
   */
  sessionType?: 'shell' | 'claude';
  /**
   * Argv extra do CommandBuilder (T008 — Launcher, FR-003/CA-1). Só tem
   * efeito quando `sessionType === 'claude'`; ignorado no terminal livre
   * (que sempre spawna `powershell.exe -NoLogo`, PtyManager.FREE_TERMINAL_ARGS).
   */
  args?: string[];
}

/**
 * Prefixo reconhecido pelo renderer (TerminalPane) para distinguir o erro
 * "claude não encontrado" (CA-5) de qualquer outra falha de `pty:create`.
 * Compartilhado entre main e renderer para não duplicar a string literal.
 */
export const CLAUDE_NOT_FOUND_PREFIX = 'CLAUDE_NOT_FOUND:';

/**
 * Extrai o caminho esperado de um erro de `pty:create` rejeitado com o
 * prefixo `CLAUDE_NOT_FOUND:<path>` (CA-5), ou null se não for esse erro.
 * Puro (sem React/DOM) — usado pelo TerminalPane e testável isoladamente.
 */
export function parseClaudeNotFound(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const markerIndex = message.indexOf(CLAUDE_NOT_FOUND_PREFIX);
  if (markerIndex < 0) return null;
  return message.slice(markerIndex + CLAUDE_NOT_FOUND_PREFIX.length).trim();
}

export interface PtyCreateResult {
  ptyId: string;
  /**
   * FIX (feedback E2E rodada 5) — perfil ATIVO no momento em que esta sessão
   * nasceu (main/index.ts `activeProfileSlug`/`activeProfileName`), o mesmo
   * valor por trás do `claudeConfigDir` passado a `PtyManager.create`
   * (T014/FR-005). Só preenchido pra `sessionType: 'claude'` — terminal
   * livre (shell) nunca aplica `CLAUDE_CONFIG_DIR`, então não tem "perfil de
   * nascimento" (App.tsx usa isso pra distinguir os dois casos no rótulo da
   * statusbar, ver `sessionAccountLabel.ts`). `undefined` também é o valor
   * legítimo de um `pty:create` de shell — não é "ainda não resolvido".
   */
  profile?: { slug: string; name: string };
  /**
   * T404 (004-nomear-sessoes) — id da sessão do Claude para ESTA aba, o mesmo
   * que nomeia o `.jsonl` do transcript. O app não descobre esse id: ele o
   * IMPÕE no spawn (`--session-id <uuid>`, `session-correlation.ts:24-34`),
   * reusando o id do `-r` quando é retomada. Até aqui ele nunca chegava ao
   * renderer por caminho nenhum (o `SemaphoreUpdate` só leva
   * `ptyId`/`state`/`stateEnteredAt`); devolvê-lo no create é o caminho mais
   * barato — sem canal novo, sem estado novo — e é o que permite ao renderer
   * persistir o nome da sessão (CA-6). Só para `sessionType: 'claude'`:
   * terminal livre não tem sessão de Claude, e por isso não persiste nome (C4).
   */
  claudeSessionId?: string;
}

export interface PtyExitInfo {
  exitCode: number;
  signal?: number;
}

/** API tipada exposta pelo preload em `window.donel.pty` (contextBridge). */
export interface DonelPtyApi {
  create(options: PtyCreateOptions): Promise<PtyCreateResult>;
  input(ptyId: string, data: string): void;
  resize(ptyId: string, cols: number, rows: number): void;
  kill(ptyId: string): void;
  /** Ring buffer de ~50 linhas (ANSI stripado) — plan.md ponto 8, hover-preview futuro. */
  getPreview(ptyId: string): Promise<string[]>;
  /** Retorna função de unsubscribe. */
  onData(ptyId: string, listener: (data: string) => void): () => void;
  /** Retorna função de unsubscribe. */
  onExit(ptyId: string, listener: (info: PtyExitInfo) => void): () => void;
}

/** Nomes dos canais IPC do domínio semáforo (T009, FR-010). */
export const SEMAPHORE_CHANNELS = {
  update: 'semaphore:update',
} as const;

/**
 * Estados do semáforo expostos pro renderer. Definido localmente em vez de
 * reimportar `SessionState` de `@donel-dev/design-system` — este arquivo é
 * compartilhado com o MAIN process, que não deve puxar um pacote de UI (o
 * index do design-system importa CSS/fontes como efeito colateral). Os
 * valores têm que continuar batendo com `SessionState` (StateDot.tsx) —
 * são só os mesmos 5 nomes.
 */
export type SemaphoreState = 'working' | 'waiting' | 'permission' | 'error' | 'done';

export interface SemaphoreUpdate {
  readonly ptyId: string;
  readonly state: SemaphoreState;
  /** Epoch ms de quando `state` passou a valer (ui-spec §3 "há Xmin"; FR-010/CA-6 desempate por idade em `permission`). */
  readonly stateEnteredAt: number;
}

/** Payload do listener FILTRADO por ptyId (mesmo padrão de `PtyExitInfo`/`pty.onExit` — o `ptyId` já é conhecido pelo chamador, não precisa vir de novo dentro do payload). */
export interface SemaphoreStateInfo {
  readonly state: SemaphoreState;
  readonly stateEnteredAt: number;
}

/** API tipada exposta pelo preload em `window.donel.semaphore` (contextBridge). */
export interface DonelSemaphoreApi {
  /** Retorna função de unsubscribe. Mesmo padrão de `pty.onData`/`pty.onExit`: um canal IPC só (broadcast de todas as sessões), filtrado por `ptyId` na borda do preload. */
  onUpdate(ptyId: string, listener: (info: SemaphoreStateInfo) => void): () => void;
}

/** Nomes dos canais IPC do domínio clipboard (T504, plan.md Fatia 2 — mesmo padrão de PTY_CHANNELS). */
export const CLIPBOARD_CHANNELS = {
  hasImage: 'clipboard:hasImage',
  readText: 'clipboard:readText',
  writeText: 'clipboard:writeText',
} as const;

/**
 * API tipada exposta pelo preload em `window.donel.clipboard` (contextBridge).
 * O clipboard de verdade (`electron.clipboard`) vive no main process
 * (`src/main/clipboard-bridge.ts`) — o renderer nunca o alcança direto
 * (`contextIsolation: true`, sem `nodeIntegration`; plan.md decisão 6, não
 * usar `navigator.clipboard`).
 */
export interface DonelClipboardApi {
  hasImage(): Promise<boolean>;
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface DonelApi {
  pty: DonelPtyApi;
  projects: DonelProjectsApi;
  semaphore: DonelSemaphoreApi;
  sessions: DonelSessionsApi;
  profiles: DonelProfilesApi;
  /** T015 — ConfigStore (FR-007/FR-009); ver src/shared/config.ts. */
  config: DonelConfigApi;
  /** T504 (005-terminal-copy-paste) — clipboard-bridge no main, atrás de IPC. */
  clipboard: DonelClipboardApi;
  /** T307 (003-modo-dev) — estado do Modo Dev + leitura da árvore do discovery. */
  devMode: DonelDevModeApi;
}
