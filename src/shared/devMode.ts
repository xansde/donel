// T301/T307 (003-modo-dev, Batch A) — modelo de estado do Modo Dev (CA-21/
// CA-22, plan.md §Modelo de dados) + canais IPC (`devMode:*`, T307).
//
// CA-21 ("um fato, um dono"): o estado próprio do app se limita ao que o
// disco/board NÃO sabem — discoveries abertos, qual está em foco, o vínculo
// discovery↔repo, os `session-id` arquivados (com o perfil em que rodaram) e a
// tabela de defaults do CA-4. Tudo mais é leitura (esteira-reader.ts,
// discovery-tree.ts, taskdex-board-client.ts).
//
// Funções puras: nenhuma toca I/O, nenhuma conhece Electron. Quem persiste
// (config-store.ts, T306) e quem chama pela IPC (main/index.ts, T307) fica de
// fora deste arquivo.

export type EsteiraPhase = 'discovery' | 'plano' | 'implementar' | 'validar' | 'concluir';

/** Um discovery = 1 card de entrada do board (Modelo de domínio da spec, MD-01). */
export interface DevModeDiscovery {
  readonly cardId: string; // = discoveryId
  readonly repoPath: string; // vínculo discovery ↔ repo (escolhido na criação, CA-21)
  readonly epicId: string | null;
  readonly openedAt: number;
  /** CA-23: marcado quando o gate de esteira-concluir de TODOS os marcos deu "success". */
  readonly closedAt: number | null;
}

export type DevModeDiscoveries = Readonly<Record<string, DevModeDiscovery>>;

/** CA-21 + CA-9: session-id arquivado por etapa concluída, com o perfil em que rodou (CA-22). */
export interface ArchivedPhaseSession {
  readonly sessionId: string;
  readonly profileSlug: string;
  readonly archivedAt: number;
}

/** Chave = `${cardId}:${marcoId}:${fase}` — uma entrada por etapa concluída. */
export type ArchivedPhaseSessions = Readonly<Record<string, ArchivedPhaseSession>>;

/** CA-4/C6 — fase → modelo, esforço e o TEXTO EXATO do comando a pré-digitar. */
export interface PhaseDefault {
  readonly model: 'fable' | 'opus' | 'sonnet' | 'haiku';
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** `{card_id}` é o único placeholder — substituído na hora de pré-digitar (devModeDefaults.ts). */
  readonly commandTemplate: string;
  /** C6, exceção da fase concluir: roda inline na sessão em foco, nunca spawna sessão própria. */
  readonly opensOwnSession: boolean;
}

export type PhaseDefaultsTable = Readonly<Record<EsteiraPhase, PhaseDefault>>;

/** CA-1 — um único board configurado; ausente = porta de entrada desligada. */
export interface DevModeBoardConfig {
  readonly workspaceId: string;
  readonly teamId: string;
}

export interface DevModeState {
  readonly discoveries: DevModeDiscoveries;
  readonly focusedDiscoveryId: string | null; // CA-21: "vários abertos, um em foco"
  readonly archivedPhaseSessions: ArchivedPhaseSessions;
  readonly phaseDefaults: PhaseDefaultsTable; // CA-4, editável
  readonly boardConfig: DevModeBoardConfig | null;
}

// ---------------------------------------------------------------------------
// Funções puras — cada uma um único fato mutado (CA-21). Nenhuma lança;
// entrada inválida (cardId/repoPath vazio, id inexistente) é no-op.
// ---------------------------------------------------------------------------

export interface OpenDiscoveryInput {
  readonly cardId: string;
  readonly repoPath: string;
  readonly epicId: string | null;
  readonly openedAt: number;
}

/**
 * Adiciona (ou substitui) a entrada do discovery. **Não mexe no foco** — abrir
 * um discovery novo não força foco nele; quem decide focar chama
 * `focusDiscovery` à parte (um fato, um dono). `cardId`/`repoPath` vazios são
 * no-op (porta de entrada desligada, não erro).
 */
export function openDiscovery(state: DevModeState, input: OpenDiscoveryInput): DevModeState {
  if (!input.cardId || !input.repoPath) return state;

  return {
    ...state,
    discoveries: {
      ...state.discoveries,
      [input.cardId]: {
        cardId: input.cardId,
        repoPath: input.repoPath,
        epicId: input.epicId,
        openedAt: input.openedAt,
        closedAt: null,
      },
    },
  };
}

/** Traz um discovery já aberto ao foco (CA-2/CA-21). No-op se `cardId` não tem discovery aberto. */
export function focusDiscovery(state: DevModeState, cardId: string): DevModeState {
  if (!(cardId in state.discoveries)) return state;
  if (state.focusedDiscoveryId === cardId) return state;
  return { ...state, focusedDiscoveryId: cardId };
}

/**
 * CA-23 — marca o encerramento (`closedAt`), sem remover a entrada (o passado
 * não é caso especial, C4). Limpa o foco se era o discovery em foco. No-op
 * para `cardId` inexistente.
 */
export function closeDiscovery(state: DevModeState, cardId: string, closedAt: number): DevModeState {
  const existing = state.discoveries[cardId];
  if (!existing) return state;

  return {
    ...state,
    discoveries: { ...state.discoveries, [cardId]: { ...existing, closedAt } },
    focusedDiscoveryId: state.focusedDiscoveryId === cardId ? null : state.focusedDiscoveryId,
  };
}

export interface ArchivePhaseSessionKey {
  readonly cardId: string;
  readonly marcoId: string;
  readonly phase: EsteiraPhase;
}

/** Monta a chave composta `cardId:marcoId:fase` usada em `archivedPhaseSessions`. */
export function archivedPhaseSessionKey(key: ArchivePhaseSessionKey): string {
  return `${key.cardId}:${key.marcoId}:${key.phase}`;
}

/** CA-6/CA-9 — registra o `session-id` (+ perfil, CA-22) da etapa recém-arquivada. */
export function archivePhaseSession(state: DevModeState, key: ArchivePhaseSessionKey, session: ArchivedPhaseSession): DevModeState {
  return {
    ...state,
    archivedPhaseSessions: {
      ...state.archivedPhaseSessions,
      [archivedPhaseSessionKey(key)]: session,
    },
  };
}

/**
 * CA-22 — retomar uma etapa arquivada num perfil diferente do ativo não
 * falha: só sinaliza. Puro, sem I/O; quem chama decide o aviso na UI.
 */
export function isArchivedSessionProfileMismatch(archived: ArchivedPhaseSession, activeProfileSlug: string): boolean {
  return archived.profileSlug !== activeProfileSlug;
}

/**
 * Corrige/atualiza o vínculo discovery↔repo (CA-21) de uma entrada já aberta.
 * No-op se o discovery não existe ou `repoPath` vazio.
 */
export function linkDiscoveryRepo(state: DevModeState, cardId: string, repoPath: string): DevModeState {
  const existing = state.discoveries[cardId];
  if (!existing || !repoPath) return state;

  return {
    ...state,
    discoveries: { ...state.discoveries, [cardId]: { ...existing, repoPath } },
  };
}

// ---------------------------------------------------------------------------
// T307 — IPC `devMode:*`. Canais + shapes de payload + validação PURA (o main
// só chama estas funções antes de mutar — "unit da validação de payload" do
// DoD da task). Nenhum canal de escrita para TaskDex ou vault entra aqui
// (invariante 5/CA-19) — checklist explícito, não código.
// ---------------------------------------------------------------------------

export const DEVMODE_CHANNELS = {
  get: 'devMode:get',
  openDiscovery: 'devMode:openDiscovery',
  focusDiscovery: 'devMode:focusDiscovery',
  closeDiscovery: 'devMode:closeDiscovery',
  archivePhaseSession: 'devMode:archivePhaseSession',
  getDefaults: 'devMode:getDefaults',
  setDefaults: 'devMode:setDefaults',
  readTree: 'devMode:readTree',
  // T311/T315 (Batch B) — os dois canais de LEITURA que a UI precisou e a
  // Fatia 1 ainda não tinha. `listEntryCards` é a consulta restrita da porta
  // de entrada (CA-1, colunas Backlog/Discovery/Plano de UM board);
  // `watchPhase`/`unwatchPhase`/`phaseArchived` ligam o watcher de manifesto
  // (T308/CA-6) ao renderer. **Nenhum deles escreve no board ou no vault**
  // (invariante 5/CA-19) — `watchPhase` só abre um `fs.watch` de leitura.
  listEntryCards: 'devMode:listEntryCards',
  watchPhase: 'devMode:watchPhase',
  unwatchPhase: 'devMode:unwatchPhase',
  phaseArchived: 'devMode:phaseArchived',
  // T327 (Batch D) — o ÚNICO canal novo da Fatia 2: leitura dos 4 fatos do
  // board (CA-12) para os cards do discovery em foco. Continua sem nenhum
  // canal de ESCRITA para TaskDex/vault (invariante 5/CA-14/CA-19).
  readBoardFacts: 'devMode:readBoardFacts',
} as const;

export interface OpenDiscoveryIpcInput {
  readonly cardId: string;
  readonly repoPath: string;
  readonly epicId: string | null;
}

/** `cardId`/`repoPath` vazios = payload inválido → o main faz no-op (CA-1: porta de entrada desligada, não erro). */
export function isValidOpenDiscoveryIpcInput(input: unknown): input is OpenDiscoveryIpcInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<OpenDiscoveryIpcInput>;
  return (
    typeof candidate.cardId === 'string' &&
    candidate.cardId.trim().length > 0 &&
    typeof candidate.repoPath === 'string' &&
    candidate.repoPath.trim().length > 0
  );
}

const ALL_ESTEIRA_PHASES: readonly EsteiraPhase[] = ['discovery', 'plano', 'implementar', 'validar', 'concluir'];

export interface ArchivePhaseSessionIpcInput {
  readonly cardId: string;
  readonly marcoId: string;
  readonly phase: EsteiraPhase;
  readonly sessionId: string;
  readonly profileSlug: string;
}

export function isValidArchivePhaseSessionIpcInput(input: unknown): input is ArchivePhaseSessionIpcInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<ArchivePhaseSessionIpcInput>;
  return (
    typeof candidate.cardId === 'string' &&
    candidate.cardId.trim().length > 0 &&
    typeof candidate.marcoId === 'string' &&
    candidate.marcoId.trim().length > 0 &&
    typeof candidate.phase === 'string' &&
    (ALL_ESTEIRA_PHASES as readonly string[]).includes(candidate.phase) &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.trim().length > 0 &&
    typeof candidate.profileSlug === 'string' &&
    candidate.profileSlug.trim().length > 0
  );
}

/** Usado por `focusDiscovery`/`closeDiscovery`/`readTree` — payload é só um `cardId`. */
export function isValidCardId(cardId: unknown): cardId is string {
  return typeof cardId === 'string' && cardId.trim().length > 0;
}

/** T327 — payload de `readBoardFacts`: a lista de cards do discovery EM FOCO (CA-12). Lista vazia é válida (nada a anotar), qualquer elemento inválido invalida o payload inteiro (main faz no-op). */
export function isValidCardIdList(input: unknown): input is readonly string[] {
  return Array.isArray(input) && input.every((cardId) => isValidCardId(cardId));
}

/** T315 — payload de `watchPhase`/`unwatchPhase`: qual etapa (do discovery em foco) o watcher de manifesto deve vigiar (CA-6). */
export interface WatchPhaseIpcInput {
  readonly discoveryCardId: string;
  readonly cardId: string;
  readonly marcoId: string;
  readonly phase: EsteiraPhase;
}

export function isValidWatchPhaseIpcInput(input: unknown): input is WatchPhaseIpcInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<WatchPhaseIpcInput>;
  return (
    typeof candidate.discoveryCardId === 'string' &&
    candidate.discoveryCardId.trim().length > 0 &&
    typeof candidate.cardId === 'string' &&
    candidate.cardId.trim().length > 0 &&
    typeof candidate.marcoId === 'string' &&
    candidate.marcoId.trim().length > 0 &&
    typeof candidate.phase === 'string' &&
    (ALL_ESTEIRA_PHASES as readonly string[]).includes(candidate.phase)
  );
}

/** T315 — evento empurrado pelo main quando o `<fase>-result.json` aparece com `status: "success"` (CA-6). */
export interface PhaseArchivedPayload {
  readonly discoveryCardId: string;
  readonly cardId: string;
  readonly marcoId: string;
  readonly phase: EsteiraPhase;
  readonly manifestPath: string;
}

/**
 * API tipada exposta pelo preload em `window.donel.devMode` (contextBridge).
 * Todos os canais devolvem o `AppConfigDto` inteiro (mesmo padrão de
 * `DonelConfigApi` — o renderer sincroniza um shape só), exceto `readTree`,
 * que devolve a árvore do discovery pedido (`DiscoveryTree`,
 * `../main/discovery-tree.ts` — importado só como TIPO: `import type` erasa
 * no build, o preload/renderer nunca puxam o módulo de disco em runtime).
 */
export interface DonelDevModeApi {
  get(): Promise<import('./config').AppConfigDto>;
  openDiscovery(input: OpenDiscoveryIpcInput): Promise<import('./config').AppConfigDto>;
  focusDiscovery(cardId: string): Promise<import('./config').AppConfigDto>;
  closeDiscovery(cardId: string): Promise<import('./config').AppConfigDto>;
  archivePhaseSession(input: ArchivePhaseSessionIpcInput): Promise<import('./config').AppConfigDto>;
  getDefaults(): Promise<import('./config').AppConfigDto>;
  setDefaults(defaults: PhaseDefaultsTable): Promise<import('./config').AppConfigDto>;
  readTree(cardId: string): Promise<import('../main/discovery-tree').DiscoveryTree>;
  /** CA-1 — cards das 3 colunas de entrada do board configurado; `[]` sem board/fonte (porta desligada, não erro). */
  listEntryCards(): Promise<readonly import('../main/taskdex-board-client').EntryColumnCard[]>;
  /** T327/CA-12 — os 4 fatos do board para os cards do discovery EM FOCO. Card sem fato some do mapa (espelho sem fonte é omissão, não erro). Leitura pura: nada é escrito no board. */
  readBoardFacts(cardIds: readonly string[]): Promise<Record<string, import('../main/taskdex-board-client').BoardFacts>>;
  /** CA-6 — liga o watcher do manifesto daquela etapa; idempotente por etapa. */
  watchPhase(input: WatchPhaseIpcInput): Promise<void>;
  unwatchPhase(input: WatchPhaseIpcInput): Promise<void>;
  /** CA-6 — push do main quando o manifesto de sucesso aparece. Devolve unsubscribe (mesmo padrão de `sessions.onTranscriptChanged`). */
  onPhaseArchived(listener: (payload: PhaseArchivedPayload) => void): () => void;
}
