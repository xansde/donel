import { ArmedPrompt, Button, Modal, SplitButton, StatusBar, TerminalTab, Toast, Toggle } from '@donel-dev/design-system';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppConfigDto,
  BoardFacts,
  DiscoveryTree,
  EntryColumnCard,
  EsteiraPhase,
  NotificationPreference,
  PhaseArchivedPayload,
  ProfileHeadroomMap,
  ProjectInfo,
  ProjectScanMode,
  SemaphoreStateInfo,
  SessionSummaryDto,
} from '../../shared';
import {
  buildClaudeArgs,
  DEFAULT_EFFORT_LEVEL,
  DEFAULT_MODEL_ALIAS,
  parseModelEffortFromArgs,
} from '../../shared/commandBuilder';
import type { EffortLevel, ModelAlias } from '../../shared/commandBuilder';
import { sortProjects } from '../../shared';
// T710 (007/CA-11 2º momento) — o sinal de "a retomada falhou" é o exit code do
// PTY (medido em specs/008-fechar-pendencias/medicao-t710.md), não texto de CLI.
import { resumedSessionIdFromArgs, shouldForgetOnResumeFailure } from '../../shared/resumeFailure';
import { computeSessionAccountLabel } from '../../shared/sessionAccountLabel';
// T709 (007) — pior estado do grupo (CA-6), mesma precedência de sortSessions.
import { sortSessions, worstState } from '../../shared/sessionOrdering';
// 007-favoritos-sessoes (T707/T709) — decisão pura de gravar uma visita
// (debounce de ~10s) e seleção do que aparece sob cada projeto favoritado
// (CA-2/CA-3); a UI só chama, a regra mora no shared.
import { selectProjectSessions, selectRegisteredIds, shouldRecordVisit } from '../../shared/sessionRegistry';
import { nextAttentionSessionId, sessionIdAtPosition } from '../../shared/sessionShortcuts';
// 004-nomear-sessoes (T401/T406/T408) — a regra de qual nome aparece e a
// validação do nome digitado moram no shared, iguais para main e renderer.
import {
  SESSION_NAME_MAX_LENGTH,
  normalizeSessionName,
  reconcileStoredName,
  resolveSessionName,
} from '../../shared/sessionName';
import { sessionTabName } from '../../shared/sessions';
// 003-modo-dev (Batch B) — Zonas 1/2/3 do Modo Dev. Toda a decisão pura
// (que sessão abrir, que sequência pré-digitar, quem focar, o que encerrar)
// vive nos módulos de `DevMode/`; aqui fica só o encanamento com PTY/IPC.
import { DEFAULT_PHASE_DEFAULTS } from '../../shared/devModeDefaults';
import { isReadyToPreType } from '../../shared/preTypeReadiness';
// 003-modo-dev (Batch D) — o espelho do board (CA-12/CA-13): anotação PURA em
// cima da árvore de disco. `annotateTree` não persiste nada e o app não tem
// canal de escrita para o TaskDex (invariante 5/CA-14).
import { annotateTree } from '../../shared/boardAnnotation';
import { DevModeEntry } from './DevMode/DevModeEntry';
import { DiscoveryMap, type SelectedPhaseNode } from './DevMode/DiscoveryMap';
import { PhaseButton } from './DevMode/PhaseButton';
import { discoveriesToClose, resolveEntrySelection } from './DevMode/devModeSelection';
import {
  LIBERAR_COMMAND_TEMPLATE,
  buildConciliationPrompt,
  createPrimeSequencer,
  decidePhaseOpen,
  resolveCommandSequence,
} from './DevMode/openPhaseSession';
import styles from './App.module.css';
import { Launcher } from './Launcher';
import type { LauncherLaunchOptions } from './Launcher';
import { Preferences } from './Preferences';
import { PreviousSessions } from './PreviousSessions';
import { ProfileSwitcher } from './ProfileSwitcher';
import { ProjectSidebar } from './ProjectSidebar';
import type { FavoriteProjectGroup, FavoriteSessionRow, SidebarSession } from './ProjectSidebar';
import { TerminalPane } from './TerminalPane';
import type { TerminalPaneHandle } from './TerminalPane';

// FIX (feedback E2E, batch 3 achado "notificar toda transição vira spam") —
// default conservador local, usado enquanto `appConfig` ainda não chegou de
// `window.donel.config.get()` (mesmo valor de config-store.ts
// `DEFAULT_NOTIFICATION_PREFERENCE`, duplicado aqui só como fallback de
// PRIMEIRO paint — nunca persistido a partir daqui).
const FALLBACK_NOTIFICATION_PREFERENCE: NotificationPreference = 'permission-only';

// T007 — sidebar real ligada ao ProjectScanner (FR-001, US-1): abrir um
// projeto pela sidebar cria (ou foca, se já aberta) uma aba de sessão claude
// com `cwd` no projeto. Todas as abas ficam montadas (visibilidade via CSS,
// não unmount) pra o PTY continuar vivo ao trocar de aba.
//
// T009 — o dot de estado (antes fixo em 'working') agora vem de verdade do
// semáforo (FR-010): cada TerminalPane assina `semaphore.onUpdate` pro seu
// próprio ptyId (só ele conhece esse id) e levanta o estado pra cá via
// `onStateChange`, indexado por `tab.id` (ver TerminalPane.tsx).
//
// T010 — ciclo de vida real (FR-006) + terminal livre (FR-008): fechar uma
// aba de verdade REMOVE ela de `tabs` (o unmount do TerminalPane cuida do
// teardown do PTY + dispose do xterm, ver TerminalPane.tsx); se o processo
// da aba estiver vivo (`aliveTabs`, sinal levantado por `onAliveChange`),
// pede confirmação antes (modal, ui-spec §2 "fechar aba com sessão ativa").
// Aba de terminal livre é só mais um `TabState` com `sessionType: 'shell'`.

interface TabState {
  id: string;
  /**
   * FALLBACK do nome da aba (004-nomear-sessoes, T408) — nome do projeto
   * quando aberta pela sidebar, `sessionTabName(preview)` quando reaberta.
   * Deixou de ser "o nome": o label exibido é `resolveSessionName(...)`, que
   * pode preferir o `custom-title` do CLI ou o nome dado na UI. Para aba
   * `shell` (sem sessão do Claude) este campo continua sendo o nome de fato,
   * só em memória (decisão C4).
   */
  name: string;
  /** cwd do PTY; undefined = home (aba inicial, sem projeto associado). */
  cwd?: string;
  projectName?: string;
  pinned: boolean;
  /** Argv do CommandBuilder (T008 — Launcher); undefined = sessão sem flags (abertura direta pela sidebar). */
  launchArgs?: string[];
  /** 'claude' (default) = sessão claude direta no PTY; 'shell' = terminal livre (FR-008, powershell.exe). */
  sessionType: 'claude' | 'shell';
  /**
   * T404/T408 — id da sessão do Claude desta aba (o mesmo que nomeia o
   * `.jsonl`), devolvido por `pty.create` e levantado pelo TerminalPane. É a
   * chave de persistência do nome (CA-6). `undefined` em aba `shell` e antes
   * da promise do create resolver.
   */
  claudeSessionId?: string;
  /**
   * T403/T408 — último `custom-title` conhecido desta sessão (o nome dado por
   * `/rename` no CLI). Vem do `SessionSummaryDto` quando a aba nasce de uma
   * sessão anterior; `null` numa sessão nova. É um dos insumos de
   * `resolveSessionName` e o que se carimba como `seenTitle` ao renomear.
   */
  customTitle?: string | null;
}

/** Último lançamento do Launcher — CA-1 (comando exato) + reaproveitado pelo corpo do "＋ Nova sessão" (ui-spec §2, zona 1). */
interface LastLaunch {
  args: string[];
  cwd: string;
  name: string;
}

// FIX (feedback E2E, decisão do Alexandre 2026-07-23, rodada 5 — "opção A") —
// antes havia uma aba "default" (id fixo, sem `cwd`) que spawnava `claude`
// direto em `os.homedir()` no boot do app. Causa raiz do bug reaberto no
// feedback-e2e.md (2 rodadas reprovadas): o CLI mostra o diálogo pré-REPL
// "Quick safety check" TODA vez que roda em `os.homedir()` (trust de pasta
// nunca é persistido pelo binário pra esse cwd), travando o semáforo em
// `undefined` até alguém responder o diálogo. A opção A elimina a causa raiz
// na raiz: o app nasce SEM nenhuma sessão aberta — zero PTY, zero CLI, zero
// diálogo — e mostra um empty state (ver `styles.emptyState` mais abaixo)
// com call-to-action pra abrir um projeto pela sidebar ou lançar uma sessão
// nova. Efeito colateral desejado: economiza cota/RAM a cada boot (nenhuma
// sessão claude sobe sem o usuário pedir). O MESMO empty state já cobria
// "todas as abas fechadas" (T010) — este caso deixa de ser um estado
// alcançável só por fechamento manual e passa a ser também o estado INICIAL.
const INITIAL_TABS: TabState[] = [];


// 003-modo-dev/T312 — teto de espera pelo sinal de "pronto para receber
// input" antes de pré-digitar (plan.md, tabela de riscos: "se não voltar a
// 'waiting' num teto, o app para no 1º passo e deixa a retomada manual —
// nunca força o 2º"). Mesma ordem de grandeza (e o mesmo motivo: rede de
// segurança de um sinal que pode nunca chegar) de `LIVE_INJECTION_TIMEOUT_MS`
// acima; separado de propósito porque são esperas de coisas diferentes.
const PRE_TYPE_READY_TIMEOUT_MS = 30_000;

/** Intervalo do re-teste da prontidão. Não é um "delay fixo até digitar": o gatilho continua sendo o SINAL (semáforo/buffer), este tick só garante reavaliar quando o sinal chega sem um chunk novo de PTY junto. */
const PRE_TYPE_POLL_MS = 250;

/** Chave de uma ETAPA (marco × fase) do discovery em foco — a mesma granularidade de `archivedPhaseSessions` (CA-21). */
function phaseKey(discoveryCardId: string, marcoId: string, phase: EsteiraPhase): string {
  return `${discoveryCardId}:${marcoId}:${phase}`;
}

/** Remove uma chave de um record sem mutar o original — usado ao limpar `semaphoreStates`/`aliveTabs` no fechamento de aba. */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [tabs, setTabs] = useState<TabState[]>(INITIAL_TABS);
  // '' = nenhuma aba em foco — estado válido agora que o boot pode nascer
  // sem nenhuma aba (decisão A, ver comentário de `INITIAL_TABS`); mesmo
  // sentinela que `closeTabImmediately` já usava pro caso "fechou a última
  // aba restante" (`remaining[0]` undefined -> `''`), reaproveitado aqui em
  // vez de introduzir um segundo significado pra "sem aba".
  const [activeTabId, setActiveTabId] = useState('');
  // "Herdado da seleção da sidebar" (ui-spec §4) — default do campo
  // Projeto-alvo do Launcher; segue o último projeto aberto pela sidebar.
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | undefined>(undefined);
  const [lastLaunch, setLastLaunch] = useState<LastLaunch | null>(null);
  // FIX (feedback E2E rodada 3 — "painel lateral 'Lançar sessão' fixo rouba
  // espaço e não parece produtivo") — o painel do Launcher deixa de ser
  // fixo: fechado por default (espaço vai pro terminal, ver
  // `styles.bodyPanelClosed`), abre só sob demanda (item "Sessão Claude" do
  // menu do "＋ Nova sessão", ver SplitButton abaixo), fecha ao lançar
  // (`handleLaunch`) ou Esc (efeito dedicado mais abaixo). O corpo do "＋
  // Nova sessão" CONTINUA lançando direto com a última config (T010,
  // `handleQuickNewClaudeSession`) sem depender do painel — isso não muda
  // (CA-1/smoke `profiles.spec.ts` já cobrem esse caminho).
  const [launcherOpen, setLauncherOpen] = useState(false);
  // Teste manual 27/07 — colapso das laterais pra focar no terminal: sidebar
  // (projetos/porta de entrada) e, no Modo Dev, o mapa da direita. Estado de
  // UI puro (não persiste no config de propósito).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // T015 — ConfigStore (FR-007): roots/notificação/defaults do launcher.
  // `null` até `window.donel.config.get()` resolver no boot (mesmo padrão de
  // `projects`/`loadingProjects` acima) — os consumidores abaixo caem em
  // fallbacks locais enquanto isso.
  const [appConfig, setAppConfig] = useState<AppConfigDto | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const tabIdCounter = useRef(0);
  // T014 — rótulo de conta pra Statusbar (ui-spec §2 zona 5), reportado pelo
  // ProfileSwitcher (que já busca `window.donel.profiles.*` pro dropdown do
  // titlebar — ver comentário de topo de ProfileSwitcher.tsx).
  const [accountLabel, setAccountLabel] = useState('Principal');
  // FIX (auditoria rodada 5, achado alta "regressão de cota") — mapa
  // COMPLETO de headroom (slug -> percent|null) reportado por
  // `ProfileSwitcher.onHeadroomChange`, alimentado só quando o dropdown de
  // perfis abre (FR-012). Usado por `activeSessionAccountLabel` abaixo pra
  // compor a cota do perfil de NASCIMENTO da sessão em foco — que pode ser
  // um perfil diferente do ativo global, por isso não dá pra reusar
  // `accountLabel` (que só carrega a cota do perfil ATIVO).
  const [profileHeadroom, setProfileHeadroom] = useState<ProfileHeadroomMap>({});
  // T009 — estado do semáforo por aba (chave = tab.id), alimentado pelo
  // callback que cada TerminalPane levanta via onStateChange.
  const [semaphoreStates, setSemaphoreStates] = useState<Record<string, SemaphoreStateInfo>>({});
  const previousSemaphoreStatesRef = useRef<Record<string, SemaphoreStateInfo>>({});
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  // T412 (004) — a assinatura do evento de transcript é ÚNICA e montada uma vez
  // só; sem esta ref ela leria o `appConfig` do primeiro render pra sempre.
  const appConfigRef = useRef(appConfig);
  appConfigRef.current = appConfig;
  // T707 (007) — mesma razão da ref acima: a assinatura de onTranscriptChanged
  // (gatilho 3 da visita, deps vazias) precisa do `tabs` ATUAL pra achar o cwd
  // da sessão que mudou, não o do primeiro render.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // T707 — debounce de ~10s POR SESSÃO (chave = claudeSessionId): última
  // gravação (epoch ms) + o que foi gravado, pra `shouldRecordVisit` decidir
  // sem reler o ConfigStore inteiro a cada turn.
  const visitWriteStateRef = useRef<Record<string, { lastWriteMs: number; label: string; projectPath: string }>>({});
  // T010 — FR-006: "aba ativa" (processo vivo) por tab.id, alimentado por
  // `onAliveChange` (TerminalPane.tsx). Decide se fechar a aba pede
  // confirmação (true) ou fecha direto (false/ausente — connecting sem PTY
  // ainda, ou já 'ended'/'claude-not-found').
  const [aliveTabs, setAliveTabs] = useState<Record<string, boolean>>({});
  // FIX (feedback E2E rodada 5) — epoch ms de quando cada aba ficou `alive`
  // pela ÚLTIMA vez (ref, não state — só alimenta o diagnóstico abaixo,
  // nunca o gate real de injeção). Usado por `possiblyBlockedOnPrompt` pra
  // saber "há quanto tempo esta sessão está viva sem NENHUM evento de hook
  // ainda" (ex.: diálogo de confiança de pasta bloqueando o CLI antes do
  // REPL — TerminalPane.tsx). Limpo em `closeTabImmediately` (mesmo padrão
  // de `semaphoreStates`/`aliveTabs`).
  const aliveSinceRef = useRef<Record<string, number>>({});
  // FIX (feedback E2E rodada 5) — perfil de NASCIMENTO de cada aba claude
  // (chave = tab.id), alimentado por `TerminalPane.onProfileResolved` uma
  // única vez por sessão (`PtyCreateResult.profile`, main/index.ts). Nunca
  // reescrito depois — trocar o perfil ATIVO global (ProfileSwitcher,
  // `accountLabel` abaixo) não deve alterar o que já está aqui (FR-005:
  // "afeta só sessões novas"). `undefined` = aba 'shell' OU ainda não
  // resolvido (`computeSessionAccountLabel` decide o rótulo pros dois
  // casos). Limpo em `closeTabImmediately` (mesmo padrão de `sessionModelEffort`).
  const [sessionProfiles, setSessionProfiles] = useState<Record<string, { slug: string; name: string } | undefined>>({});
  // T010 — aba com fechamento pendente de confirmação (modal "Fechar sessão?", ui-spec §2); null = nenhum modal aberto.
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  // T011 — modelo/esforço "atual" de cada aba claude (chave = tab.id), pro
  // controle da toolbar (SessionDetails) mostrar o valor certo pré-selecionado
  // e refletir a troca depois de uma injeção bem-sucedida. Semeado no
  // `addTab` (parseModelEffortFromArgs do launchArgs, se houver, senão os
  // defaults do Brief 3) — nunca undefined pra uma aba 'claude' já criada.
  // FIX (decisão A, 2026-07-23) — `INITIAL_TABS` nasce vazio agora (nenhuma
  // aba 'default' fora do `addTab`), então não há mais nenhum seed pra fazer
  // aqui: toda aba 'claude' passa por `addTab`, que já cuida disso sozinho.
  const [sessionModelEffort, setSessionModelEffort] = useState<Record<string, { model: ModelAlias; effort: EffortLevel }>>({});
  // T011 — handle imperativo de cada TerminalPane viva (ver TerminalPaneHandle):
  // ref callback comum, não state (não precisa re-render quando muda; o
  // próprio React já nula a entrada no unmount da aba).
  const terminalRefs = useRef<Record<string, TerminalPaneHandle | null>>({});
  // T610 (006) — tokens de contexto do último turn, chaveados por
  // **`sessionId`** (não `tab.id`): o watcher do main cobre TODA aba `claude`
  // viva, não existe "aba observada", e a mesma sessão retomada pode aparecer em
  // mais de uma aba — as duas mostram o mesmo número sem estado duplicado.
  // Preenchido pela assinatura ÚNICA de `onTranscriptChanged` (a mesma da 004,
  // logo abaixo); `undefined`/`null` = sem leitura ainda → a toolbar mostra `—`
  // (CA-4), nunca `0%`.
  const [contextTokens, setContextTokens] = useState<Record<string, number | null>>({});

  // T013 — PARTE PRINCIPAL (FR-004, CA-2): projeto cujo painel "Sessões
  // anteriores" está aberto (null = painel fechado); dispara o fetch via
  // `window.donel.sessions.list` no useEffect abaixo. Gatilho é um ícone
  // dedicado por linha da sidebar (ProjectSidebar `onShowPreviousSessions`),
  // não o clique no NOME do projeto — esse clique já tem um significado
  // fixo e testado (T007 smoke: abre uma sessão claude NOVA direto,
  // `handleOpenProject` abaixo) que este painel não pode sobrescrever.
  const [previousSessionsProject, setPreviousSessionsProject] = useState<ProjectInfo | null>(null);
  const [previousSessions, setPreviousSessions] = useState<SessionSummaryDto[]>([]);
  const [loadingPreviousSessions, setLoadingPreviousSessions] = useState(false);

  // === 003-modo-dev (Batch B) — estado da UI do Modo Dev ===================
  // Nada aqui é PERSISTIDO: o estado próprio do app (discoveries, foco,
  // arquivadas, defaults) vive no ConfigStore via `devMode:*` (CA-21). O que
  // está abaixo é só estado de TELA (modo ligado, o que está expandido, o
  // comando armado) — some no restart, e deve mesmo.
  const [devModeOn, setDevModeOn] = useState(false);
  const [entryCards, setEntryCards] = useState<readonly EntryColumnCard[]>([]);
  const [entryLoading, setEntryLoading] = useState(false);
  /** Árvore por discovery ABERTO (`devMode:readTree`) — disco puro, relida sob demanda. */
  const [discoveryTrees, setDiscoveryTrees] = useState<Record<string, DiscoveryTree>>({});
  /** T327/CA-12 — os 4 fatos do board por card do discovery EM FOCO. `{}` = espelho sem fonte: a árvore aparece inteira, só sem anotação. */
  const [boardFacts, setBoardFacts] = useState<Record<string, BoardFacts>>({});
  /** T327/CA-16 — trava a liberar, confirmada antes de pré-digitar `/esteira-liberar` (a confirmação fala em ETIQUETA no board, nunca em arquivo). */
  const [lockToRelease, setLockToRelease] = useState<{ marcoId: string; phase: EsteiraPhase; cardId: string } | null>(null);
  const [focusedMarcoId, setFocusedMarcoId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<SelectedPhaseNode | null>(null);
  /** CA-3 — o comando ESCRITO e não enviado, exibido pelo `ArmedPrompt`. */
  const [armedPrompt, setArmedPrompt] = useState<{ tabId: string; command: string; warning?: string } | null>(null);
  /** D4 — Toast informativo (troca de foco, avisos); nunca tem ação de desfazer. */
  const [devModeToast, setDevModeToast] = useState<string | null>(null);
  /** C4/T318 — artefato aberto no lugar de uma sessão (discovery antigo sem `session-id`). */
  const [openedArtifactPath, setOpenedArtifactPath] = useState<string | null>(null);
  /** Etapa (`discovery:marco:fase`) → `tab.id` da sessão daquela etapa. É o que o arquivamento (CA-6) usa para achar a aba certa. */
  const phaseTabsRef = useRef<Record<string, string>>({});
  /**
   * Hook só de teste (mesmo precedente de `launcher-last-command`, T008): o
   * argv real do `claude` é montado no main, e o smoke não tem como
   * inspecioná-lo a partir do renderer. Guarda a ÚLTIMA sessão aberta pelo
   * Modo Dev (argv da tabela do CA-4 + `cwd`, que na fase `implementar` é a
   * worktree do `ctx.md` — D3).
   */
  const [lastDevModeSession, setLastDevModeSession] = useState<{ args: readonly string[]; cwd: string } | null>(null);
  /** Cleanup do watcher de prontidão em voo por aba (mesmo padrão de `pendingInjectionWatchersRef`). */
  const armWatchersRef = useRef<Record<string, (() => void) | undefined>>({});
  const semaphoreStatesRef = useRef<Record<string, SemaphoreStateInfo>>({});
  semaphoreStatesRef.current = semaphoreStates;
  /** CA-22 — slug do perfil ATIVO agora (reportado pelo ProfileSwitcher, que já busca a lista). */
  const [activeProfileSlug, setActiveProfileSlug] = useState('principal');
  /** Mesma razão de `appConfigRef`/`tabsRef`: a assinatura de `onPhaseArchived` tem deps vazias e precisa do valor ATUAL. */
  const sessionProfilesRef = useRef<Record<string, { slug: string; name: string } | undefined>>({});
  sessionProfilesRef.current = sessionProfiles;

  const handleSemaphoreChange = useCallback((tabId: string, info: SemaphoreStateInfo): void => {
    setSemaphoreStates((prev) => ({ ...prev, [tabId]: info }));
  }, []);

  const handleAliveChange = useCallback((tabId: string, alive: boolean): void => {
    // FIX (feedback E2E rodada 5) — marca/limpa o instante em que a aba
    // ficou viva, pro diagnóstico `possiblyBlockedOnPrompt` abaixo (ver
    // `aliveSinceRef` acima). `if (alive)` sem checar valor anterior: uma
    // aba só transiciona pra `alive` a partir de 'connecting'/'ended', nunca
    // de 'running' pra 'running' de novo sem passar por um novo `spawnSession`
    // (TerminalPane useEffect [status.kind]), então não há risco de
    // sobrescrever um timestamp mais antigo com um mais novo indevidamente.
    if (alive) {
      aliveSinceRef.current[tabId] = Date.now();
    } else {
      delete aliveSinceRef.current[tabId];
    }
    setAliveTabs((prev) => (prev[tabId] === alive ? prev : { ...prev, [tabId]: alive }));
  }, []);

  // FIX (feedback E2E rodada 5) — grava o perfil de NASCIMENTO da aba uma
  // única vez (TerminalPane chama isto só uma vez por `spawnSession`, ver
  // comentário do prop) — nunca sobrescrito por uma troca de perfil ATIVO
  // global depois (isso é `accountLabel`/ProfileSwitcher, estado separado).
  const handleProfileResolved = useCallback((tabId: string, profile: { slug: string; name: string } | undefined): void => {
    setSessionProfiles((prev) => ({ ...prev, [tabId]: profile }));
  }, []);

  /**
   * T707 (007-favoritos-sessoes) — grava uma visita no registro (D9: "mantenha
   * registro durante o trabalho") quando `shouldRecordVisit` decidir que vale a
   * pena. `label`/`projectPath` já vêm resolvidos pelo chamador (`resolveTabName`/
   * `resolveSessionName`) — esta função só decide SE grava e faz o IPC. É o
   * ÚNICO escritor do registro (plan.md §Fatia 2) — o main só valida o payload.
   */
  const maybeRegisterVisit = useCallback((sessionId: string, projectPath: string, label: string): void => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;

    const nowMs = Date.now();
    const previousWrite = visitWriteStateRef.current[sessionId];
    const shouldWrite = shouldRecordVisit({
      lastWriteMs: previousWrite?.lastWriteMs,
      nowMs,
      previous: previousWrite ? { label: previousWrite.label, projectPath: previousWrite.projectPath } : null,
      next: { label: trimmedLabel, projectPath },
    });
    if (!shouldWrite) return;

    visitWriteStateRef.current[sessionId] = { lastWriteMs: nowMs, label: trimmedLabel, projectPath };
    void window.donel.sessions.registerVisit(sessionId, projectPath, trimmedLabel).then(setAppConfig).catch(() => undefined);
  }, []);

  // T708/CA-8 — semeadura única por projeto: `seedAttemptedRef` garante UMA
  // tentativa por projeto NESTA sessão do app, mesmo que `indexProjectSessions`
  // devolva `[]` de novo (projeto genuinamente sem sessão nenhuma) — sem isso,
  // o efeito abaixo tentaria de novo a cada render enquanto o registro
  // continuasse vazio. `seedingProjects` é só o estado de "carregando" da linha.
  const seedAttemptedRef = useRef<Set<string>>(new Set());
  const [seedingProjects, setSeedingProjects] = useState<ReadonlySet<string>>(new Set());

  const maybeSeedFavoriteProject = useCallback((projectPath: string): void => {
    if (seedAttemptedRef.current.has(projectPath)) return;
    seedAttemptedRef.current.add(projectPath);
    setSeedingProjects((prev) => new Set(prev).add(projectPath));
    void window.donel.sessions
      .seedProject(projectPath)
      .then(setAppConfig)
      .catch(() => undefined)
      .finally(() => {
        setSeedingProjects((prev) => {
          if (!prev.has(projectPath)) return prev;
          const next = new Set(prev);
          next.delete(projectPath);
          return next;
        });
      });
  }, []);

  // T708/CA-8 — dispara a semeadura pra todo projeto favoritado EXPANDIDO que
  // ainda não tem nenhuma entrada no registro (guarda dura real vive no main,
  // ver session-seed.ts — este efeito só evita a chamada óbvia).
  useEffect(() => {
    if (!appConfig) return;
    const collapsedSet = new Set(appConfig.collapsedFavorites);
    for (const project of projects) {
      if (!project.favorite || collapsedSet.has(project.path)) continue;
      const hasEntry = Object.values(appConfig.sessionRegistry).some((entry) => entry.projectPath === project.path);
      if (!hasEntry) maybeSeedFavoriteProject(project.path);
    }
  }, [projects, appConfig, maybeSeedFavoriteProject]);

  /** Cria uma aba nova, foca ela e devolve o id — usado por todo caminho de criação (sidebar, Launcher, "＋ Nova sessão", Terminal). */
  const addTab = (partial: Omit<TabState, 'id'>): string => {
    tabIdCounter.current += 1;
    const id = `tab-${tabIdCounter.current}`;
    setTabs((prev) => [...prev, { id, ...partial }]);
    setActiveTabId(id);
    // T011 — semeia o valor inicial da toolbar de Modelo/Esforço só pra
    // abas claude (terminal livre não tem os dois campos): lê de volta
    // `launchArgs` (Launcher, T008) quando a aba nasceu configurada; sem
    // isso (ex.: clique direto na sidebar), cai nos defaults do Brief 3.
    if (partial.sessionType === 'claude') {
      const parsed = parseModelEffortFromArgs(partial.launchArgs);
      setSessionModelEffort((prev) => ({
        ...prev,
        [id]: { model: parsed.model ?? DEFAULT_MODEL_ALIAS, effort: parsed.effort ?? DEFAULT_EFFORT_LEVEL },
      }));
    }
    return id;
  };

  // T010 — FR-006: fecha a aba de verdade (remove de `tabs`; o unmount do
  // TerminalPane cuida de matar o PTY + dispose do xterm, TerminalPane.tsx
  // `useEffect` cleanup). Se a aba fechada era a ativa, foca a vizinha
  // anterior (ou a próxima, se era a primeira); sem abas restantes, nenhuma
  // fica em foco.
  const closeTabImmediately = (tabId: string): void => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const remaining = tabs.filter((tab) => tab.id !== tabId);
    setTabs(remaining);
    if (activeTabId === tabId) {
      const fallback = remaining[Math.max(0, index - 1)] ?? remaining[0];
      setActiveTabId(fallback ? fallback.id : '');
    }
    setSemaphoreStates((prev) => omitKey(prev, tabId));
    setAliveTabs((prev) => omitKey(prev, tabId));
    delete aliveSinceRef.current[tabId]; // FIX (feedback E2E rodada 5) — mesmo padrão de limpeza dos maps acima.
    setSessionProfiles((prev) => omitKey(prev, tabId)); // FIX (feedback E2E rodada 5) — idem.
    setSessionModelEffort((prev) => omitKey(prev, tabId));
    delete terminalRefs.current[tabId];
    // 003-modo-dev/T312 — nenhum watcher de prontidão sobrevive à aba que ele
    // vigiava (senão tentaria escrever num PTY que já não existe).
    armWatchersRef.current[tabId]?.();
    delete armWatchersRef.current[tabId];
    setArmedPrompt((prev) => (prev?.tabId === tabId ? null : prev));
  };

  /**
   * 003-modo-dev/T315 — a assinatura de `devMode:phaseArchived` é montada uma
   * vez só (deps vazias) e precisa da versão ATUAL de `closeTabImmediately`
   * (que lê `tabs`/`activeTabId` do render corrente). Mesmo padrão de
   * `appConfigRef`/`tabsRef`.
   */
  const closeTabImmediatelyRef = useRef(closeTabImmediately);
  closeTabImmediatelyRef.current = closeTabImmediately;

  // T010 — FR-006: "se a sessão estiver ativa (processo vivo), pede
  // confirmação" — senão fecha direto (ex.: aba já em 'ended'/'claude-not-found').
  // Função simples (não useCallback) de propósito: lê `aliveTabs`/`tabs`/
  // `activeTabId` direto do escopo do render, mesmo padrão de
  // `handleOpenProject`/`handleLaunch` logo acima.
  const handleRequestCloseTab = (tabId: string): void => {
    if (aliveTabs[tabId]) {
      setPendingCloseTabId(tabId);
      return;
    }
    closeTabImmediately(tabId);
  };

  const handleConfirmCloseTab = (): void => {
    if (pendingCloseTabId) closeTabImmediately(pendingCloseTabId);
    setPendingCloseTabId(null);
  };

  const handleCancelCloseTab = (): void => {
    setPendingCloseTabId(null);
  };

  useEffect(() => {
    let cancelled = false;
    setLoadingProjects(true);
    window.donel.projects
      .list()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        // Scan/config falhando não pode travar o shell — sidebar mostra a
        // seção "Projetos" vazia (mesmo texto do caso "nenhum projeto
        // encontrado"); T017 cobre o "Não verificado" de erro real de disco.
        if (!cancelled) setProjects([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // T015 — carrega o ConfigStore uma vez no boot (roots/notificação/defaults
  // do launcher). Falha de IPC aqui não trava o shell (mesmo espírito do
  // catch de `projects.list` acima) — os consumidores seguem nos fallbacks
  // locais até uma próxima mutação bem-sucedida repor `appConfig`.
  useEffect(() => {
    let cancelled = false;
    window.donel.config
      .get()
      .then((config) => {
        if (!cancelled) setAppConfig(config);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenProject = (project: ProjectInfo): void => {
    setSelectedProjectPath(project.path);
    const existing = tabs.find((tab) => tab.cwd === project.path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    addTab({ name: project.name, cwd: project.path, projectName: project.name, pinned: false, sessionType: 'claude' });
  };

  // T013 — PARTE PRINCIPAL (FR-004, CA-2, ui-spec §5): abre o painel
  // "Sessões anteriores" pro projeto clicado; o fetch de verdade acontece no
  // useEffect abaixo (dispara em CIMA de `previousSessionsProject`, não
  // duplicado aqui) — mesmo padrão do fetch de `projects` no useEffect de
  // boot logo acima.
  const handleShowPreviousSessions = (project: ProjectInfo): void => {
    setPreviousSessionsProject(project);
  };

  const handleClosePreviousSessions = (): void => {
    setPreviousSessionsProject(null);
  };

  useEffect(() => {
    if (!previousSessionsProject) {
      setPreviousSessions([]);
      return undefined;
    }
    let cancelled = false;
    setLoadingPreviousSessions(true);
    window.donel.sessions
      .list(previousSessionsProject.path)
      .then((list) => {
        if (!cancelled) setPreviousSessions(list);
      })
      .catch(() => {
        // SessionIndexer (main) nunca lança pra caso normal (projeto sem
        // sessão vira `[]`) — um catch aqui só cobre uma falha de IPC de
        // verdade; o painel mostra o empty state em vez de travar (mesmo
        // espírito do catch de `projects.list` no boot).
        if (!cancelled) setPreviousSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPreviousSessions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previousSessionsProject]);

  // T013 — Retomar (ui-spec §5, primário): `-r <session-id>` via
  // CommandBuilder (já testado no T006/CommandBuilder.test.ts, tabela
  // FR-003) — CONTINUA a mesma sessão (mesmo id). Nome da aba vem do
  // preview (sessionTabName, shared/sessions.ts) — mais informativo que só
  // o uuid do arquivo.
  const handleResumeSession = (session: SessionSummaryDto): void => {
    if (!previousSessionsProject) return;
    const args = buildClaudeArgs({ continuation: { type: 'resume', sessionId: session.id } });
    addTab({
      name: sessionTabName(session),
      cwd: previousSessionsProject.path,
      projectName: previousSessionsProject.name,
      pinned: false,
      launchArgs: args,
      sessionType: 'claude',
      // T403/T408 (004) — o `/rename` que esta sessão levou no CLI já veio no
      // índice; semeado aqui, `resolveSessionName` prefere ele ao preview (CA-1).
      customTitle: session.customTitle,
    });
    setSelectedProjectPath(previousSessionsProject.path);
    setPreviousSessionsProject(null);
  };

  // T013 — Fork (ui-spec §5, secundário, "nova sessão a partir desta"):
  // `-r <session-id> --fork-session` — confirmado em `claude --help` (flag
  // real: "When resuming, create a new session ID instead of reusing the
  // original (use with --resume or --continue)") — cria uma sessão com ID
  // NOVO a partir do histórico da original, que continua intacta.
  const handleForkSession = (session: SessionSummaryDto): void => {
    if (!previousSessionsProject) return;
    const args = buildClaudeArgs({ continuation: { type: 'fork', sessionId: session.id } });
    addTab({
      name: sessionTabName(session),
      cwd: previousSessionsProject.path,
      projectName: previousSessionsProject.name,
      pinned: false,
      launchArgs: args,
      sessionType: 'claude',
      // T403/T408 (004) — o `/rename` que esta sessão levou no CLI já veio no
      // índice; semeado aqui, `resolveSessionName` prefere ele ao preview (CA-1).
      customTitle: session.customTitle,
    });
    setSelectedProjectPath(previousSessionsProject.path);
    setPreviousSessionsProject(null);
  };

  // T008 — Launcher (ui-spec §4, FR-003, CA-1): monta o argv via
  // buildClaudeArgs (CommandBuilder puro, T006) e abre uma aba NOVA (o
  // Launcher é lançamento configurado, distinto do clique direto no nome do
  // projeto acima, que reaproveita/foca uma aba existente com defaults).
  const handleLaunch = (options: LauncherLaunchOptions): void => {
    const args = buildClaudeArgs({
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      sessionName: options.sessionName || undefined,
    });
    const name = options.sessionName || options.projectName;
    addTab({ name, cwd: options.projectPath, projectName: options.projectName, pinned: false, launchArgs: args, sessionType: 'claude' });
    setSelectedProjectPath(options.projectPath);
    setLastLaunch({ args, cwd: options.projectPath, name });
    // T015 (FR-007 "defaults do launcher") — cada lançamento configurado vira
    // o default do PRÓXIMO Launcher aberto (mesmo espírito de "lembra a
    // última config" que o corpo do "＋ Nova sessão" já tinha via
    // `lastLaunch` em memória — agora persistido, sobrevive a restart).
    void window.donel.config
      .setLauncherDefaults({ model: options.model, effort: options.effort, permissionMode: options.permissionMode })
      .then(setAppConfig)
      .catch(() => undefined);
    // FIX (feedback E2E rodada 3) — painel colapsável: "fecha ao lançar".
    setLauncherOpen(false);
  };

  // T010 — corpo do "＋ Nova sessão" (ui-spec §2, zona 1): "clique no corpo
  // abre direto com a última configuração de sessão Claude usada" (também o
  // item de menu "Sessão Claude" — mesma ação, dois gatilhos). Sem
  // lançamento anterior nesta sessão do app, cai pros defaults do Launcher
  // (sem args explícitos = CommandBuilder omite tudo, T006) no projeto
  // selecionado.
  //
  // FIX (auditoria rodada 6 ciclo 2, achado media "CTA do titlebar reproduz
  // o bug do empty state em 1 clique") — ANTES este era o handler "cru": sem
  // `lastLaunch` e sem `selectedProjectPath` (exatamente o estado de boot),
  // caía em `cwd: undefined` -> `pty-manager.ts` `options.cwd ??
  // os.homedir()` -> o "Quick safety check" preso, semáforo `undefined` pra
  // sempre. Só o CTA do empty state (`handleEmptyStateNewSession`, agora
  // removido) tinha o guard — o botão do titlebar, visível na MESMA tela e
  // fisicamente ao lado do empty state, continuava reproduzindo o defeito
  // original a um clique. Guard movido pra CÁ: os dois gatilhos (corpo do
  // "＋ Nova sessão" do titlebar E o CTA "Nova sessão" do empty state, que
  // agora chama esta mesma função) passam a abrir o Launcher quando não há
  // nenhum lançamento/projeto anterior, em vez de spawnar em home sem
  // confiança de pasta — um handler só, sem cenário travado alcançável por
  // nenhum caminho da UI. `terminal.spec.ts`/`profiles.spec.ts`/
  // `shell.spec.ts` foram atualizados pra escolher um projeto no Launcher
  // (não reproduzem mais o cenário "sessão em home sem projeto", que deixou
  // de ser alcançável de propósito).
  const handleQuickNewClaudeSession = (): void => {
    if (!lastLaunch && !selectedProjectPath) {
      setLauncherOpen(true);
      return;
    }
    if (lastLaunch) {
      addTab({
        name: lastLaunch.name,
        cwd: lastLaunch.cwd,
        projectName: projects.find((project) => project.path === lastLaunch.cwd)?.name,
        pinned: false,
        launchArgs: lastLaunch.args,
        sessionType: 'claude',
      });
      return;
    }
    const project = projects.find((candidate) => candidate.path === selectedProjectPath);
    addTab({
      name: project?.name ?? 'Nova sessão',
      cwd: selectedProjectPath,
      projectName: project?.name,
      pinned: false,
      sessionType: 'claude',
    });
  };

  // T010 — FR-008: aba de terminal comum (powershell.exe) no diretório do
  // projeto selecionado — item "Terminal" do menu do "＋ Nova sessão".
  const handleNewFreeTerminal = (): void => {
    const project = projects.find((candidate) => candidate.path === selectedProjectPath);
    addTab({ name: 'Terminal', cwd: selectedProjectPath, projectName: project?.name, pinned: false, sessionType: 'shell' });
  };

  // FIX (feedback E2E rodada 3 — "favoritar projeto só reflete após
  // reiniciar o app") — causa raiz: `listProjectsWithFavorites` (main)
  // refaz um `scanProjects` SÍNCRONO do filesystem a cada toggle (não só a
  // primeira vez); com vários repos sob os roots configurados, esse
  // round-trip pode não ser instantâneo o bastante pra parecer "reflete na
  // hora" — mesmo a lógica de merge/ordenação (`mergeFavorites`/
  // `sortProjects`) já estando correta e testada (não era bug de lógica).
  // Fix: atualiza `projects` OTIMISTICAMENTE aqui — mesma função
  // `sortProjects` que o main usa (agora compartilhada, `shared/projects.ts`)
  // — a estrela e a reordenação já aparecem no próprio clique, sem esperar
  // o IPC. `setProjects` no `.then()` continua reconciliando com a resposta
  // autoritativa do main (persistência real, `missing`/favoritos de outros
  // projetos que só o scan do main conhece).
  //
  // `favoriteRequestIdRef` — achado do PRÓPRIO smoke deste fix
  // (tests/smoke/sidebar-favorites.spec.ts, 2 cliques em sequência rápida:
  // favoritar → desfavoritar): sem isso, dois `setFavorite` em voo ao mesmo
  // tempo podem RESOLVER fora de ordem (o scan síncrono do main não garante
  // que quem foi chamado primeiro responde primeiro) — a resposta do
  // clique MAIS ANTIGO chegando DEPOIS da do mais recente sobrescrevia o
  // estado certo com um snapshot obsoleto. Só aplica `setProjects` da
  // resposta cujo id ainda é o mais recente disparado.
  const favoriteRequestIdRef = useRef(0);
  const handleToggleFavorite = (path: string, favorite: boolean): void => {
    setProjects((prev) => sortProjects(prev.map((project) => (project.path === path ? { ...project, favorite } : project))));
    const requestId = (favoriteRequestIdRef.current += 1);
    void window.donel.projects
      .setFavorite(path, favorite)
      .then((list) => {
        if (requestId !== favoriteRequestIdRef.current) return; // resposta obsoleta — um toggle mais novo já rodou depois deste
        setProjects(list);
      })
      .catch(() => undefined);
  };

  // T708 (007) — colapsar/expandir o grupo "Favoritos" de um projeto; estado
  // persiste (CA-1). Substitui a lista INTEIRA (mesmo padrão de `setFavorite`
  // acima) — poucos favoritos, sem necessidade de um canal incremental.
  const handleToggleFavoriteGroupCollapsed = (projectPath: string): void => {
    const current = new Set(appConfig?.collapsedFavorites ?? []);
    if (current.has(projectPath)) current.delete(projectPath);
    else current.add(projectPath);
    void window.donel.config.setCollapsedFavorites([...current]).then(setAppConfig).catch(() => undefined);
  };

  /**
   * T710 (007) — CA-4: clique numa linha do grupo "Favoritos". Se já existe
   * uma aba aberta com esse `claudeSessionId`, FOCA (nunca abre a mesma sessão
   * duas vezes); senão retoma pelo mesmo caminho de `handleResumeSession`
   * (`-r <id>`). Entrada que já sumiu do registro (órfã removida por outro
   * caminho) é no-op — nada a focar nem a retomar.
   */
  const handleFocusOrResumeFavoriteSession = (sessionId: string): void => {
    const existingTab = tabs.find((tab) => tab.claudeSessionId === sessionId);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    const entry = appConfig?.sessionRegistry[sessionId];
    if (!entry) return;

    const project = projects.find((candidate) => candidate.path === entry.projectPath);
    const args = buildClaudeArgs({ continuation: { type: 'resume', sessionId } });
    addTab({
      name: entry.label,
      cwd: entry.projectPath,
      projectName: project?.name,
      pinned: false,
      launchArgs: args,
      sessionType: 'claude',
      customTitle: null,
    });
    setSelectedProjectPath(entry.projectPath);
  };

  /**
   * T710 (007) — CA-11, **2º momento**: "perceber" que a sessão sumiu quando uma
   * tentativa de RETOMAR aquela sessão falha.
   *
   * O sinal é o exit code, não o texto do CLI — medido contra o binário real em
   * `specs/008-fechar-pendencias/medicao-t710.md`: no PTY, `claude -r <uuid
   * inexistente>` sai com código 1 em ~8,5–10,4 s, enquanto sessão válida e
   * sessão nova seguem vivas. A decisão vive em `shared/resumeFailure.ts`
   * (puro, testado), e a PROVA antes de apagar é do main: ele confere o `.jsonl`
   * e só remove se não existir (`sessions:forgetIfOrphan`) — por isso um exit
   * != 0 de outra origem (cota, `claude` não encontrado, Ctrl+C precoce) não
   * apaga nada. Sem aviso na tela, como o CA-11 pede.
   */
  const handleTabProcessExit = (tab: TabState, info: { exitCode: number | undefined; msSinceSpawn: number }): void => {
    const resumedSessionId = resumedSessionIdFromArgs(tab.launchArgs);
    if (!resumedSessionId) return; // sessão nova nunca é candidata
    if (!shouldForgetOnResumeFailure({ resumedSessionId, exitCode: info.exitCode, msSinceSpawn: info.msSinceSpawn })) return;
    void window.donel.sessions
      .forgetIfOrphan(resumedSessionId)
      .then(setAppConfig)
      .catch(() => undefined);
  };

  /**
   * T710/C2 (007) — CA-5: UM gesto de pin na linha do grupo. Persiste no
   * registro (`sessions:setPinned`) E, se a sessão tem aba aberta agora,
   * também atualiza `TabState.pinned` — é o que continua alimentando
   * `sortSessions`/o desempate da lista geral (comportamento de hoje
   * preservado, C2: "nada de dois pins parecidos").
   */
  const handleToggleFavoriteSessionPinned = (sessionId: string): void => {
    const entry = appConfig?.sessionRegistry[sessionId];
    const nextPinned = !(entry?.pinned ?? false);
    void window.donel.sessions.setPinned(sessionId, nextPinned).then(setAppConfig).catch(() => undefined);

    const openTab = tabs.find((tab) => tab.claudeSessionId === sessionId);
    if (openTab) updateTab(openTab.id, { pinned: nextPinned });
  };

  // T015 — UI de Preferências (FR-007, feedback E2E rodada 3 "roots
  // configuráveis"): substitui a lista INTEIRA de roots no ConfigStore
  // (main/index.ts `sanitizeProjectRoots` descarta vazio/duplicata) e
  // refaz o scan de projetos em seguida — "re-scan imediato" pedido pelo
  // feedback, sem esperar um restart.
  const refreshProjectsAfterRootsChange = (): void => {
    void window.donel.projects.list().then(setProjects).catch(() => undefined);
  };

  const handleAddProjectRoot = (root: string): void => {
    const currentRoots = appConfig?.projectRoots ?? [];
    void window.donel.config
      .setProjectRoots([...currentRoots, root])
      .then((config) => {
        setAppConfig(config);
        refreshProjectsAfterRootsChange();
      })
      .catch(() => undefined);
  };

  const handleRemoveProjectRoot = (root: string): void => {
    const currentRoots = appConfig?.projectRoots ?? [];
    void window.donel.config
      .setProjectRoots(currentRoots.filter((existing) => existing !== root))
      .then((config) => {
        setAppConfig(config);
        refreshProjectsAfterRootsChange();
      })
      .catch(() => undefined);
  };

  // FIX (feedback E2E rodada 4, batch 3 achado "notificar toda transição
  // vira spam") — preferência configurável (all/permission-only/none),
  // aplicada pelo efeito de notificação mais abaixo.
  const handleChangeNotificationPreference = (preference: NotificationPreference): void => {
    void window.donel.config.setNotificationPreference(preference).then(setAppConfig).catch(() => undefined);
  };

  // FIX ambiente genérico (28/07) — troca do critério da listagem re-escaneia
  // na hora, mesmo espírito instantâneo do add/remove de root.
  const handleChangeProjectScanMode = (mode: ProjectScanMode): void => {
    void window.donel.config
      .setProjectScanMode(mode)
      .then((config) => {
        setAppConfig(config);
        refreshProjectsAfterRootsChange();
      })
      .catch(() => undefined);
  };

  /**
   * T408 (004) — update parcial de UMA aba. Antes existia só o `.map` inline
   * do pin; com nome, `claudeSessionId` e `customTitle` chegando, virariam
   * três `.map` espalhados fazendo a mesma coisa. O pin passou a usar este
   * (`handleTogglePin` abaixo), então há um caminho só de mutação de aba.
   */
  const updateTab = useCallback((tabId: string, partial: Partial<Omit<TabState, 'id'>>): void => {
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, ...partial } : tab)));
  }, []);

  const handleTogglePin = (tabId: string): void => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    updateTab(tabId, { pinned: !tab.pinned });
  };

  /**
   * T408 (004) — CA-3: renomear pela aba ou pela linha da sidebar. Dois
   * caminhos, por decisão do clarify:
   * - aba `claude`: persiste no ConfigStore via `sessions:setName` (CA-6), com
   *   `seenTitle` = o `custom-title` que esta aba conhece agora (dirty-check
   *   do C2). Vazio APAGA a entrada e o nome volta ao fallback (C5).
   * - aba `shell` (ou aba cujo create ainda não resolveu): só memória, em
   *   `tab.name` — não há `sessionId` onde persistir (C4). Nesse caso um nome
   *   vazio é ignorado: sem entrada no store, não existe fallback para onde
   *   voltar, e uma aba sem rótulo nenhum não é um estado útil.
   */
  const handleRenameTab = (tabId: string, rawName: string): void => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;

    const normalized = normalizeSessionName(rawName);

    if (tab.sessionType !== 'claude' || !tab.claudeSessionId) {
      if (normalized === null) return;
      updateTab(tabId, { name: normalized });
      return;
    }

    void window.donel.sessions
      .setName(tab.claudeSessionId, rawName, tab.customTitle ?? null)
      .then((config) => {
        setAppConfig(config);
        // T707 (007) — gatilho 2: rename muda o rótulo. `config` já tem o
        // `sessionNames` fresco desta escrita — mais preciso que reler o
        // estado `appConfig` (ainda não re-renderizou).
        if (tab.cwd && tab.claudeSessionId) {
          const resolvedLabel = resolveSessionName({
            fallback: tab.name,
            customTitle: tab.customTitle ?? null,
            stored: config.sessionNames[tab.claudeSessionId] ?? null,
          });
          maybeRegisterVisit(tab.claudeSessionId, tab.cwd, resolvedLabel);
        }
      })
      .catch(() => undefined);
  };

  /**
   * T412 (004) — CA-4: o `/rename` digitado no CLI reflete na aba/sidebar em
   * menos de 1 s, sem reabrir a sessão. UMA assinatura para TODAS as abas (o
   * watcher do main já cobre toda aba `claude` viva e o payload traz o
   * `sessionId`) — e é aqui que o "CLI vence" do C2 finalmente fecha: quando o
   * título novo difere do `seenTitle` gravado, a entrada da UI é DESCARTADA,
   * em vez de ficar um nome morto competindo no storage (`reconcileStoredName`).
   *
   * Deps vazias de propósito: a assinatura é montada uma vez e lê estado atual
   * por ref. O `unsubscribe` remove só o próprio listener (preload usa
   * `removeListener` com a mesma função), então o double-invoke do StrictMode
   * não deixa listener órfão nem cancela o da montagem nova.
   */
  useEffect(() => {
    const unsubscribe = window.donel.sessions.onTranscriptChanged(({ sessionId, customTitle, contextTokens: tokens }) => {
      // Chave é o `sessionId`, não o `tabId` — daí o `.map` próprio em vez do
      // `updateTab`. Uma mesma sessão retomada pode estar em mais de uma aba.
      setTabs((prev) =>
        prev.map((tab) => (tab.claudeSessionId === sessionId ? { ...tab, customTitle } : tab)),
      );

      // T610 (006) — MESMA assinatura, MESMO evento: a 006 só lê o segundo campo
      // do payload. Abrir uma segunda assinatura aqui era risco nomeado na
      // tabela de riscos do tasks.md (dois listeners no mesmo canal, um deles
      // órfão no double-invoke do StrictMode).
      setContextTokens((prev) => (prev[sessionId] === tokens ? prev : { ...prev, [sessionId]: tokens }));

      const stored = appConfigRef.current?.sessionNames[sessionId] ?? null;
      const cliWins = !!stored && reconcileStoredName(stored, customTitle) === null;
      if (cliWins) {
        // Nome vazio = apagar a entrada (mesmo canal do C5, sem inventar outro).
        void window.donel.sessions.setName(sessionId, '', null).then(setAppConfig).catch(() => undefined);
      }

      // T707 (007) — gatilho 3: "durante o trabalho" do D9. `tabsRef` (não
      // `tabs`) porque esta assinatura tem deps vazias (montada uma vez só,
      // mesmo motivo do `appConfigRef` acima). `stored: null` quando o CLI
      // acabou de vencer (a entrada já foi limpa acima) — sem isso o rótulo
      // gravado usaria um nome que já deixou de valer.
      const matchingTab = tabsRef.current.find((tab) => tab.claudeSessionId === sessionId);
      if (matchingTab?.cwd) {
        const label = resolveSessionName({ fallback: matchingTab.name, customTitle, stored: cliWins ? null : stored });
        maybeRegisterVisit(sessionId, matchingTab.cwd, label);
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =========================================================================
  // 003-modo-dev (Batch B) — Zonas 1/2/3
  //
  // INVARIANTE 2 (CA-3): o único ponto deste bloco que escreve no PTY é
  // `armPhaseCommands` abaixo, via `TerminalPaneHandle.injectCommand`, com o
  // texto EXATO devolvido por `resolveCommandSequence` — nunca com `\r`/`\n`
  // concatenado. O Enter é sempre gesto humano.
  // =========================================================================

  const devModeState = appConfig?.devMode;
  const focusedDiscoveryId = devModeState?.focusedDiscoveryId ?? null;
  const focusedDiscovery = focusedDiscoveryId ? (devModeState?.discoveries[focusedDiscoveryId] ?? null) : null;
  const rawFocusedTree = focusedDiscoveryId ? (discoveryTrees[focusedDiscoveryId] ?? null) : null;
  /**
   * T327/CA-12 — a MESMA árvore de disco, com os 4 fatos do board sobrepostos.
   * `annotateTree` é puro: não persiste nada e ignora qualquer card que não
   * seja marco desta árvore ("nunca cards fora do discovery em foco").
   */
  const focusedTree = useMemo(
    () => (rawFocusedTree ? annotateTree(rawFocusedTree, boardFacts) : null),
    [rawFocusedTree, boardFacts],
  );
  const phaseDefaults = devModeState?.phaseDefaults ?? DEFAULT_PHASE_DEFAULTS;
  /** Marco EM FOCO (CA-7): a escolha explícita do usuário, ou o primeiro marco enquanto ele não escolheu. */
  const focusedMarcoDisplay =
    focusedTree?.marcos.find((marco) => marco.marcoId === focusedMarcoId) ?? focusedTree?.marcos[0] ?? null;
  /** T327/D1 — a fase travada segundo o BOARD (etiqueta `esteira:em-andamento:<fase>`), nunca um arquivo em disco. */
  const focusedLockedPhase = focusedMarcoDisplay?.boardFacts?.lockedPhase ?? null;

  /** CA-1 — lista de candidatos do board. Sem fonte configurada volta `[]` (porta desligada, não erro). */
  const refreshEntryCards = useCallback((): void => {
    setEntryLoading(true);
    void window.donel.devMode
      .listEntryCards()
      .then(setEntryCards)
      .catch(() => setEntryCards([]))
      .finally(() => setEntryLoading(false));
  }, []);

  /** Relê do DISCO a árvore de todo discovery aberto (CA-7). Barato: `readTree` é só `existsSync`/`readFile` de manifesto. */
  const refreshDiscoveryTrees = useCallback((discoveryIds: readonly string[]): void => {
    for (const cardId of discoveryIds) {
      void window.donel.devMode
        .readTree(cardId)
        .then((tree) => setDiscoveryTrees((prev) => ({ ...prev, [cardId]: tree })))
        .catch(() => undefined);
    }
  }, []);

  const openDiscoveryIds = useMemo(
    () =>
      Object.values(devModeState?.discoveries ?? {})
        .filter((discovery) => discovery.closedAt === null)
        .map((discovery) => discovery.cardId),
    [devModeState],
  );

  useEffect(() => {
    if (!devModeOn) return;
    refreshEntryCards();
  }, [devModeOn, refreshEntryCards]);

  useEffect(() => {
    if (!devModeOn || openDiscoveryIds.length === 0) return;
    refreshDiscoveryTrees(openDiscoveryIds);
  }, [devModeOn, openDiscoveryIds, refreshDiscoveryTrees]);

  /**
   * T327/CA-12 — os 4 fatos do board, SÓ dos cards do discovery em foco. A
   * lista consultada é a dos marcos desta árvore: nenhum card fora do foco é
   * pedido, e nada é escrito de volta (invariante 5). Board sem fonte devolve
   * `{}` — o mapa continua idêntico ao da Fatia 1, sem erro na tela.
   */
  const focusedMarcoCardIds = useMemo(
    () => (rawFocusedTree ? rawFocusedTree.marcos.map((marco) => marco.cardId) : []),
    [rawFocusedTree],
  );

  useEffect(() => {
    if (!devModeOn || focusedMarcoCardIds.length === 0) {
      setBoardFacts({});
      return;
    }
    void window.donel.devMode
      .readBoardFacts(focusedMarcoCardIds)
      .then(setBoardFacts)
      .catch(() => setBoardFacts({}));
  }, [devModeOn, focusedMarcoCardIds]);

  // T321/CA-23 — encerramento automático: o discovery some da lista de abertos
  // quando TODO marco tem `concluir: success`. Fato verificável (gate de
  // `esteira-concluir`), não opinião do app — e sem passo manual.
  useEffect(() => {
    if (!devModeState) return;
    const toClose = discoveriesToClose(Object.values(discoveryTrees), devModeState.discoveries);
    for (const cardId of toClose) {
      void window.donel.devMode.closeDiscovery(cardId).then(setAppConfig).catch(() => undefined);
    }
  }, [discoveryTrees, devModeState]);

  /**
   * T312/CA-3 — escreve a sequência no PTY, um comando por vez, SEM `\r`.
   * Só escreve quando `isReadyToPreType` diz que a sessão aceita input
   * (semáforo em `'waiting'` ou REPL desenhado; nunca com o diálogo de
   * confiança na tela). O 2º comando do CA-16 só sai depois de um `'waiting'`
   * NOVO — ou seja, depois do Enter humano do 1º ter fechado o turno.
   * Estourou o teto sem sinal: para, avisa, e deixa o resto manual.
   */
  const armPhaseCommands = useCallback((tabId: string, commands: readonly string[], warning?: string): void => {
    armWatchersRef.current[tabId]?.();
    const sequencer = createPrimeSequencer(commands);
    if (sequencer.done) return;

    let armedAt = 0;
    let isFirstStep = true;
    let settled = false;
    let armedAny = false;

    const cleanup = (): void => {
      unsubscribe();
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      delete armWatchersRef.current[tabId];
    };

    const stop = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
    };

    const check = (): void => {
      if (settled) return;
      const ready = isReadyToPreType({
        isFirstStep,
        semaphore: semaphoreStatesRef.current[tabId],
        armedAt,
        renderedLines: terminalRefs.current[tabId]?.getRenderedLines() ?? [],
      });
      if (!ready) return;

      const command = sequencer.next();
      if (command === null) {
        stop();
        return;
      }

      // ⬇⬇ O gesto central: texto puro, nunca `\r`. ⬇⬇
      const written = terminalRefs.current[tabId]?.injectCommand(command) ?? false;
      if (!written) return; // PTY ainda não nasceu — tenta de novo no próximo sinal

      armedAt = Date.now();
      isFirstStep = false;
      armedAny = true;
      setArmedPrompt({ tabId, command, warning });
      if (sequencer.done) stop();
    };

    const unsubscribe = terminalRefs.current[tabId]?.onRenderedUpdate(check) ?? ((): void => {});
    const intervalId = setInterval(check, PRE_TYPE_POLL_MS);
    const timeoutId = setTimeout(() => {
      if (settled) return;
      stop();
      // Só avisa quando NADA foi preparado. Numa sequência do CA-16, o 2º
      // passo depende do Enter humano do 1º — o humano demorar não é falha,
      // é o fluxo normal; um aviso aqui seria ruído (e mentira).
      if (!armedAny) setDevModeToast('A sessão não ficou pronta a tempo — o comando não foi preparado.');
    }, PRE_TYPE_READY_TIMEOUT_MS);

    armWatchersRef.current[tabId] = cleanup;
    check();
  }, []);

  /**
   * T312/T313/T318/T319 — o clique numa fase. A DECISÃO é pura
   * (`decidePhaseOpen`/`resolveCommandSequence`); aqui só o encanamento:
   * criar/focar/retomar a aba e mandar armar o comando.
   */
  const handlePhaseAction = (marcoId: string, phase: EsteiraPhase): void => {
    if (!focusedDiscovery || !focusedTree) return;
    const marco = focusedTree.marcos.find((candidate) => candidate.marcoId === marcoId);
    if (!marco) return;

    const node = marco.phases[phase];
    const key = phaseKey(focusedDiscovery.cardId, marcoId, phase);
    setSelectedNode({ marcoId, phase });
    setOpenedArtifactPath(null);

    // Sessão daquela etapa já aberta nesta execução: foca, não duplica (C6
    // "uma sessão por etapa" — e o estado real dela é `running`).
    const existingTabId = phaseTabsRef.current[key];
    if (existingTabId && tabs.some((tab) => tab.id === existingTabId)) {
      setActiveTabId(existingTabId);
      return;
    }

    const defaults = phaseDefaults[phase];
    const artifactPath = node.artifacts.result
      ? node.artifacts.resultPath
      : node.artifacts.ctxExists
        ? node.artifacts.ctxPath
        : null;

    const decision = decidePhaseOpen({
      phase,
      defaults,
      status: node.status,
      archivedSession: node.archivedSession,
      repoPath: focusedDiscovery.repoPath,
      worktreePath: node.artifacts.worktreePath,
      artifactPath,
    });
    const sequence = resolveCommandSequence({ status: node.status, defaults, cardId: marco.cardId });
    const warning =
      node.status === 'stuck'
        ? 'Fase travada — o comando de liberar vem primeiro, com o seu Enter.'
        : node.status === 'failed'
          ? 'Fase falhou — a mesma skill volta preparada.'
          : undefined;

    switch (decision.kind) {
      case 'use-focused': {
        // T313 — exceção do `concluir` (C6): pré-digita na aba EM FOCO,
        // nunca cria PTY. Sem aba claude em foco: avisa e não faz nada (uma
        // sessão "vazia" só pra ter onde digitar seria pior que o aviso).
        const target = tabs.find((tab) => tab.id === activeTabId && tab.sessionType === 'claude');
        if (!target) {
          setDevModeToast('Sem sessão Claude em foco — abra ou foque uma aba para preparar o /esteira-concluir.');
          return;
        }
        armPhaseCommands(target.id, sequence, warning);
        return;
      }

      case 'create': {
        const tabId = addTab({
          name: `[${marcoId}] ${phase}`,
          cwd: decision.cwd,
          projectName: projects.find((project) => project.path === decision.cwd)?.name,
          pinned: false,
          launchArgs: [...decision.args],
          sessionType: 'claude',
        });
        phaseTabsRef.current[key] = tabId;
        setLastDevModeSession({ args: decision.args, cwd: decision.cwd });
        // CA-6 — o gatilho do arquivamento é o MANIFESTO em disco; ligar o
        // watcher agora é o que permite fechar a aba quando ele aparecer.
        void window.donel.devMode
          .watchPhase({ discoveryCardId: focusedDiscovery.cardId, cardId: marco.cardId, marcoId, phase })
          .catch(() => undefined);
        armPhaseCommands(tabId, sequence, warning);
        return;
      }

      case 'resume': {
        // CA-9 — volta à etapa concluída para CONSULTA: nada é pré-digitado.
        const tabId = addTab({
          name: `[${marcoId}] ${phase}`,
          cwd: decision.cwd,
          projectName: projects.find((project) => project.path === decision.cwd)?.name,
          pinned: false,
          launchArgs: [...decision.args],
          sessionType: 'claude',
        });
        phaseTabsRef.current[key] = tabId;
        setLastDevModeSession({ args: decision.args, cwd: decision.cwd });
        if (node.archivedSession && node.archivedSession.profileSlug !== activeProfileSlug) {
          // CA-22 — avisa qual conta, nunca bloqueia (o aviso inline no nó do
          // mapa é o canal principal; o Toast cobre quem clicou pela Zona 2).
          setDevModeToast(`Essa etapa rodou na conta ${node.archivedSession.profileSlug}.`);
        }
        return;
      }

      case 'open-artifact': {
        // C4 — discovery antigo, sem `session-id` arquivado: o clique alcança
        // o ARTEFATO (o mapa já lista os paths declarados), nunca tenta
        // retomar uma sessão que não existe. Degradação esperada, não erro.
        setOpenedArtifactPath(decision.path);
        setDevModeToast('Etapa sem sessão arquivada — abrindo o artefato dela.');
        return;
      }
    }
  };

  /**
   * T327/CA-16 — confirmada a liberação, pré-digita `/esteira-liberar
   * <card_id>` na aba EM FOCO (mesma regra do `concluir`: nenhuma sessão nova
   * nasce só para digitar um comando). **Nenhum arquivo é tocado** — a trava é
   * a etiqueta `esteira:em-andamento:<fase>` no board (D1), e quem a remove é
   * a skill, depois do Enter do humano.
   */
  const confirmReleaseLock = (): void => {
    const target = lockToRelease;
    setLockToRelease(null);
    if (!target) return;

    const tab = tabs.find((candidate) => candidate.id === activeTabId && candidate.sessionType === 'claude');
    if (!tab) {
      setDevModeToast('Sem sessão Claude em foco — abra ou foque uma aba para preparar o /esteira-liberar.');
      return;
    }

    armPhaseCommands(tab.id, [LIBERAR_COMMAND_TEMPLATE.replace('{card_id}', target.cardId)]);
  };

  /**
   * T328/CA-13 — sessão de CONCILIAÇÃO: sessão nova, com o prompt que descreve
   * os dois fatos divergentes já ESCRITO e não enviado (mesma regra do CA-3).
   * O app não corrige o board — não existe canal para isso.
   */
  const handleConciliate = (marcoId: string, phase: EsteiraPhase): void => {
    if (!focusedDiscovery || !focusedTree) return;
    const marco = focusedTree.marcos.find((candidate) => candidate.marcoId === marcoId);
    const divergence = marco?.phases[phase].divergence;
    if (!marco || !divergence) return;

    const tabId = addTab({
      name: `[${marcoId}] conciliação`,
      cwd: focusedDiscovery.repoPath,
      projectName: projects.find((project) => project.path === focusedDiscovery.repoPath)?.name,
      pinned: false,
      launchArgs: buildClaudeArgs({}),
      sessionType: 'claude',
    });
    armPhaseCommands(tabId, [
      buildConciliationPrompt({
        cardId: marco.cardId,
        marcoId,
        phase,
        diskStatus: divergence.diskStatus,
        boardColumn: divergence.boardColumn,
      }),
    ]);
  };

  /** T311/CA-2 — clique num card da porta de entrada. `resolveEntrySelection` (puro) decide focar × criar. */
  const handleSelectEntryCard = (cardId: string, repoPath: string): void => {
    const selection = resolveEntrySelection({
      cardId,
      discoveries: devModeState?.discoveries ?? {},
      trees: Object.values(discoveryTrees),
    });

    if (selection.kind === 'focus') {
      void window.donel.devMode
        .focusDiscovery(selection.discoveryCardId)
        .then((config) => {
          setAppConfig(config);
          setFocusedMarcoId(null);
          setSelectedNode(null);
          // D4 — Toast só INFORMATIVO: trocar o foco já é reversível pelo
          // próprio gesto (clicar no outro card), então nada de "desfazer".
          setDevModeToast(`Discovery ${selection.discoveryCardId} em foco.`);
        })
        .catch(() => undefined);
      return;
    }

    if (!repoPath) {
      setDevModeToast('Escolha o repo do discovery antes de criar.');
      return;
    }

    void window.donel.devMode
      .openDiscovery({ cardId: selection.cardId, repoPath, epicId: null })
      .then(() => window.donel.devMode.focusDiscovery(selection.cardId))
      .then((config) => {
        setAppConfig(config);
        setFocusedMarcoId(null);
        setSelectedNode(null);
        refreshDiscoveryTrees([selection.cardId]);
        // CA-2 — "criar discovery novo dispara /esteira-discovery <card_id>
        // pela regra do CA-3": sessão nova + comando ESCRITO, sem Enter.
        const defaults = (config.devMode.phaseDefaults ?? DEFAULT_PHASE_DEFAULTS).discovery;
        const tabId = addTab({
          name: `${selection.cardId} discovery`,
          cwd: repoPath,
          projectName: projects.find((project) => project.path === repoPath)?.name,
          pinned: false,
          launchArgs: buildClaudeArgs({ model: defaults.model, effort: defaults.effort }),
          sessionType: 'claude',
        });
        armPhaseCommands(tabId, resolveCommandSequence({ status: 'not-started', defaults, cardId: selection.cardId }));
      })
      .catch(() => undefined);
  };

  // T315/CA-6 — arquivamento por MANIFESTO: `<fase>-result.json` com
  // `status: "success"` fecha a aba daquela etapa e registra o `session-id`
  // (com o perfil de NASCIMENTO da aba, CA-22). Etapa que falhou não chega
  // aqui — o watcher só emite em sucesso, e ela fica aberta de propósito.
  // Nenhum `.jsonl` é apagado: o transcript é do CLI.
  useEffect(() => {
    const unsubscribe = window.donel.devMode.onPhaseArchived((payload: PhaseArchivedPayload) => {
      const key = phaseKey(payload.discoveryCardId, payload.marcoId, payload.phase);
      const tabId = phaseTabsRef.current[key];
      const tab = tabId ? tabsRef.current.find((candidate) => candidate.id === tabId) : undefined;

      if (tab?.claudeSessionId) {
        void window.donel.devMode
          .archivePhaseSession({
            cardId: payload.cardId,
            marcoId: payload.marcoId,
            phase: payload.phase,
            sessionId: tab.claudeSessionId,
            profileSlug: sessionProfilesRef.current[tab.id]?.slug ?? 'principal',
          })
          .then(setAppConfig)
          .catch(() => undefined);
      }

      if (tabId) {
        delete phaseTabsRef.current[key];
        armWatchersRef.current[tabId]?.();
        closeTabImmediatelyRef.current(tabId);
      }

      void window.donel.devMode
        .unwatchPhase({
          discoveryCardId: payload.discoveryCardId,
          cardId: payload.cardId,
          marcoId: payload.marcoId,
          phase: payload.phase,
        })
        .catch(() => undefined);

      refreshDiscoveryTrees([payload.discoveryCardId]);
    });
    return unsubscribe;
  }, [refreshDiscoveryTrees]);

  // T009 — antes do primeiro evento de hook chegar pra uma aba recém-criada,
  // assume 'working' (spike: estado inicial otimista) com stateEnteredAt=0
  // (sortSessions trata omitido/0 como "a mais antiga possível" — nunca
  // perde o desempate de FR-010/CA-6 por causa disso).
  /**
   * T408 (004) — CA-5: UMA função de resolução por sessão, consumida pela aba,
   * pela linha da sidebar e pela lista de sessões anteriores. Se cada lugar
   * decidisse o nome por conta própria, os três divergiriam.
   * Aba `shell` não tem sessão do Claude: seu nome é o `tab.name` e ponto (C4).
   */
  const resolveTabName = (tab: TabState): string => {
    if (tab.sessionType !== 'claude') return tab.name;
    return resolveSessionName({
      fallback: tab.name,
      customTitle: tab.customTitle ?? null,
      stored: (tab.claudeSessionId ? appConfig?.sessionNames[tab.claudeSessionId] : undefined) ?? null,
    });
  };

  // T709/CA-3 (007) — dedupe: sessões exibidas sob um projeto FAVORITADO saem
  // da lista geral. Escopado só aos favoritados (D6) — sessão de projeto
  // comum nunca é afetada. Vem DEPOIS do cabeçalho (favoriteGroups, abaixo)
  // já estar computado com o pior estado — a ordem é a mesma do tasks.md T709
  // (cabeçalho antes do dedupe), aqui expressa como "o dot nunca depende do
  // dedupe", não como ordem de linhas de código.
  const favoritedProjectPaths = useMemo(
    () => projects.filter((project) => project.favorite).map((project) => project.path),
    [projects],
  );
  const registeredFavoriteIds = useMemo(
    () => selectRegisteredIds(appConfig?.sessionRegistry ?? {}, favoritedProjectPaths),
    [appConfig, favoritedProjectPaths],
  );

  const sidebarSessions: SidebarSession[] = tabs
    .filter((tab) => !(tab.claudeSessionId && registeredFavoriteIds.has(tab.claudeSessionId)))
    .map((tab) => ({
      id: tab.id,
      name: resolveTabName(tab),
      projectName: tab.projectName,
      state: semaphoreStates[tab.id]?.state ?? 'working',
      stateEnteredAt: semaphoreStates[tab.id]?.stateEnteredAt,
      pinned: tab.pinned,
      active: tab.id === activeTabId,
    }));

  /**
   * T708/T709 (007) — grupo "Favoritos": um projeto por linha, colapsável
   * (CA-1), com o cabeçalho mostrando o PIOR estado das abas vivas dele (CA-6,
   * `worstState` reusa a precedência de `sessionOrdering.ts`) — é o que
   * impede o dedupe acima de esconder uma sessão em `permission` dentro de um
   * grupo colapsado (conflito nº 1 do discovery). Rótulo de cada linha:
   * `registry.label` (cache do CA-7), substituído pelo nome resolvido AO VIVO
   * quando a sessão já tem aba aberta (dado fresco de graça).
   */
  const favoriteGroups: FavoriteProjectGroup[] = useMemo(() => {
    const registry = appConfig?.sessionRegistry ?? {};
    const collapsedSet = new Set(appConfig?.collapsedFavorites ?? []);
    return projects
      .filter((project) => project.favorite)
      .map((project) => {
        const liveTabs = tabs.filter((tab) => tab.sessionType === 'claude' && tab.cwd === project.path);
        const liveStates = liveTabs.map((tab) => semaphoreStates[tab.id]?.state ?? 'working');
        const sessions: FavoriteSessionRow[] = selectProjectSessions(registry, project.path).map((entry) => {
          const liveTab = tabs.find((tab) => tab.claudeSessionId === entry.sessionId);
          return { sessionId: entry.sessionId, label: liveTab ? resolveTabName(liveTab) : entry.label, pinned: entry.pinned };
        });
        return {
          project,
          collapsed: collapsedSet.has(project.path),
          loading: seedingProjects.has(project.path),
          sessions,
          liveState: worstState(liveStates),
          liveCount: liveTabs.length,
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, appConfig, tabs, semaphoreStates, seedingProjects]);

  // Mesma ordenação da sidebar (sessionOrdering.ts) — FR-013 usa essa lista
  // ranqueada tanto pro Ctrl+1..9 (posição N) quanto pro Ctrl+Tab (próxima
  // sessão que precisa de atenção).
  const orderedSessions = useMemo(() => sortSessions(sidebarSessions), [sidebarSessions]);

  // FR-013 — Ctrl+1..9 foca a sessão na posição N da lista ranqueada;
  // Ctrl+Tab foca a próxima que precisa de atenção (permissão > aguardando).
  // Capture na fase de captura + preventDefault/stopPropagation: sem isso o
  // xterm embaixo (foco na aba ativa) recebe as teclas como input normal do
  // terminal em vez do atalho do app.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      if (event.key === 'Tab') {
        const target = nextAttentionSessionId(orderedSessions, activeTabIdRef.current);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        setActiveTabId(target);
        return;
      }

      const position = Number(event.key);
      if (Number.isInteger(position) && position >= 1 && position <= 9) {
        const target = sessionIdAtPosition(orderedSessions, position);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        setActiveTabId(target);
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [orderedSessions]);

  // Notificação Windows opcional (ui-spec §3, FR-010) quando uma sessão em
  // BACKGROUND passa a precisar de atenção — nunca pra aba já em foco (o
  // usuário já está olhando). `app.setAppUserModelId` (main/index.ts) é o
  // que garante a notificação sair atribuída ao Donel Dev, não a "Electron".
  //
  // FIX (feedback E2E rodada 4, batch 3 achado "notificar toda transição
  // vira spam") — antes SEMPRE disparava pra waiting+permission; agora
  // filtra pela preferência do ConfigStore (T015): 'all' preserva o
  // comportamento antigo, 'permission-only' (default) só a transição que de
  // fato TRAVA a sessão, 'none' desliga. `previousSemaphoreStatesRef` é
  // atualizado INCONDICIONALMENTE (mesmo com 'none') — trocar a preferência
  // de volta pra mais permissiva no meio de uma sessão não deve disparar
  // notificação retroativa de uma transição que já aconteceu enquanto
  // estava desligado.
  useEffect(() => {
    const preference = appConfig?.notificationPreference ?? FALLBACK_NOTIFICATION_PREFERENCE;
    const previous = previousSemaphoreStatesRef.current;

    if (preference !== 'none') {
      for (const tab of tabs) {
        const nextState = semaphoreStates[tab.id]?.state;
        const prevState = previous[tab.id]?.state;
        if (!nextState || nextState === prevState) continue; // só na TRANSIÇÃO de estado, não a cada update
        if (tab.id === activeTabId) continue; // aba em foco não precisa de toast
        if (nextState !== 'waiting' && nextState !== 'permission') continue;
        if (preference === 'permission-only' && nextState !== 'permission') continue;

        try {
          if (typeof Notification === 'undefined') continue;
          const title = nextState === 'permission' ? 'Permissão pendente' : 'Aguardando sua resposta';
          const body =
            nextState === 'permission' ? `Sessão "${tab.name}" precisa da sua aprovação.` : `Sessão "${tab.name}" terminou o turno.`;
          const notification = new Notification(title, { body });
          notification.onclick = () => setActiveTabId(tab.id);
        } catch {
          // Notificação é opcional (ui-spec §3) — nunca deve derrubar a UI.
        }
      }
    }
    previousSemaphoreStatesRef.current = semaphoreStates;
  }, [semaphoreStates, tabs, activeTabId, appConfig?.notificationPreference]);

  // FIX (feedback E2E rodada 3) — painel colapsável: "fecha ao... Esc".
  // Efeito próprio (não reaproveita o listener de atalhos Ctrl+1..9/Ctrl+Tab
  // acima — aquele é `capture` + exige Ctrl; Esc aqui é global e só importa
  // quando o painel está aberto, sem interferir no Esc que o SplitButton já
  // trata internamente pro PRÓPRIO dropdown, nem no Esc do Modal.tsx).
  useEffect(() => {
    if (!launcherOpen) return undefined;
    function handleEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setLauncherOpen(false);
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [launcherOpen]);

  // T011 — aba em foco, pra decidir se a toolbar de Modelo/Esforço aparece (só sessões 'claude').
  const activeTab = tabs.find((tab) => tab.id === activeTabId);


  // FIX (T015, FR-009 "statusbar completa") — era hardcoded "fable/high"
  // (sempre o mesmo texto, ignorando a aba real): agora reflete o
  // modelo/esforço de VERDADE da aba em foco (`sessionModelEffort`, já
  // mantido pelo T011/T013), e some quando a aba ativa não é uma sessão
  // claude (terminal livre não tem os dois campos — `StatusBar` omite o
  // separador quando `modelEffort` é `undefined`).
  // FIX (teste manual 27/07) — com a toolbar SessionDetails removida, o rodapé
  // é a única leitura de modelo/esforço; ganha também o contexto REAL do último
  // turno (T610, transcript-watcher — nunca estimado, some sem leitura).
  const activeContextTokens = activeTab?.claudeSessionId ? (contextTokens[activeTab.claudeSessionId] ?? null) : null;
  const activeModelEffort =
    activeTab && activeTab.sessionType === 'claude'
      ? [
          `${sessionModelEffort[activeTab.id]?.model ?? DEFAULT_MODEL_ALIAS}/${sessionModelEffort[activeTab.id]?.effort ?? DEFAULT_EFFORT_LEVEL}`,
          activeContextTokens !== null ? `ctx ${Math.round(activeContextTokens / 1000)}k` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : undefined;

  // FIX (feedback E2E rodada 5) — "statusbar deve mostrar a conta com que a
  // sessão EM FOCO foi criada", não a conta ATIVA global (`accountLabel`,
  // ProfileSwitcher). `accountLabel` continua sendo o badge do
  // titlebar/dropdown ("que conta a PRÓXIMA sessão usa") — aqui é só o
  // fallback pra janela curta antes de `sessionProfiles[activeTab.id]`
  // resolver (ver `computeSessionAccountLabel`). Sem aba ativa (0 sessões
  // abertas), cai no `accountLabel` global também — não há "aba em foco"
  // nesse estado.
  //
  // FIX (auditoria rodada 5, achado alta "regressão de cota") — cota do
  // perfil de NASCIMENTO da aba (`profileHeadroom[slug]`, alimentado por
  // `ProfileSwitcher.onHeadroomChange`), não a do perfil ativo global —
  // `?? null` cobre tanto "perfil sem entrada no mapa ainda" (dropdown nunca
  // foi aberto) quanto "mapa devolveu unavailable pra este slug" (mesmo
  // contrato "—" da rodada 4). T204 (002-quota-headroom): `profileHeadroom`
  // guarda `ProfileQuota` (não mais `number|null`) — `computeSessionAccountLabel`
  // já lê `.fiveHour.percentRemaining` internamente.
  const activeSessionProfile = activeTab ? sessionProfiles[activeTab.id] : undefined;
  const activeSessionQuota = activeSessionProfile ? (profileHeadroom[activeSessionProfile.slug] ?? null) : null;
  const activeSessionAccountLabel = activeTab
    ? computeSessionAccountLabel(
        { sessionType: activeTab.sessionType, profile: activeSessionProfile },
        accountLabel,
        activeSessionQuota,
      )
    : accountLabel;

  return (
    <div className={styles.shell}>
      <header className={styles.titlebar}>
        <div className={styles.brand}>
          <span aria-hidden="true">◆</span>
          <span>Donel Dev</span>
        </div>
        <ProfileSwitcher
          onActiveProfileLabelChange={setAccountLabel}
          onHeadroomChange={setProfileHeadroom}
          onActiveProfileSlugChange={setActiveProfileSlug}
        />
        {/* T310/CA-20 — o switch do Modo Dev. Ligar REORGANIZA o layout desta
            mesma janela; desligar volta à tela de hoje, que não é aposentada
            (nem desmontada: a sidebar e as abas continuam montadas, ocultas
            por CSS — mesmo princípio do T007 "todas as abas ficam montadas",
            é o que garante que nenhum PTY é recriado no toggle). */}
        <div className={styles.devModeToggle} data-testid="devmode-toggle">
          <Toggle checked={devModeOn} onChange={setDevModeOn} label="Modo Dev" />
        </div>
        {/* T015 — UI de Preferências (FR-007, feedback E2E rodada 3/4). */}
        <button
          type="button"
          className={styles.preferencesButton}
          onClick={() => setSidebarCollapsed((prev) => !prev)}
          aria-label={sidebarCollapsed ? 'Mostrar barra lateral' : 'Recolher barra lateral'}
          title={sidebarCollapsed ? 'Mostrar barra lateral' : 'Recolher barra lateral'}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen size={16} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={16} strokeWidth={1.5} aria-hidden="true" />
          )}
        </button>
        {devModeOn ? (
          <button
            type="button"
            className={styles.preferencesButton}
            onClick={() => setRightCollapsed((prev) => !prev)}
            aria-label={rightCollapsed ? 'Mostrar mapa do discovery' : 'Recolher mapa do discovery'}
            title={rightCollapsed ? 'Mostrar mapa do discovery' : 'Recolher mapa do discovery'}
          >
            {rightCollapsed ? (
              <PanelRightOpen size={16} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <PanelRightClose size={16} strokeWidth={1.5} aria-hidden="true" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.preferencesButton}
          onClick={() => setPreferencesOpen(true)}
          aria-label="Preferências"
          title="Preferências"
        >
          <Settings size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <SplitButton
          label="＋ Nova sessão"
          // FIX (teste manual 27/07) — o corpo do botão passa a ABRIR o
          // Launcher (escolher modelo/esforço/projeto) em vez do quick-launch
          // cego: pedido do dono ("sempre que eu aperte em Nova sessão
          // apareça a barra lateral para escolher o modelo e afins"). O
          // atalho rápido com a última config vira item do dropdown.
          onClick={() => setLauncherOpen(true)}
          items={[
            { label: 'Rápida (última config)', onSelect: handleQuickNewClaudeSession },
            // FIX (feedback E2E rodada 1, "terminal livre confuso") — rótulo
            // explícito no dropdown; "Terminal" sozinho não deixava claro
            // que era um shell livre (sem sessão claude nenhuma).
            { label: 'Terminal (shell livre)', onSelect: handleNewFreeTerminal },
          ]}
        />
      </header>

      <div
        className={[
          styles.body,
          devModeOn ? styles.bodyDevMode : '',
          sidebarCollapsed ? styles.bodySidebarCollapsed : '',
          // Direita zerada: no clássico sem Launcher; no Modo Dev quando o
          // mapa foi recolhido e o Launcher não está aberto por cima.
          (!devModeOn && !launcherOpen) || (devModeOn && rightCollapsed && !launcherOpen) ? styles.bodyRightCollapsed : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/* CA-20 — a tela de hoje continua MONTADA quando o Modo Dev liga
            (só oculta por CSS): nada de remontar sidebar/abas, nada de PTY
            recriado. Mesmo princípio já usado nas abas de terminal (T007). */}
        <div className={devModeOn || sidebarCollapsed ? styles.zoneHidden : styles.zone} data-testid="today-sidebar">
        <ProjectSidebar
          projects={projects}
          loadingProjects={loadingProjects}
          onOpenProject={handleOpenProject}
          onToggleFavorite={handleToggleFavorite}
          sessions={sidebarSessions}
          onFocusSession={setActiveTabId}
          onTogglePin={handleTogglePin}
          onRenameSession={handleRenameTab}
          onShowPreviousSessions={handleShowPreviousSessions}
          favoriteGroups={favoriteGroups}
          onToggleFavoriteGroupCollapsed={handleToggleFavoriteGroupCollapsed}
          onFocusOrResumeFavoriteSession={handleFocusOrResumeFavoriteSession}
          onToggleFavoriteSessionPinned={handleToggleFavoriteSessionPinned}
        />
        </div>

        {/* Zona 1 — porta de entrada (CA-1/CA-2), só no Modo Dev. */}
        {devModeOn && !sidebarCollapsed ? (
          <DevModeEntry
            cards={entryCards}
            discoveries={devModeState?.discoveries ?? {}}
            trees={Object.values(discoveryTrees)}
            projects={projects}
            defaultRepoPath={selectedProjectPath}
            onSelectCard={handleSelectEntryCard}
            loading={entryLoading}
          />
        ) : null}

        <main className={styles.center}>
          {/* Zona 2 — condução: a fase do marco em foco + o comando ARMADO
              (escrito, não enviado). O botão nunca é desabilitado por trava
              (CA-5/invariante 4) — o slot de aviso é que carrega o fato. */}
          {devModeOn ? (
            <section className={styles.devModeZone2} aria-label="Condução do marco em foco" data-testid="devmode-zone2">
              {focusedTree && focusedMarcoDisplay ? (
                <>
                  <div className={styles.devModeMarcoLabel}>
                    [{focusedMarcoDisplay.marcoId}] · {focusedMarcoDisplay.cardId}
                  </div>
                  <div className={styles.devModePhases}>
                    {(['discovery', 'plano', 'implementar', 'validar', 'concluir'] as const).map((phase) => {
                      const node = focusedMarcoDisplay.phases[phase];
                      const archived = node.archivedSession;
                      return (
                        <PhaseButton
                          key={phase}
                          phase={phase}
                          status={node.status}
                          // T327/CA-5/D1 — dado REAL: a etiqueta de trava lida do
                          // board. Sem fonte de board o slot segue vazio (Fatia 1).
                          lockAnnotation={
                            focusedLockedPhase === phase ? `trava no board desde a etiqueta esteira:em-andamento:${phase}` : null
                          }
                          onReleaseLock={
                            focusedLockedPhase === phase
                              ? () =>
                                  setLockToRelease({
                                    marcoId: focusedMarcoDisplay.marcoId,
                                    phase,
                                    cardId: focusedMarcoDisplay.cardId,
                                  })
                              : null
                          }
                          profileWarning={
                            archived && archived.profileSlug !== activeProfileSlug ? `rodou na conta ${archived.profileSlug}` : null
                          }
                          resultUnreadable={node.artifacts.resultUnreadable}
                          active={selectedNode?.marcoId === focusedMarcoDisplay.marcoId && selectedNode?.phase === phase}
                          onClick={() => handlePhaseAction(focusedMarcoDisplay.marcoId, phase)}
                        />
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className={styles.devModeHint} data-testid="devmode-zone2-empty">
                  Escolha um card na porta de entrada para conduzir um discovery.
                </p>
              )}

              {armedPrompt ? (
                <div data-testid="devmode-armed">
                <ArmedPrompt
                  command={armedPrompt.command}
                  hint="escrito no prompt — o Enter é seu"
                  warning={armedPrompt.warning ? { text: armedPrompt.warning } : undefined}
                  onDismiss={() => setArmedPrompt(null)}
                />
                </div>
              ) : null}

              {openedArtifactPath ? (
                <p className={styles.devModeHint} data-testid="devmode-opened-artifact">
                  {openedArtifactPath}
                </p>
              ) : null}
            </section>
          ) : null}
          <div className={styles.tabBar}>
            {tabs.map((tab) => (
              <TerminalTab
                key={tab.id}
                name={resolveTabName(tab)}
                // T408 (004) — CA-3: duplo-clique no nome, ou F2 na aba em
                // foco. Vale para aba claude (persiste) e shell (memória, C4).
                onRename={(next) => handleRenameTab(tab.id, next)}
                nameMaxLength={SESSION_NAME_MAX_LENGTH}
                // T010 — ui-spec §2 zona 3: abas de terminal comum não têm
                // dot de semáforo (undefined = TerminalTab troca pelo ícone
                // de shell); só abas 'claude' mostram o StateDot do T009.
                state={tab.sessionType === 'shell' ? undefined : (semaphoreStates[tab.id]?.state ?? 'working')}
                active={tab.id === activeTabId}
                onClick={() => setActiveTabId(tab.id)}
                onClose={() => handleRequestCloseTab(tab.id)}
              />
            ))}
          </div>
          {/* FIX (teste manual 27/07) — a toolbar de Modelo/Esforço
              (SessionDetails) foi REMOVIDA dos dois modos a pedido do dono
              ("não tem sido nem um pouco útil"): modelo/esforço agora se
              escolhe no Launcher ao criar a sessão, e a leitura do que a
              sessão usa vive na StatusBar (rodapé). */}
          <div className={styles.terminal}>
            {/* FIX (decisão A, 2026-07-23) — mesmo empty state pros dois
                caminhos que levam a "zero abas": boot do app (INITIAL_TABS
                vazio, ver comentário lá) e fechar a última aba restante
                (T010, handleRequestCloseTab/closeTabImmediately) — nenhum
                estado especial "primeira vez" separado do estado normal
                "sem sessão nenhuma aberta agora". CTA aponta pros dois
                caminhos reais de abrir uma sessão (sidebar ou "＋ Nova
                sessão") em vez de inventar um terceiro botão/atalho. */}
            {tabs.length === 0 ? (
              <div className={styles.emptyState} data-testid="empty-state">
                <p className={styles.emptyStateTitle}>Nenhuma sessão aberta</p>
                <p className={styles.emptyStateHint}>Escolha um projeto na barra lateral ou</p>
                {/* Rótulo "Nova sessão" (sem "＋") de propósito — o botão do
                    titlebar (SplitButton logo abaixo) já usa "＋ Nova sessão"
                    como nome acessível; texto IDÊNTICO nos dois criaria
                    ambiguidade de `getByRole('button', { name: ... })` pra
                    qualquer consumidor (smokes, leitor de tela) enquanto os
                    dois estiverem visíveis ao mesmo tempo. */}
                <Button variant="primary" onClick={handleQuickNewClaudeSession}>
                  Nova sessão
                </Button>
              </div>
            ) : null}
            {tabs.map((tab) => (
              <div key={tab.id} className={tab.id === activeTabId ? styles.terminalPane : styles.terminalPaneHidden}>
                <TerminalPane
                  ref={(handle) => {
                    terminalRefs.current[tab.id] = handle;
                  }}
                  sessionType={tab.sessionType}
                  cwd={tab.cwd}
                  args={tab.launchArgs}
                  onStateChange={(info) => handleSemaphoreChange(tab.id, info)}
                  onAliveChange={(alive) => handleAliveChange(tab.id, alive)}
                  onProfileResolved={(profile) => handleProfileResolved(tab.id, profile)}
                  // T404/T408 — o id da sessão chega aqui e vira a chave de
                  // persistência do nome desta aba (CA-6).
                  onClaudeSessionIdResolved={(claudeSessionId) => {
                    updateTab(tab.id, { claudeSessionId });
                    // T707 (007) — gatilho 1: a sessão nasce. `resolveTabName`
                    // já sabe compor fallback/customTitle/nome da UI; o
                    // `claudeSessionId` chega só agora, então é passado por
                    // fora do `tab` (que só é atualizado no próximo render).
                    const projectPath = tab.cwd;
                    if (projectPath && claudeSessionId) {
                      maybeRegisterVisit(claudeSessionId, projectPath, resolveTabName({ ...tab, claudeSessionId }));
                    }
                  }}
                  // T710 (CA-11, 2º momento) — retomada que morre logo depois do
                  // spawn faz a entrada órfã sair da lista.
                  onProcessExit={(info) => handleTabProcessExit(tab, info)}
                  onCloseTab={() => handleRequestCloseTab(tab.id)}
                />
              </div>
            ))}
          </div>
        </main>

        {/* FIX (feedback E2E rodada 3, painel colapsável) — deixa de ser
            fixo: só monta quando `launcherOpen` (aberto via item "Sessão
            Claude" do menu do "＋ Nova sessão", ou fechado ao lançar/Esc);
            fechado, o espaço vai pro `.center` (terminal), ver
            `styles.bodyPanelClosed` acima. */}
        {/* Zona 3 — o mapa do discovery em foco (CA-7..CA-10). Quando o
            Launcher está aberto no Modo Dev, ele ocupa esta mesma coluna
            (o mapa volta ao fechar — Esc ou lançar). */}
        {devModeOn && focusedTree && !launcherOpen && !rightCollapsed ? (
          <DiscoveryMap
            tree={focusedTree}
            phaseDefaults={phaseDefaults}
            focusedMarcoId={focusedMarcoDisplay?.marcoId ?? null}
            selectedNode={selectedNode}
            activeProfileSlug={activeProfileSlug}
            onFocusMarco={(marcoId) => setFocusedMarcoId(marcoId)}
            onSelectPhase={handlePhaseAction}
            onConciliate={handleConciliate}
          />
        ) : null}

        {launcherOpen ? (
          <aside className={styles.rightPanel} aria-label="Lançar sessão">
            {/* Teste manual 27/07 — fechar o painel precisa de um gesto
                VISÍVEL (Esc continua valendo; lançar também fecha). */}
            <button
              type="button"
              className={styles.rightPanelClose}
              onClick={() => setLauncherOpen(false)}
              aria-label="Fechar painel de nova sessão"
              title="Fechar (Esc)"
            >
              <PanelRightClose size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <Launcher
              projects={projects}
              defaultProjectPath={selectedProjectPath}
              launcherDefaults={appConfig?.launcherDefaults}
              onLaunch={handleLaunch}
            />
          </aside>
        ) : null}
        {/*
          Hook só de teste (T008 DoD — CA-1): não há como inspecionar o
          argv real recebido pelo processo `claude` a partir do renderer (o
          node-pty spawna no main process), então expomos aqui o comando
          exatamente como foi montado pelo CommandBuilder e o cwd usado na
          criação da aba. `hidden` tira do fluxo visual — o smoke lê via
          textContent/atributo, não via visibilidade. FORA do `<aside>`
          condicional de propósito: `handleLaunch` fecha o painel no mesmo
          gesto que preenche este valor (ui-spec §4 "fecha ao lançar") — se
          este elemento vivesse dentro do `<aside>`, ele desmontaria antes
          do smoke conseguir ler o comando montado.
        */}
        <pre data-testid="launcher-last-command" data-cwd={lastLaunch?.cwd ?? ''} hidden>
          {lastLaunch ? ['claude', ...lastLaunch.args].join(' ') : ''}
        </pre>
        {/* Idem, para o Modo Dev (T312/D3) — ver `lastDevModeSession`. */}
        <pre data-testid="devmode-last-session" data-cwd={lastDevModeSession?.cwd ?? ''} hidden>
          {lastDevModeSession ? ['claude', ...lastDevModeSession.args].join(' ') : ''}
        </pre>
      </div>

      <StatusBar
        accountLabel={activeSessionAccountLabel}
        modelEffort={activeModelEffort}
        sessionCount={tabs.length}
        accountTestId="statusbar-account"
      />

      {/* T010 — FR-006, ui-spec §2 "fechar aba com sessão ativa": confirmação destrutiva antes de matar um PTY vivo. */}
      <Modal
        open={pendingCloseTabId !== null}
        onClose={handleCancelCloseTab}
        title="Fechar sessão?"
        actions={
          <>
            <Button variant="secondary" onClick={handleCancelCloseTab}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={handleConfirmCloseTab}>
              Fechar sessão
            </Button>
          </>
        }
      >
        <p>O processo desta aba será encerrado.</p>
      </Modal>

      {/* T013 — PARTE PRINCIPAL (FR-004, CA-2, ui-spec §5). */}
      <PreviousSessions
        open={previousSessionsProject !== null}
        projectName={previousSessionsProject?.name ?? ''}
        sessions={previousSessions}
        loading={loadingPreviousSessions}
        onClose={handleClosePreviousSessions}
        onResume={handleResumeSession}
        onFork={handleForkSession}
        // T408 (004) — a lista mostra o nome resolvido (custom-title do CLI ou
        // nome dado na UI), não só a 1ª mensagem: é o caminho do US-A.
        sessionNames={appConfig?.sessionNames ?? {}}
      />

      {/* T327/CA-16/D1 — confirmação de "Liberar trava…". O texto fala em
          REMOVER A ETIQUETA DE TRAVA NO BOARD (nunca em "arquivo de trava":
          esse arquivo não existe) e deixa claro que o app só PREPARA o
          comando — nada é enviado sem o Enter dele. */}
      <Modal
        open={lockToRelease !== null}
        onClose={() => setLockToRelease(null)}
        title={lockToRelease ? `Liberar a trava de [${lockToRelease.marcoId}] · ${lockToRelease.phase}?` : ''}
        actions={
          <>
            <Button variant="ghost" onClick={() => setLockToRelease(null)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={confirmReleaseLock} data-testid="devmode-confirm-release-lock">
              Preparar /esteira-liberar
            </Button>
          </>
        }
      >
        <p>
          A trava é a etiqueta <code>esteira:em-andamento:{lockToRelease?.phase}</code> no card do board — não há arquivo de
          trava em disco. Quem remove a etiqueta é a skill <code>/esteira-liberar</code>: o app apenas escreve o comando no
          prompt, e o Enter continua sendo seu.
        </p>
      </Modal>

      {/* D4 — Toast do Modo Dev: uma linha, SEM ação de desfazer. Trocar o
          foco já é reversível pelo próprio gesto (clicar no outro card); uma
          máquina de "desfazer" não agregaria valor nenhum. */}
      <Toast open={devModeToast !== null} message={devModeToast ?? ''} onDismiss={() => setDevModeToast(null)} />

      {/* T015 — Preferências (FR-007, feedback E2E rodada 3/4). */}
      <Preferences
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        projectRoots={appConfig?.projectRoots ?? []}
        projectScanMode={appConfig?.projectScanMode ?? 'markers'}
        notificationPreference={appConfig?.notificationPreference ?? FALLBACK_NOTIFICATION_PREFERENCE}
        onAddRoot={handleAddProjectRoot}
        onRemoveRoot={handleRemoveProjectRoot}
        onChangeProjectScanMode={handleChangeProjectScanMode}
        onChangeNotificationPreference={handleChangeNotificationPreference}
      />
    </div>
  );
}
