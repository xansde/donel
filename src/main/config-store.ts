import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EffortLevel, ModelAlias, PermissionMode } from '../shared/commandBuilder';
import type { AppConfigDto, LauncherDefaultsDto, NotificationPreference, SessionNamesMap } from '../shared/config';
import type { StoredSessionName } from '../shared/sessionName';
import type { RegisteredSession, SessionRegistry } from '../shared/sessionRegistry';
import { PRINCIPAL_PROFILE_SLUG } from './profile-manager';

// T015 — ConfigStore formal (FR-007): `%APPDATA%\donel-dev\config.json` (na
// prática `app.getPath('userData')`, que resolve pro nome real do app —
// `donel-dev`, com hífen, via `app.setName('donel-dev')` em main/index.ts,
// espelhando o campo `name` do package.json raiz). NOTA (T017, 2026-07-23):
// este comentário dizia "DonelDev" (sem hífen) e alegava que NTFS
// case-insensitive cobria a diferença — errado, `DonelDev` e `donel-dev` não
// são a mesma string (falta o hífen, não é só capitalização); confirmado em
// disco que o path real é `%APPDATA%\donel-dev\`. Corrigido aqui e no roteiro
// batch-5 (specs/001-mvp/roteiros-e2e/batch-5-acabamento-empacotamento-smoke.md).
// Escrita ATÔMICA (temp + rename, FR-007), schema
// versionado (`CONFIG_SCHEMA_VERSION`) e defaults resilientes — nunca lança
// pra config ausente/corrompida (mesmo espírito de todo módulo *-store deste
// projeto: ScanDeps, ProfileCreationIoDeps, etc.).
//
// ABSORVE (unifica num único arquivo, sem perder dado existente):
//  - `project-config.json` (T007, `{ favorites }`) — `project-config-store.ts`
//    foi DELETADO nesta task, exatamente como o comentário de topo dele já
//    previa ("o ConfigStore formal... chega no T015 e absorve este arquivo").
//    `toggleFavorite` (pura) foi portada pra cá sem mudança de comportamento.
//  - `active-profile.json` (T014, `{ activeSlug }`) — `profile-manager.ts`
//    continua com `ActiveProfileConfig`/`readActiveProfileConfig`/
//    `writeActiveProfileConfig` INTOCADOS (módulo já auditado, testes
//    próprios em profile-manager.test.ts) — só deixam de ser CHAMADOS por
//    `main/index.ts` (o caminho de leitura/escrita ativo passa a ser só este
//    arquivo). A migração abaixo lê o `active-profile.json` legado de forma
//    INDEPENDENTE (parsing próprio do formato `{ activeSlug }`, sem importar
//    de profile-manager.ts) pra não acoplar os dois módulos nem reabrir
//    escopo do T014 fora desta task.
//
// Campos NOVOS neste batch (feedback E2E, specs/001-mvp/feedback-e2e.md):
//  - `projectRoots` (rodada 3) — era hardcoded em `defaultProjectRoots`,
//    nunca persistido/editável; agora configurável pela UI de Preferências.
//  - `notificationPreference` (rodada 4, achado do batch 3) — era binário
//    fixo (sempre avisa waiting+permission), agora configurável com default
//    conservador `permission-only`.

export const CONFIG_SCHEMA_VERSION = 1;

export const CONFIG_FILE_NAME = 'config.json';

/** Nomes dos arquivos legados que este módulo absorve (T007/T014) — usados só pela migração, nunca mais escritos. */
export const LEGACY_PROJECT_CONFIG_FILE_NAME = 'project-config.json';
export const LEGACY_ACTIVE_PROFILE_FILE_NAME = 'active-profile.json';

/** Mesmos defaults visuais do Brief 3 (Launcher.tsx `DEFAULT_MODEL`/`DEFAULT_EFFORT`/`DEFAULT_PERMISSION`) — ponto de partida até um lançamento real persistir uma escolha diferente. */
const DEFAULT_LAUNCHER_DEFAULTS: LauncherDefaultsDto = { model: 'fable', effort: 'high', permissionMode: 'acceptEdits' };

/** Conservador por padrão (feedback E2E rodada 4, achado "notificar toda transição vira spam") — só a transição que de fato trava a sessão. */
const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = 'permission-only';

export interface AppConfig {
  readonly version: number;
  readonly projectRoots: readonly string[];
  readonly favorites: readonly string[];
  readonly activeProfileSlug: string;
  readonly launcherDefaults: LauncherDefaultsDto;
  readonly notificationPreference: NotificationPreference;
  /** T402 (004) — `sessionId` → nome dado pela UI. Ver `sessionNames` em src/shared/config.ts. */
  readonly sessionNames: SessionNamesMap;
  /** P1 (tasks.md "Fora deste ciclo": temas) — único valor válido no P0. */
  readonly theme: 'dark';
  /** T704 (007) — registro de sessões recentes/fixadas por projeto favoritado. Ver src/shared/sessionRegistry.ts. */
  readonly sessionRegistry: SessionRegistry;
  /** T708 (007) — projetos favoritados com o grupo COLAPSADO (CA-1). Ausência = expandido. */
  readonly collapsedFavorites: readonly string[];
}

/** `projectRoots` não tem um default universal (depende do homedir da máquina) — quem chama monta com `defaultProjectRoots(homedir)` (project-scanner.ts) e passa aqui. */
export function defaultAppConfig(projectRoots: readonly string[]): AppConfig {
  return {
    version: CONFIG_SCHEMA_VERSION,
    projectRoots,
    favorites: [],
    activeProfileSlug: PRINCIPAL_PROFILE_SLUG,
    launcherDefaults: DEFAULT_LAUNCHER_DEFAULTS,
    notificationPreference: DEFAULT_NOTIFICATION_PREFERENCE,
    sessionNames: {},
    theme: 'dark',
    sessionRegistry: {},
    collapsedFavorites: [],
  };
}

/** Renderer só vê o subconjunto relevante (ver comentário de topo de src/shared/config.ts). */
export function toAppConfigDto(config: AppConfig): AppConfigDto {
  return {
    projectRoots: config.projectRoots,
    launcherDefaults: config.launcherDefaults,
    notificationPreference: config.notificationPreference,
    sessionNames: config.sessionNames,
    theme: config.theme,
    sessionRegistry: config.sessionRegistry,
    collapsedFavorites: config.collapsedFavorites,
  };
}

// ---------------------------------------------------------------------------
// I/O injetável — mesmo padrão de ScanDeps/ProfileCreationIoDeps: puro o
// suficiente pra testar com fs MOCKADO (TDD desta task: escrita atômica,
// migração, validação de schema — ver tests/config-store.test.ts).
// ---------------------------------------------------------------------------

export interface ConfigIoDeps {
  existsSync: (path: string) => boolean;
  /** `null` = ausente/ilegível — nunca lança. */
  readFileText: (path: string) => string | null;
  writeFileText: (path: string, content: string) => void;
  renameFile: (fromPath: string, toPath: string) => void;
  /** Recursivo (mesmo contrato de `mkdirSync(path, { recursive: true })`). */
  mkdirSync: (path: string) => void;
  /** Best-effort — limpeza do temp file se o rename falhar no meio (nunca deve lançar). */
  unlinkFile: (path: string) => void;
}

export function createSystemConfigIoDeps(): ConfigIoDeps {
  return {
    existsSync,
    readFileText: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    // T017 correção ciclo 1 (achado "durabilidade contra power-loss") —
    // `renameSync` já torna a TROCA de arquivo atômica pra quem lê
    // (leitores nunca veem um `config.json` truncado), mas sem fsync do
    // arquivo temp antes do rename, os bytes podem ainda estar só no cache
    // de página do SO — uma queda de energia entre o `write` e o flush do
    // filesystem pode perder a ÚLTIMA escrita (o arquivo final reverte pra
    // uma versão anterior, não fica corrompido/truncado). `fsyncSync` força
    // o SO a persistir o conteúdo do temp em disco ANTES do rename, o que
    // fecha essa janela para o conteúdo em si.
    // Fsync do DIRETÓRIO pai (padrão comum em POSIX/ext4, onde a entrada de
    // diretório do rename também precisa de fsync explícito) foi avaliado e
    // DESCARTADO aqui: o app é Windows-primeiro (NFR, spec.md) e o NTFS já
    // journala metadados de diretório (incluindo renomes) como parte do seu
    // próprio log de transações — ao contrário do ext4, não depende de um
    // fsync explícito do caller pra isso. Abrir um handle de diretório via
    // `fs.openSync` no Windows também não é uma operação suportada de forma
    // confiável pela API do Node (não há `O_DIRECTORY` real). Garantia real
    // desta implementação: conteúdo não-truncado (rename atômico) + conteúdo
    // durável contra power-loss (fsync do arquivo). NÃO é uma garantia de
    // durabilidade da entrada de diretório em si além do que o NTFS já dá.
    writeFileText: (path, content) => {
      const fd = openSync(path, 'w');
      try {
        writeSync(fd, content, null, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    renameFile: (fromPath, toPath) => renameSync(fromPath, toPath),
    mkdirSync: (path) => mkdirSync(path, { recursive: true }),
    unlinkFile: (path) => {
      try {
        unlinkSync(path);
      } catch {
        // best-effort — ver comentário do campo na interface.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Validação de schema (puro) — nunca lança; qualquer campo ausente/com tipo
// errado cai no default CORRESPONDENTE, campo a campo (corrupção parcial não
// derruba o resto de um config bom — mesmo espírito defensivo do resto do
// projeto, ex. readProjectConfig/readActiveProfileConfig).
// ---------------------------------------------------------------------------

const KNOWN_MODEL_ALIASES: readonly ModelAlias[] = ['fable', 'opus', 'sonnet', 'haiku'];
const KNOWN_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const KNOWN_PERMISSION_MODES: readonly PermissionMode[] = [
  'manual',
  'acceptEdits',
  'auto',
  'plan',
  'dontAsk',
  'bypassPermissions',
];
const KNOWN_NOTIFICATION_PREFERENCES: readonly NotificationPreference[] = ['all', 'permission-only', 'none'];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOneOf<T extends string>(value: unknown, known: readonly T[]): value is T {
  return typeof value === 'string' && (known as readonly string[]).includes(value);
}

/**
 * T402 — sanitiza o mapa `sessionNames` ENTRADA A ENTRADA: uma entrada
 * malformada (nome vazio, `seenTitle` de tipo errado) é descartada sozinha,
 * sem levar junto o resto do mapa nem o resto da config (mesmo espírito campo
 * a campo do `sanitizeAppConfig`). `updatedAt` inválido não invalida a
 * entrada — é diagnóstico, a precedência do C2 não usa tempo.
 */
function sanitizeSessionNames(value: unknown): SessionNamesMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const sanitized: Record<string, StoredSessionName> = {};
  for (const [sessionId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!sessionId || typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const candidate = entry as Partial<StoredSessionName>;
    if (typeof candidate.name !== 'string' || !candidate.name.trim()) continue;
    if (candidate.seenTitle !== null && typeof candidate.seenTitle !== 'string') continue;

    sanitized[sessionId] = {
      name: candidate.name,
      seenTitle: candidate.seenTitle ?? null,
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
    };
  }
  return sanitized;
}

/**
 * T704 (007-favoritos-sessoes) — sanitiza `sessionRegistry` ENTRADA A ENTRADA,
 * mesmo espírito de `sanitizeSessionNames`: um projeto novo (chave nova neste
 * batch) chega SEMPRE sem esta chave em todo `config.json` já existente na
 * máquina do Alexandre — se o sanitize a descartasse por completo por engano,
 * ok (vira `{}`, semeadura do CA-8 cobre); mas uma entrada malformada não pode
 * levar as demais junto. `sessionId` vem da CHAVE do mapa (nunca do valor —
 * evita um `sessionId` interno divergente da chave que indexa o registro).
 */
function sanitizeSessionRegistry(value: unknown): SessionRegistry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const sanitized: Record<string, RegisteredSession> = {};
  for (const [sessionId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!sessionId || typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const candidate = entry as Partial<RegisteredSession>;
    if (typeof candidate.projectPath !== 'string' || !candidate.projectPath) continue;
    if (typeof candidate.label !== 'string' || !candidate.label.trim()) continue;
    if (typeof candidate.lastActivityAt !== 'number' || !Number.isFinite(candidate.lastActivityAt)) continue;

    sanitized[sessionId] = {
      sessionId,
      projectPath: candidate.projectPath,
      label: candidate.label,
      lastActivityAt: candidate.lastActivityAt,
      pinned: candidate.pinned === true,
    };
  }
  return sanitized;
}

function sanitizeLauncherDefaults(value: unknown, fallback: LauncherDefaultsDto): LauncherDefaultsDto {
  if (typeof value !== 'object' || value === null) return fallback;
  const candidate = value as Partial<LauncherDefaultsDto>;
  return {
    model: isOneOf(candidate.model, KNOWN_MODEL_ALIASES) ? candidate.model : fallback.model,
    effort: isOneOf(candidate.effort, KNOWN_EFFORT_LEVELS) ? candidate.effort : fallback.effort,
    permissionMode: isOneOf(candidate.permissionMode, KNOWN_PERMISSION_MODES) ? candidate.permissionMode : fallback.permissionMode,
  };
}

/**
 * Puro (testável sem I/O): preenche campo a campo a partir de `defaults`
 * quando `parsed` não é um objeto, ou um campo individual tem tipo/valor
 * inválido — nunca lança, nunca deixa um campo `undefined`. `version`
 * sempre normaliza pra `CONFIG_SCHEMA_VERSION` atual (a leitura já devolve a
 * versão corrente); uma migração real de schema (campo renomeado/formato
 * mudado entre versões) entraria aqui verificando `candidate.version` antes
 * de sanitizar — não necessária ainda, só existe a versão 1.
 */
export function sanitizeAppConfig(parsed: unknown, defaults: AppConfig): AppConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaults;
  const candidate = parsed as Partial<AppConfig>;

  return {
    version: CONFIG_SCHEMA_VERSION,
    projectRoots: isStringArray(candidate.projectRoots) ? candidate.projectRoots : defaults.projectRoots,
    favorites: isStringArray(candidate.favorites) ? candidate.favorites : defaults.favorites,
    activeProfileSlug:
      typeof candidate.activeProfileSlug === 'string' && candidate.activeProfileSlug.trim()
        ? candidate.activeProfileSlug
        : defaults.activeProfileSlug,
    launcherDefaults: sanitizeLauncherDefaults(candidate.launcherDefaults, defaults.launcherDefaults),
    notificationPreference: isOneOf(candidate.notificationPreference, KNOWN_NOTIFICATION_PREFERENCES)
      ? candidate.notificationPreference
      : defaults.notificationPreference,
    sessionNames: sanitizeSessionNames(candidate.sessionNames),
    theme: 'dark',
    sessionRegistry: sanitizeSessionRegistry(candidate.sessionRegistry),
    collapsedFavorites: isStringArray(candidate.collapsedFavorites) ? candidate.collapsedFavorites : defaults.collapsedFavorites,
  };
}

/**
 * T402 (004) — mutações PURAS do mapa de nomes, no mesmo estilo do
 * `toggleFavorite`: devolvem um mapa novo, sem I/O (quem chama persiste com
 * `writeAppConfig`). `entry.seenTitle` carimba o `custom-title` que o `.jsonl`
 * tinha no instante da escrita — é o insumo do dirty-check do C2
 * (`resolveSessionName`, src/shared/sessionName.ts).
 */
export function setSessionName(
  sessionNames: SessionNamesMap,
  sessionId: string,
  entry: StoredSessionName,
): SessionNamesMap {
  return { ...sessionNames, [sessionId]: entry };
}

/** Remove a entrada da sessão (o "vazio apaga" do C5, e o descarte do caso CLI-vence). No-op se não existir. */
export function clearSessionName(sessionNames: SessionNamesMap, sessionId: string): SessionNamesMap {
  if (!(sessionId in sessionNames)) return { ...sessionNames };
  const next = { ...sessionNames };
  delete next[sessionId];
  return next;
}

/** Toggle puro (sem I/O) — adiciona/remove `path` da lista, sem duplicar. Portado de project-config-store.ts (T007), comportamento idêntico. */
export function toggleFavorite(favorites: readonly string[], path: string, favorite: boolean): string[] {
  const set = new Set(favorites);
  if (favorite) {
    set.add(path);
  } else {
    set.delete(path);
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// Migração dos JSONs avulsos T007/T014 — só roda quando `config.json` ainda
// NÃO existe (1ª leitura nesta máquina depois deste batch); um `config.json`
// já existente é sempre a fonte de verdade única (nunca reconsulta os
// arquivos legados por cima de um config já migrado, mesmo que eles ainda
// existam no disco ou mudem depois).
// ---------------------------------------------------------------------------

export interface LegacyConfigPaths {
  readonly projectConfigPath: string;
  readonly activeProfilePath: string;
}

/** Parsing independente do formato `{ favorites: string[] }` (T007) — não importa de `project-config-store.ts` (deletado nesta task). */
function extractLegacyFavorites(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { favorites?: unknown };
    return isStringArray(parsed.favorites) ? parsed.favorites : null;
  } catch {
    return null;
  }
}

/** Parsing independente do formato `{ activeSlug: string }` (T014, profile-manager.ts `ActiveProfileConfig`) — ver comentário de topo do arquivo (por que não importar de lá). */
function extractLegacyActiveSlug(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { activeSlug?: unknown };
    return typeof parsed.activeSlug === 'string' && parsed.activeSlug.trim() ? parsed.activeSlug : null;
  } catch {
    return null;
  }
}

function migrateFromLegacyFiles(defaults: AppConfig, legacy: LegacyConfigPaths, io: ConfigIoDeps): AppConfig {
  const favorites = extractLegacyFavorites(io.readFileText(legacy.projectConfigPath));
  const activeProfileSlug = extractLegacyActiveSlug(io.readFileText(legacy.activeProfilePath));

  return {
    ...defaults,
    favorites: favorites ?? defaults.favorites,
    activeProfileSlug: activeProfileSlug ?? defaults.activeProfileSlug,
  };
}

// ---------------------------------------------------------------------------
// Leitura/escrita
// ---------------------------------------------------------------------------

/**
 * `config.json` ausente = 1ª execução nesta máquina depois deste batch:
 * migra dos arquivos legados se existirem (favorites/activeProfileSlug),
 * senão cai nos defaults puros. `config.json` presente = fonte de verdade
 * única — JSON corrompido cai nos defaults SEM tentar migrar por cima (o
 * arquivo já existia, não é "1ª vez"; migrar aqui arriscaria reviver dado
 * velho por cima de uma escrita mais recente que só falhou em ler agora).
 */
export function readAppConfig(filePath: string, defaults: AppConfig, legacy: LegacyConfigPaths, io: ConfigIoDeps): AppConfig {
  const raw = io.readFileText(filePath);
  if (raw === null) return migrateFromLegacyFiles(defaults, legacy, io);

  try {
    return sanitizeAppConfig(JSON.parse(raw), defaults);
  } catch {
    return defaults;
  }
}

/**
 * Escrita atômica (FR-007: "temp + rename") — nunca deixa uma janela em que
 * `config.json` fica truncado: grava tudo num arquivo temporário e só então
 * troca pelo nome final via `rename` (operação atômica do SO; no Windows,
 * `fs.renameSync` já sobrescreve o destino existente via `MoveFileExW` com
 * `MOVEFILE_REPLACE_EXISTING`, o próprio libuv do Node). Nome do temp inclui
 * pid+timestamp — duas escritas (mesmo daquele improvável de duas instâncias
 * do app rodando ao mesmo tempo) não colidem no MESMO arquivo temporário.
 *
 * T017 correção ciclo 1 — `io.writeFileText` (impl real,
 * `createSystemConfigIoDeps`) faz `fsync` do arquivo temp ANTES deste
 * `rename`, então a garantia cobre tanto "nunca truncado" (rename atômico)
 * quanto "conteúdo durável contra power-loss" (fsync). Ver comentário do
 * `writeFileText` pra por que fsync do DIRETÓRIO pai não se aplica aqui
 * (Windows/NTFS, não POSIX/ext4).
 */
export function writeAppConfig(filePath: string, config: AppConfig, io: ConfigIoDeps): void {
  const dir = dirname(filePath);
  if (!io.existsSync(dir)) io.mkdirSync(dir);

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  io.writeFileText(tmpPath, JSON.stringify(config, null, 2));
  try {
    io.renameFile(tmpPath, filePath);
  } catch (error) {
    io.unlinkFile(tmpPath);
    throw error;
  }
}
