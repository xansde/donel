import type { ProjectInfo } from '../../shared';
import type { EditableLabelHandle, SessionState } from '@donel-dev/design-system';
import { EditableLabel, StateDot } from '@donel-dev/design-system';
import { ChevronDown, ChevronRight, History, Pin, PinOff, Star } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { sortSessions } from '../../shared/sessionOrdering';
import { SESSION_NAME_MAX_LENGTH } from '../../shared/sessionName';
import styles from './ProjectSidebar.module.css';

// T007 — sidebar real (ui-spec §2, US-1, FR-001): PROJETOS (árvore rasa por
// root, favoritos no topo) + SESSÕES (todas as sessões abertas, sessões
// fixadas com pin). `state` das sessões é placeholder ('working') até o
// semáforo real chegar no T009 — a ordenação (sortSessions) já segue a regra
// definitiva de precedência pra não precisar reescrever depois.

export interface SidebarSession {
  id: string;
  name: string;
  /** Nome curto do projeto, ou undefined pra sessão sem projeto (aba livre/inicial). */
  projectName?: string;
  state: SessionState;
  /** T009 — epoch ms de quando `state` passou a valer (FR-010/CA-6 desempate por idade em `permission`). */
  stateEnteredAt?: number;
  pinned: boolean;
  active: boolean;
}

export interface ProjectSidebarProps {
  projects: ProjectInfo[];
  loadingProjects: boolean;
  onOpenProject: (project: ProjectInfo) => void;
  onToggleFavorite: (path: string, favorite: boolean) => void;
  sessions: SidebarSession[];
  onFocusSession: (id: string) => void;
  onTogglePin: (id: string) => void;
  /**
   * T407/T408 (004-nomear-sessoes) — renomear a sessão pela própria linha
   * (CA-3), com o MESMO gesto da aba de topo (duplo-clique ou F2). O App
   * decide o que fazer com o texto: aba claude persiste, aba shell é memória.
   */
  onRenameSession: (id: string, name: string) => void;
  /**
   * T013 (FR-004, CA-2, ui-spec §5) — abre o painel "Sessões anteriores" do
   * projeto. Ícone PRÓPRIO por linha (não o botão do nome, que já abre uma
   * sessão claude NOVA direto — T007, smoke `terminal.spec.ts` — e não pode
   * mudar de significado).
   */
  onShowPreviousSessions: (project: ProjectInfo) => void;
  /** T708 (007-favoritos-sessoes) — grupo novo NO TOPO (C5), só projetos favoritados (D6). */
  favoriteGroups: FavoriteProjectGroup[];
  /** T708 — colapsar/expandir o grupo de um projeto favoritado; estado persiste (CA-1). */
  onToggleFavoriteGroupCollapsed: (projectPath: string) => void;
  /** T710 — clique numa linha do grupo: foca a aba se já aberta, senão retoma (CA-4). */
  onFocusOrResumeFavoriteSession: (sessionId: string) => void;
  /** T710/CA-5 — pin da SESSÃO (persistido), gesto único que também alimenta o desempate da lista geral (C2). */
  onToggleFavoriteSessionPinned: (sessionId: string) => void;
}

/** Linha de sessão dentro de um grupo "Favoritos" (T708). */
export interface FavoriteSessionRow {
  readonly sessionId: string;
  readonly label: string;
  readonly pinned: boolean;
}

/**
 * Um projeto favoritado + as sessões que aparecem sob ele (T708/CA-2: 5
 * recentes + fixadas). `liveState`/`liveCount` chegam no T709 (CA-6, cabeçalho
 * que "grita"); `undefined` = nenhuma aba viva desse projeto agora.
 */
export interface FavoriteProjectGroup {
  readonly project: ProjectInfo;
  readonly collapsed: boolean;
  /** T708/CA-8 — semeadura em andamento (única espera visível da feature). */
  readonly loading: boolean;
  readonly sessions: FavoriteSessionRow[];
  /** T709/CA-6 — pior estado do semáforo entre as abas VIVAS deste projeto; `undefined` = nenhuma aba viva. */
  readonly liveState?: SessionState;
  /** T709/CA-6 — contagem de abas vivas deste projeto (o "com contagem" do CA-6). */
  readonly liveCount: number;
}

function rootLabel(root: string): string {
  const normalized = root.replace(/[\\/]+$/, '');
  const lastSep = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  const base = lastSep >= 0 ? normalized.slice(lastSep + 1) : normalized;
  return `${base}/`;
}

function groupByRoot(projects: ProjectInfo[]): { root: string; items: ProjectInfo[] }[] {
  const groups: { root: string; items: ProjectInfo[] }[] = [];
  for (const project of projects) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.root === project.root) {
      lastGroup.items.push(project);
    } else {
      groups.push({ root: project.root, items: [project] });
    }
  }
  return groups;
}

/**
 * T407/T408 (004-nomear-sessoes) — a linha de sessão virou componente próprio
 * porque o gesto de renomear precisa de um `ref` por linha (F2 abre a edição
 * da linha em foco). Antes era markup inline; nenhum comportamento existente
 * mudou aqui além disso.
 */
function SessionRow({
  session,
  onFocusSession,
  onTogglePin,
  onRenameSession,
}: {
  session: SidebarSession;
  onFocusSession: (id: string) => void;
  onTogglePin: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
}): React.JSX.Element {
  const labelRef = useRef<EditableLabelHandle>(null);

  return (
    <div className={[styles.sessionRow, session.active ? styles.sessionRowActive : ''].join(' ')}>
      <button
        type="button"
        className={styles.sessionOpenButton}
        onClick={() => onFocusSession(session.id)}
        onKeyDown={(event) => {
          if (event.key !== 'F2') return;
          event.preventDefault();
          event.stopPropagation();
          labelRef.current?.startEditing();
        }}
      >
        <StateDot state={session.state} />
        <EditableLabel
          ref={labelRef}
          className={styles.sessionName}
          value={session.name}
          maxLength={SESSION_NAME_MAX_LENGTH}
          onCommit={(next) => onRenameSession(session.id, next)}
          inputAriaLabel={`Renomear sessão ${session.name}`}
        />
        {session.projectName ? <span className={styles.sessionProject}>{session.projectName}</span> : null}
      </button>
      <button
        type="button"
        className={styles.pinButton}
        onClick={() => onTogglePin(session.id)}
        aria-pressed={session.pinned}
        aria-label={session.pinned ? `Desafixar sessão ${session.name}` : `Fixar sessão ${session.name}`}
      >
        {session.pinned ? (
          <Pin size={12} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
        ) : (
          <PinOff size={12} strokeWidth={1.5} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/**
 * T708/T710 (007) — uma linha do grupo "Favoritos": rótulo (registro, CA-10) +
 * pin. Renomear pelo grupo está FORA de escopo (é a 004; o rótulo aqui só
 * CONSOME a resolução) — sem `EditableLabel`, de propósito.
 */
function FavoriteSessionRowView({
  session,
  onFocus,
  onTogglePinned,
}: {
  session: FavoriteSessionRow;
  onFocus: (sessionId: string) => void;
  onTogglePinned: (sessionId: string) => void;
}): React.JSX.Element {
  return (
    <div className={styles.sessionRow}>
      <button type="button" className={styles.sessionOpenButton} onClick={() => onFocus(session.sessionId)}>
        <span className={styles.sessionName}>{session.label}</span>
      </button>
      <button
        type="button"
        className={styles.pinButton}
        onClick={() => onTogglePinned(session.sessionId)}
        aria-pressed={session.pinned}
        aria-label={session.pinned ? `Desafixar sessão ${session.label}` : `Fixar sessão ${session.label}`}
      >
        {session.pinned ? (
          <Pin size={12} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
        ) : (
          <PinOff size={12} strokeWidth={1.5} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/**
 * T708/T709 (007) — um projeto favoritado, colapsável (CA-1), com o
 * cabeçalho que "grita" o pior estado das abas vivas (CA-6) e as sessões sob
 * ele (CA-2).
 */
function FavoriteGroupView({
  group,
  onToggleCollapsed,
  onFocusSession,
  onTogglePinned,
}: {
  group: FavoriteProjectGroup;
  onToggleCollapsed: (projectPath: string) => void;
  onFocusSession: (sessionId: string) => void;
  onTogglePinned: (sessionId: string) => void;
}): React.JSX.Element {
  return (
    <div className={styles.projectGroup} data-testid={`favorite-group-${group.project.name}`}>
      <button
        type="button"
        className={styles.projectRootToggle}
        onClick={() => onToggleCollapsed(group.project.path)}
        aria-expanded={!group.collapsed}
      >
        {group.collapsed ? (
          <ChevronRight size={12} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" />
        )}
        {/* CA-6 — o cabeçalho acende mesmo com o grupo FECHADO: sem aba viva, sem dot. */}
        {group.liveState ? <StateDot state={group.liveState} /> : null}
        <span className={styles.projectRoot}>{group.project.name}</span>
        {group.liveCount > 0 ? <span className={styles.sessionProject}>{group.liveCount}</span> : null}
        {group.loading ? <span className={styles.hint}>carregando…</span> : null}
      </button>
      {group.collapsed
        ? null
        : group.sessions.map((session) => (
            <FavoriteSessionRowView key={session.sessionId} session={session} onFocus={onFocusSession} onTogglePinned={onTogglePinned} />
          ))}
    </div>
  );
}

export function ProjectSidebar({
  projects,
  loadingProjects,
  onOpenProject,
  onToggleFavorite,
  sessions,
  onFocusSession,
  onTogglePin,
  onRenameSession,
  onShowPreviousSessions,
  favoriteGroups,
  onToggleFavoriteGroupCollapsed,
  onFocusOrResumeFavoriteSession,
  onToggleFavoriteSessionPinned,
}: ProjectSidebarProps): React.JSX.Element {
  const [collapsedRoots, setCollapsedRoots] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => groupByRoot(projects), [projects]);
  const orderedSessions = useMemo(() => sortSessions(sessions), [sessions]);

  const toggleRoot = (root: string): void => {
    setCollapsedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  return (
    <nav className={styles.sidebar} aria-label="Projetos e sessões">
      {/* T708 (007) — C5: grupo novo NO TOPO, ANTES de "Projetos". Só existe
          quando há ao menos um projeto favoritado (D6) — sem CTA de seção
          vazia, mesmo espírito do resto da sidebar. */}
      {favoriteGroups.length > 0 ? (
        <section aria-label="Favoritos">
          <h2 className={styles.sectionTitle}>Favoritos</h2>
          {favoriteGroups.map((group) => (
            <FavoriteGroupView
              key={group.project.path}
              group={group}
              onToggleCollapsed={onToggleFavoriteGroupCollapsed}
              onFocusSession={onFocusOrResumeFavoriteSession}
              onTogglePinned={onToggleFavoriteSessionPinned}
            />
          ))}
        </section>
      ) : null}

      <section>
        <h2 className={styles.sectionTitle}>Projetos</h2>
        {loadingProjects ? <p className={styles.hint}>Carregando projetos…</p> : null}
        {!loadingProjects && groups.length === 0 ? (
          <p className={styles.hint}>Nenhum projeto encontrado em ~/seazone ou ~/pessoal.</p>
        ) : null}
        {groups.map((group) => {
          const collapsed = collapsedRoots.has(group.root);
          return (
            <div key={group.root} className={styles.projectGroup}>
              <button
                type="button"
                className={styles.projectRootToggle}
                onClick={() => toggleRoot(group.root)}
                aria-expanded={!collapsed}
              >
                {collapsed ? (
                  <ChevronRight size={12} strokeWidth={1.5} aria-hidden="true" />
                ) : (
                  <ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" />
                )}
                <span className={styles.projectRoot}>{rootLabel(group.root)}</span>
              </button>
              {collapsed
                ? null
                : group.items.map((project) => (
                    <div
                      key={project.path}
                      data-testid={`project-row-${project.name}`}
                      className={[styles.projectRow, project.missing ? styles.missing : ''].join(' ')}
                    >
                      <button
                        type="button"
                        className={styles.favoriteButton}
                        onClick={() => onToggleFavorite(project.path, !project.favorite)}
                        aria-pressed={project.favorite}
                        aria-label={project.favorite ? `Remover ${project.name} dos favoritos` : `Favoritar ${project.name}`}
                        disabled={project.missing}
                      >
                        <Star size={12} strokeWidth={1.5} fill={project.favorite ? 'currentColor' : 'none'} aria-hidden="true" />
                      </button>
                      {project.missing ? (
                        <>
                          <span className={styles.projectName} title={project.path}>
                            {project.name}
                          </span>
                          <button
                            type="button"
                            className={styles.removeButton}
                            onClick={() => onToggleFavorite(project.path, false)}
                          >
                            remover
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" className={styles.projectOpenButton} onClick={() => onOpenProject(project)}>
                            {project.name}
                          </button>
                          <button
                            type="button"
                            className={styles.historyButton}
                            onClick={() => onShowPreviousSessions(project)}
                            aria-label={`Sessões anteriores de ${project.name}`}
                            title="Sessões anteriores"
                          >
                            <History size={12} strokeWidth={1.5} aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
            </div>
          );
        })}
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Sessões</h2>
        {orderedSessions.length === 0 ? <p className={styles.hint}>Nenhuma sessão aberta.</p> : null}
        {orderedSessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            onFocusSession={onFocusSession}
            onTogglePin={onTogglePin}
            onRenameSession={onRenameSession}
          />
        ))}
      </section>
    </nav>
  );
}
