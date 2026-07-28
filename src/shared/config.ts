// T015 — tipos IPC do domínio de configuração (FR-007, FR-009, plan.md
// "ConfigStore %APPDATA%\DonelDev\config.json"). O ConfigStore de verdade
// (schema completo, escrita atômica, migração dos JSONs avulsos de T007/
// T014) vive em `src/main/config-store.ts`; aqui só o contrato compartilhado
// com preload/renderer — mesmo padrão de src/shared/profiles.ts.
//
// Só os campos que o RENDERER precisa ler/editar entram no DTO
// (`AppConfigDto`): `favorites` (já servido por `projects:list`) e
// `activeProfileSlug` (já servido por `profiles:list`, campo `active`) NÃO
// duplicam aqui — o main process continua sendo a fonte única de verdade
// pros dois, só que agora persistidos dentro do MESMO config.json.

import type { EffortLevel, ModelAlias, PermissionMode } from './commandBuilder';
import type { DevModeState } from './devMode';
import type { StoredSessionName } from './sessionName';
import type { SessionRegistry } from './sessionRegistry';

export const CONFIG_CHANNELS = {
  get: 'config:get',
  setProjectRoots: 'config:setProjectRoots',
  setNotificationPreference: 'config:setNotificationPreference',
  setLauncherDefaults: 'config:setLauncherDefaults',
  /** T708 (007-favoritos-sessoes) — estado de colapso do grupo "Favoritos" (CA-1), persistido por projeto. */
  setCollapsedFavorites: 'config:setCollapsedFavorites',
  /** FIX ambiente genérico (28/07) — critério da listagem de projetos configurável. */
  setProjectScanMode: 'config:setProjectScanMode',
} as const;

/**
 * FIX ambiente genérico (28/07, teste do colega): 'markers' (default, o
 * comportamento de sempre — só pasta com `.git/` ou `CLAUDE.md`, até 2
 * níveis) × 'all' (toda pasta de 1º nível das raízes, para quem não organiza
 * o disco por repositório). A preferência dele é 'markers'; 'all' existe
 * para a máquina genérica.
 */
export type ProjectScanMode = 'markers' | 'all';

/**
 * FIX (feedback E2E rodada 4/batch 3, achado "notificar toda transição vira
 * spam"): 'all' preserva o comportamento antigo (waiting + permission
 * disparam toast), 'permission-only' é o novo default conservador (só a
 * transição que de fato TRAVA a sessão), 'none' desliga.
 */
export type NotificationPreference = 'all' | 'permission-only' | 'none';

export interface LauncherDefaultsDto {
  readonly model: ModelAlias;
  readonly effort: EffortLevel;
  readonly permissionMode: PermissionMode;
}

/**
 * T402 (004-nomear-sessoes) — `sessionId` → nome que a UI deu à sessão, com o
 * `custom-title` visto no momento da escrita. Vai para o renderer porque é ele
 * quem resolve o label exibido (`resolveSessionName`, src/shared/sessionName.ts):
 * a regra de precedência mora num lugar só, e aba e sidebar consomem o mesmo
 * valor (CA-5).
 */
export type SessionNamesMap = Readonly<Record<string, StoredSessionName>>;

/** Subconjunto do `AppConfig` (main) exposto ao renderer — ver comentário de topo. */
export interface AppConfigDto {
  readonly projectRoots: readonly string[];
  readonly projectScanMode: ProjectScanMode;
  readonly launcherDefaults: LauncherDefaultsDto;
  readonly notificationPreference: NotificationPreference;
  readonly sessionNames: SessionNamesMap;
  /** P1 (tasks.md "Fora deste ciclo": temas) — persistido desde já (FR-007), sem UI de troca no P0. */
  readonly theme: 'dark';
  /**
   * T704 (007-favoritos-sessoes) — registro de sessões recentes/fixadas por
   * projeto favoritado (CA-7/D9: fonte da lista no boot, sem varrer disco).
   * O RENDERER é o único escritor (plan.md §Fatia 2); vai no DTO porque é ele
   * quem monta o grupo "Favoritos" da sidebar a partir deste mapa.
   */
  readonly sessionRegistry: SessionRegistry;
  /**
   * T708 (007) — caminhos de projetos favoritados cujo grupo está COLAPSADO
   * (CA-1: estado de colapso persiste entre execuções). Ausência = expandido
   * (default) — evita crescer a lista a cada favorito novo.
   */
  readonly collapsedFavorites: readonly string[];
  /**
   * T306 (003-modo-dev) — estado próprio do Modo Dev (CA-21/CA-22): tudo o
   * que disco/board não sabem (discoveries abertos, foco, session-id
   * arquivado, tabela de defaults do CA-4). Exposto inteiro ao renderer —
   * diferente de `sessionRegistry`, não há campo a esconder aqui (nenhum é
   * "só do main").
   */
  readonly devMode: DevModeState;
}

/** API tipada exposta pelo preload em `window.donel.config`. */
export interface DonelConfigApi {
  get(): Promise<AppConfigDto>;
  /** Substitui a lista inteira de roots (UI de Preferências, feedback E2E rodada 3); dispara re-scan — quem chama refaz `projects.list()` em seguida. */
  setProjectRoots(roots: string[]): Promise<AppConfigDto>;
  setNotificationPreference(preference: NotificationPreference): Promise<AppConfigDto>;
  /** Gravado a cada "▶ Iniciar" do Launcher — semeia a config do PRÓXIMO Launcher aberto (FR-007 "defaults do launcher"). */
  setLauncherDefaults(defaults: LauncherDefaultsDto): Promise<AppConfigDto>;
  /** T708 (007) — substitui a lista INTEIRA de projetos favoritados colapsados (CA-1). */
  setCollapsedFavorites(collapsed: string[]): Promise<AppConfigDto>;
  /** FIX ambiente genérico (28/07) — troca o critério da listagem; quem chama refaz `projects.list()` em seguida. */
  setProjectScanMode(mode: ProjectScanMode): Promise<AppConfigDto>;
}
