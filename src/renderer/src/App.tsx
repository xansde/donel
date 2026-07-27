import { Button, Modal, SplitButton, StatusBar, TerminalTab } from '@donel-dev/design-system';
import { Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppConfigDto,
  NotificationPreference,
  ProfileHeadroomMap,
  ProjectInfo,
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
import {
  buildEffortInjection,
  buildModelInjection,
  canInjectLiveCommand,
  hasLiveInjectionConfirmation,
} from '../../shared/liveSessionInjection';
import { sortProjects } from '../../shared';
import { computePossiblyBlockedOnPrompt } from '../../shared/possiblyBlockedOnPrompt';
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
import styles from './App.module.css';
import { Launcher } from './Launcher';
import type { LauncherLaunchOptions } from './Launcher';
import { Preferences } from './Preferences';
import { PreviousSessions } from './PreviousSessions';
import { ProfileSwitcher } from './ProfileSwitcher';
import { ProjectSidebar } from './ProjectSidebar';
import type { FavoriteProjectGroup, FavoriteSessionRow, SidebarSession } from './ProjectSidebar';
import { SessionDetails } from './SessionDetails';
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

// T013 (correção herdada) — timeout total de espera pela confirmação real do
// CLI depois de uma injeção de `/model`/`/effort` (rede de segurança — a
// checagem em si é orientada a evento, não poll; ver `watchLiveInjection`
// dentro do componente).
const LIVE_INJECTION_TIMEOUT_MS = 20_000;

// FIX (feedback E2E rodada 5) — limiar do diagnóstico "sem nenhum evento de
// hook ainda" no hint de SessionDetails (ver `possiblyBlockedOnPrompt` mais
// abaixo). Mesma ordem de grandeza de `LIVE_INJECTION_TIMEOUT_MS` acima, não
// reaproveitado direto de propósito: são timeouts de coisas diferentes
// (confirmação de injeção já em voo vs. "a sessão nunca teve nenhum turno").
const POSSIBLY_BLOCKED_THRESHOLD_MS = 20_000;

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
  // FIX (feedback E2E rodada 5) — nenhum estado muda sozinho com o passar
  // do tempo; sem um tick periódico o diagnóstico acima ficaria "atrasado"
  // até a próxima ação do usuário forçar um re-render. 5s é granularidade
  // suficiente pro limiar de ~20s do diagnóstico (não precisa de setInterval
  // mais fino que isso pra um hint textual).
  //
  // FIX (auditoria rodada 5, achado baixa "tick incondicional") — antes
  // rodava pra sempre, incondicional, mesmo com zero abas abertas ou com
  // TODAS as abas já tendo recebido evento de semáforo (quando o
  // diagnóstico nunca mais pode mudar de valor) — trabalho periódico
  // permanente no renderer, que o NFR de RAM (já acima do budget de 400MB,
  // decisão pendente em feedback-e2e.md) não pode pagar de graça. Agora só
  // agenda o `setInterval` enquanto existir ao menos uma aba viva cujo
  // semáforo ainda não chegou (`semaphoreStates[id] === undefined`) — o
  // único estado em que o diagnóstico pode efetivamente mudar com o passar
  // do tempo; some sozinho assim que a última pendência resolve (evento de
  // semáforo chega) ou a aba fecha.
  //
  // FIX (auditoria rodada 5, achado baixa "getRenderedLines fora do
  // render") — `diagnosticTick` (antes descartado, `[, forceDiagnosticTick]`)
  // agora também entra como dependência do efeito de `possiblyBlockedOnPrompt`
  // mais abaixo: é o MESMO tick condicional (nunca um segundo `setInterval`
  // novo) que faz esse diagnóstico reavaliar o limiar de tempo mesmo sem
  // nenhum chunk novo de PTY chegando (buffer parado mostrando só o diálogo).
  const [diagnosticTick, forceDiagnosticTick] = useState(0);
  useEffect(() => {
    const hasPendingDiagnostic = tabs.some((tab) => (aliveTabs[tab.id] ?? false) && semaphoreStates[tab.id] === undefined);
    if (!hasPendingDiagnostic) return undefined;
    const intervalId = setInterval(() => forceDiagnosticTick((tick) => tick + 1), 5_000);
    return () => clearInterval(intervalId);
  }, [tabs, aliveTabs, semaphoreStates]);
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
  // T013 (correção herdada) — troca de modelo/esforço por aba (chave =
  // tab.id) já ESCRITA no stdin mas ainda sem confirmação real do CLI no
  // terminal renderizado; `undefined` = nenhuma injeção em voo nesta aba.
  // Enquanto pendente, a toolbar (SessionDetails) fica desabilitada e mostra
  // um hint distinto — `sessionModelEffort` só muda quando `watchLiveInjection`
  // (abaixo) vir a confirmação de verdade. Ver shared/liveSessionInjection.ts.
  const [pendingInjection, setPendingInjection] = useState<Record<string, 'model' | 'effort' | undefined>>({});
  // T610 (006) — tokens de contexto do último turn, chaveados por
  // **`sessionId`** (não `tab.id`): o watcher do main cobre TODA aba `claude`
  // viva, não existe "aba observada", e a mesma sessão retomada pode aparecer em
  // mais de uma aba — as duas mostram o mesmo número sem estado duplicado.
  // Preenchido pela assinatura ÚNICA de `onTranscriptChanged` (a mesma da 004,
  // logo abaixo); `undefined`/`null` = sem leitura ainda → a toolbar mostra `—`
  // (CA-4), nunca `0%`.
  const [contextTokens, setContextTokens] = useState<Record<string, number | null>>({});
  // Função de cleanup (unsubscribe de `onRenderedUpdate` + clearTimeout) por
  // aba com injeção em voo — ver `watchLiveInjection`.
  const pendingInjectionWatchersRef = useRef<Record<string, (() => void) | undefined>>({});

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
    // T013 — uma injeção pendente cuja confirmação ainda não chegou não pode
    // continuar rodando pra uma aba que acabou de fechar (nem escreveria
    // estado errado — `setPendingInjection`/`setSessionModelEffort` seriam
    // no-ops sem a chave —, mas o listener/timeout ficaria vivo à toa até o
    // timeout; melhor limpar já).
    pendingInjectionWatchersRef.current[tabId]?.();
    delete pendingInjectionWatchersRef.current[tabId];
    setPendingInjection((prev) => omitKey(prev, tabId));
    delete terminalRefs.current[tabId];
  };

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

  // T013 (correção herdada) — assina `onRenderedUpdate` (EVENTO, disparado
  // no callback de conclusão de cada `term.write`, ver TerminalPane.tsx) em
  // vez de `setInterval`: a confirmação real do CLI ("Set model to Sonnet
  // 5") dura só UM frame na tela antes do próximo redraw sobrescrever por
  // cima (achado do smoke real, ver shared/liveSessionInjection.ts) — um
  // poll periódico quase sempre chega tarde demais pra ver esse frame; só
  // checar a CADA chunk processado garante nunca perder. Sem baseline (ver
  // mesmo comentário — este CLI redesenha um viewport de tamanho FIXO, não
  // um log sequencial, então "linhas novas desde X" não é um conceito válido
  // aqui): checa o snapshot ATUAL inteiro a cada evento. `LIVE_INJECTION_
  // TIMEOUT_MS` continua como rede de segurança (`setTimeout`, não mais
  // `setInterval`): se a confirmação nunca chegar (usuário nunca responde o
  // diálogo, ou o CLI falha), desiste de esperar. Só então
  // `sessionModelEffort` é atualizado — nunca antes, nunca otimisticamente.
  const watchLiveInjection = useCallback(
    (tabId: string, kind: 'model' | 'effort', value: ModelAlias | EffortLevel): void => {
      pendingInjectionWatchersRef.current[tabId]?.(); // cancela qualquer watcher anterior desta aba

      let settled = false;
      const settle = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        delete pendingInjectionWatchersRef.current[tabId];
        setPendingInjection((prev) => omitKey(prev, tabId));

        if (!confirmed) return; // timeout sem confirmação — desiste, valor antigo (correto) permanece

        setSessionModelEffort((prev) => {
          const base = prev[tabId] ?? { model: DEFAULT_MODEL_ALIAS, effort: DEFAULT_EFFORT_LEVEL };
          return {
            ...prev,
            [tabId]: kind === 'model' ? { ...base, model: value as ModelAlias } : { ...base, effort: value as EffortLevel },
          };
        });
      };

      const checkNow = (): void => {
        const current = terminalRefs.current[tabId]?.getRenderedLines() ?? [];
        if (hasLiveInjectionConfirmation(current, kind)) settle(true);
      };

      const unsubscribe = terminalRefs.current[tabId]?.onRenderedUpdate(checkNow) ?? ((): void => {});
      const timeoutId = setTimeout(() => settle(false), LIVE_INJECTION_TIMEOUT_MS);
      const cleanup = (): void => {
        unsubscribe();
        clearTimeout(timeoutId);
      };

      pendingInjectionWatchersRef.current[tabId] = cleanup;
      checkNow(); // defesa em profundidade: cobre a confirmação já ter acontecido antes desta chamada
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // T011 — FR-011: injeta `/model <alias>\r` no stdin da aba `tabId` só com
  // o prompt ocioso. `canInjectLiveCommand` já é o mesmo gate que desabilita
  // o SegmentedControl da toolbar (SessionDetails); reconferido aqui (defesa
  // em profundidade contra a corrida rara clique-vs-mudança-de-estado — o
  // clique nasce de um render que pode já estar um tick atrás do semáforo).
  // Clique na opção já ativa não injeta nada (nenhuma mudança de verdade a
  // aplicar); uma injeção já em voo na mesma aba também não injeta uma 2ª
  // por cima (T013 — `pendingInjection`).
  //
  // T013 (correção herdada) — NÃO grava `sessionModelEffort` aqui mais: só
  // marca a troca como pendente e delega a confirmação de verdade pro
  // watcher orientado a evento (`watchLiveInjection`) — ver comentário de
  // topo dessas funções e shared/liveSessionInjection.ts pro porquê (o CLI
  // pode abrir um diálogo interativo de confirmação que o usuário pode
  // recusar).
  const handleSelectModel = (tabId: string, model: ModelAlias): void => {
    if (sessionModelEffort[tabId]?.model === model) return;
    if (pendingInjection[tabId]) return;
    if (!canInjectLiveCommand(semaphoreStates[tabId]?.state, aliveTabs[tabId] ?? false)) return;
    const injected = terminalRefs.current[tabId]?.injectCommand(buildModelInjection(model)) ?? false;
    if (!injected) return;
    setPendingInjection((prev) => ({ ...prev, [tabId]: 'model' }));
    watchLiveInjection(tabId, 'model', model);
  };

  // T011/T013 — idem `handleSelectModel`, pro campo Esforço (`/effort <level>\r`).
  const handleSelectEffort = (tabId: string, effort: EffortLevel): void => {
    if (sessionModelEffort[tabId]?.effort === effort) return;
    if (pendingInjection[tabId]) return;
    if (!canInjectLiveCommand(semaphoreStates[tabId]?.state, aliveTabs[tabId] ?? false)) return;
    const injected = terminalRefs.current[tabId]?.injectCommand(buildEffortInjection(effort)) ?? false;
    if (!injected) return;
    setPendingInjection((prev) => ({ ...prev, [tabId]: 'effort' }));
    watchLiveInjection(tabId, 'effort', effort);
  };

  // T011 — degradação do FR-011 quando não há processo vivo pra injetar
  // (sessão 'done'/'error'/ainda conectando): fecha a aba encerrada e abre
  // uma sessão claude NOVA no mesmo cwd/nome, com `--model`/`--effort` já no
  // argv de spawn (CommandBuilder, T006) — mesmo caminho do Launcher, só que
  // disparado pela toolbar em vez do painel. Perde o histórico da conversa
  // (não tem `-r` aqui — resume real é T012/T013); o próprio texto do
  // FR-011 já prevê essa perda como o preço aceito da degradação (a garantia
  // de "sem perder contexto" da DoD é do caminho de injeção ao vivo, não
  // deste fallback).
  const handleRestartWithConfig = (tabId: string): void => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const pending = sessionModelEffort[tabId] ?? { model: DEFAULT_MODEL_ALIAS, effort: DEFAULT_EFFORT_LEVEL };
    const args = buildClaudeArgs({ model: pending.model, effort: pending.effort, sessionName: tab.name || undefined });
    closeTabImmediately(tabId);
    addTab({ name: tab.name, cwd: tab.cwd, projectName: tab.projectName, pinned: tab.pinned, launchArgs: args, sessionType: 'claude' });
  };

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

  // FIX (feedback E2E rodada 5) — diagnóstico pro hint de SessionDetails
  // (statusHint): `true` só quando a aba em foco está viva, NENHUM evento de
  // hook chegou ainda (`semaphoreStates[id]` continua undefined — ver
  // comentário de `sidebarSessions` acima sobre o estado inicial otimista),
  // já se passaram ~20s desde que ficou viva E (FIX auditoria rodada 5,
  // achado media "sinal invertido") o diálogo de confiança de pasta está DE
  // FATO visível no buffer renderizado da aba (`isTrustDialogVisible`) — sem
  // essa última condição, o hint disparava pra QUALQUER aba claude ociosa por
  // 20s sem nenhum prompt ainda digitado (o caso mais comum que existe, já
  // que `hooks-settings.ts` não cobre `SessionStart`), virando ruído
  // constante em vez de sinal real de bloqueio.
  // `POSSIBLY_BLOCKED_THRESHOLD_MS` deliberadamente mais folgado que
  // qualquer round-trip normal de boot — só existe pra separar "ainda
  // conectando" de "provavelmente esperando resposta no terminal".
  //
  // FIX (auditoria rodada 5, achado baixa "getRenderedLines fora do
  // render") — antes `activeRenderedLines`/`possiblyBlockedOnPrompt` eram
  // calculados DIRETO no corpo de render (chamando `getRenderedLines()`,
  // uma leitura imperativa do buffer mutável do xterm, a cada passada de
  // render — viola pureza de render do React; em StrictMode o render duplo
  // podia ler dois snapshots diferentes do mesmo buffer). Agora é estado
  // (`useState`), recalculado só dentro de um efeito: reage a mudanças de
  // `activeTab`/`aliveTabs`/`semaphoreStates` OU ao `diagnosticTick`
  // condicional já existente acima (nunca um `setInterval` novo — reaproveita
  // o mesmo tick, que só roda enquanto houver aba viva com semáforo pendente).
  const [possiblyBlockedOnPrompt, setPossiblyBlockedOnPrompt] = useState(false);
  useEffect(() => {
    const alive = !!activeTab && (aliveTabs[activeTab.id] ?? false);
    const semaphorePending = !!activeTab && semaphoreStates[activeTab.id] === undefined;
    const aliveSince = activeTab ? aliveSinceRef.current[activeTab.id] : undefined;
    // FIX (auditoria rodada 6, achado media "sem testes de unidade pra
    // possiblyBlockedOnPrompt") — decisão pura extraída pra
    // `shared/possiblyBlockedOnPrompt.ts` (testada em
    // `tests/possiblyBlockedOnPrompt.test.ts`); este efeito só junta o
    // estado do React (aba/vivo/semáforo/buffer renderizado) e repassa.
    setPossiblyBlockedOnPrompt(
      computePossiblyBlockedOnPrompt({
        alive,
        semaphorePending,
        aliveSince,
        now: Date.now(),
        thresholdMs: POSSIBLY_BLOCKED_THRESHOLD_MS,
        getRenderedLines: () => (activeTab ? (terminalRefs.current[activeTab.id]?.getRenderedLines() ?? []) : []),
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, aliveTabs, semaphoreStates, diagnosticTick]);

  // FIX (T015, FR-009 "statusbar completa") — era hardcoded "fable/high"
  // (sempre o mesmo texto, ignorando a aba real): agora reflete o
  // modelo/esforço de VERDADE da aba em foco (`sessionModelEffort`, já
  // mantido pelo T011/T013), e some quando a aba ativa não é uma sessão
  // claude (terminal livre não tem os dois campos — `StatusBar` omite o
  // separador quando `modelEffort` é `undefined`).
  const activeModelEffort =
    activeTab && activeTab.sessionType === 'claude'
      ? `${sessionModelEffort[activeTab.id]?.model ?? DEFAULT_MODEL_ALIAS}/${sessionModelEffort[activeTab.id]?.effort ?? DEFAULT_EFFORT_LEVEL}`
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
        <ProfileSwitcher onActiveProfileLabelChange={setAccountLabel} onHeadroomChange={setProfileHeadroom} />
        {/* T015 — UI de Preferências (FR-007, feedback E2E rodada 3/4). */}
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
          onClick={handleQuickNewClaudeSession}
          items={[
            // FIX (feedback E2E rodada 3, painel colapsável) — "Sessão
            // Claude" passa a ABRIR o painel de configuração (Launcher, §4)
            // em vez de repetir o quick-launch do corpo (redundante antes:
            // as duas ações faziam a MESMA coisa). O corpo do botão
            // continua sendo o atalho rápido (última config usada).
            { label: 'Sessão Claude', onSelect: () => setLauncherOpen(true) },
            // FIX (feedback E2E rodada 1, "terminal livre confuso") — rótulo
            // explícito no dropdown; "Terminal" sozinho não deixava claro
            // que era um shell livre (sem sessão claude nenhuma).
            { label: 'Terminal (shell livre)', onSelect: handleNewFreeTerminal },
          ]}
        />
      </header>

      <div className={launcherOpen ? styles.body : `${styles.body} ${styles.bodyPanelClosed}`}>
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

        <main className={styles.center}>
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
          {/* T011 (FR-011) — toolbar de Modelo/Esforço da aba ATIVA, só pra sessões claude (terminal livre não tem os dois campos). Ver comentário de topo de SessionDetails.tsx sobre por que aqui e não no painel direito. */}
          {activeTab && activeTab.sessionType === 'claude' ? (
            <SessionDetails
              model={sessionModelEffort[activeTab.id]?.model ?? DEFAULT_MODEL_ALIAS}
              effort={sessionModelEffort[activeTab.id]?.effort ?? DEFAULT_EFFORT_LEVEL}
              semaphoreState={semaphoreStates[activeTab.id]?.state}
              alive={aliveTabs[activeTab.id] ?? false}
              onSelectModel={(model) => handleSelectModel(activeTab.id, model)}
              onSelectEffort={(effort) => handleSelectEffort(activeTab.id, effort)}
              onRestartWithConfig={() => handleRestartWithConfig(activeTab.id)}
              pendingKind={pendingInjection[activeTab.id]}
              possiblyBlockedOnPrompt={possiblyBlockedOnPrompt}
              // T611 (006) — a aba resolve o próprio número pelo `sessionId`
              // dela; sem `claudeSessionId` (create ainda não resolveu) não há o
              // que mostrar → `—` (CA-4). Abas `shell` nem chegam aqui.
              contextTokens={activeTab.claudeSessionId ? contextTokens[activeTab.claudeSessionId] ?? null : null}
            />
          ) : null}
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
        {launcherOpen ? (
          <aside className={styles.rightPanel} aria-label="Lançar sessão">
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

      {/* T015 — Preferências (FR-007, feedback E2E rodada 3/4). */}
      <Preferences
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        projectRoots={appConfig?.projectRoots ?? []}
        notificationPreference={appConfig?.notificationPreference ?? FALLBACK_NOTIFICATION_PREFERENCE}
        onAddRoot={handleAddProjectRoot}
        onRemoveRoot={handleRemoveProjectRoot}
        onChangeNotificationPreference={handleChangeNotificationPreference}
      />
    </div>
  );
}
