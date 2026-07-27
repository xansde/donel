import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';

// T014 — ProfileManager (FR-005, FR-012 parcial, CA-3), implementado
// EXATAMENTE conforme `specs/001-mvp/spike-t001-resultado.md` (LEI para esta
// task).
//
// GATE HUMANO: o critério de saída humano do spike (login real concorrente
// em duas contas, perfil × global, sem colisão) foi FECHADO pelo Alexandre
// em 2026-07-23 ~10:33 (ver "Addendum" no fim do spike) — mas isso valida a
// MECÂNICA de isolamento por `CLAUDE_CONFIG_DIR`, não substitui um novo teste
// humano sempre que uma conta REAL nova for cadastrada num perfil desta app:
// o app nunca lê/grava/exibe credenciais — login sempre acontece dentro do
// terminal, via `/login` do próprio CLI. A UI de perfis só é "pronta de
// verdade" depois desse tipo de teste humano rodar pelo menos uma vez por via
// de acesso nova (ver roteiro `specs/001-mvp/roteiros-e2e/batch-4-sessoes-perfis.md`).
//
// ESCOPO de "o app nunca toca credenciais" (nota da auditoria do batch 4,
// ciclo 1, achado [baixa]): essa garantia cobre `.credentials.json` e a
// chave `oauthAccount` do `.claude.json` — nenhum dos dois é lido, escrito
// ou exibido por este módulo em lugar nenhum (`mergeMcpServersIntoProfile`
// é estruturalmente incapaz de propagar `oauthAccount`, travado por teste em
// `tests/profile-manager.test.ts`). Já `mcpServers` (definição de servidores
// MCP — URL, comando, e possivelmente `env` com valores inline) É copiado do
// global pro perfil por design (é o próprio spike, critério c, que pede
// isso pra os MCPs funcionarem dentro do perfil) — se algum MCP do global
// tiver segredo hardcoded no bloco `env` em vez de referência a variável de
// ambiente, esse segredo passa a existir também no `.claude.json` do
// perfil. Isso é o usuário copiando a própria config na mesma máquina, não
// vazamento cross-conta, e nunca toca tokens OAuth de MCP
// (`.credentials.json`/`mcpOAuth`) — mas é uma escrita real que vale
// documentar ao lado da regra acima. Não bloqueia o MVP; oportunidade futura
// (não implementada aqui): o `doctor` sinalizar `mcpServers` com chaves de
// `env` de aparência sensível pro usuário revisar antes de confirmar.
//
// CORREÇÃO em relação ao texto de "Implicações para o T014" do spike: aquele
// parágrafo recomenda rodar `claude --version` para gerar o `.claude.json`
// esqueleto do perfil — mas o PRÓPRIO spike, na seção "3. Versão do CLI"
// (evidência empírica, listagem antes/depois idêntica), prova que
// `--version` é um comando estático que NÃO toca o filesystem de config. Quem
// de fato cria `.claude.json`/`.credentials.json` dentro do perfil, segundo a
// seção "4/5" do mesmo documento, é um `claude -p "<prompt>" --model haiku`
// não-interativo — mesmo SEM login (falha limpo com "Not logged in", exit 1,
// sem travar, sem gastar cota, efeito colateral do esqueleto já aconteceu
// antes do gate de auth). Este módulo segue a evidência empírica (seção 3+4/5),
// não a prosa de "Implicações" que a contradiz — `bootstrapProfileClaudeJson`
// roda um `-p` trivial, nunca `--version`.

/** Dirs compartilhados via junction — lista definitiva validada no spike (critério c). */
export const PROFILE_LINK_DIRS = ['projects', 'skills', 'commands', 'rules', 'plugins', 'templates'] as const;

/** Arquivos copiados (não linkados) na criação — cópia sincronizada, não hardlink (spike critério d). */
export const PROFILE_COPY_FILES = ['settings.json', 'CLAUDE.md'] as const;

const PROFILES_DIR_NAME = '.claude-profiles';
const CLAUDE_HOME_DIR_NAME = '.claude';
/** Nome do `.claude.json` — usado tanto pro global (`~/.claude.json`, irmão de `~/.claude/`) quanto pro do perfil (dentro do config dir do perfil) — mesmo nome, diretórios diferentes (spike seção 5). */
const CLAUDE_JSON_FILE_NAME = '.claude.json';
/** Metadado PRÓPRIO do Donel Dev (nunca lido/escrito pelo CLI) — guarda o nome de exibição exato do perfil (ex. "Tecnologia Claude 4"), já que o slug em disco é lossy (espaços/maiúsculas). */
const PROFILE_METADATA_FILE_NAME = '.donel-profile.json';

export const PRINCIPAL_PROFILE_SLUG = 'principal';

/** Perfil "principal" (FR-005): o próprio `~/.claude`, sem override de `CLAUDE_CONFIG_DIR`. */
export const PRINCIPAL_PROFILE: ProfileInfo = {
  name: 'Principal',
  slug: PRINCIPAL_PROFILE_SLUG,
  configDir: undefined,
  isPrimary: true,
};

export interface ProfileInfo {
  readonly name: string;
  readonly slug: string;
  /** Path do config dir do perfil (`~/.claude-profiles/<slug>`); `undefined` só pro perfil Principal. */
  readonly configDir: string | undefined;
  readonly isPrimary: boolean;
}

export interface ProfilePathsDeps {
  homedir: () => string;
}

export function profilesRootDir(deps: ProfilePathsDeps): string {
  return join(deps.homedir(), PROFILES_DIR_NAME);
}

export function claudeHomeDir(deps: ProfilePathsDeps): string {
  return join(deps.homedir(), CLAUDE_HOME_DIR_NAME);
}

/** `~/.claude.json` — irmão de `~/.claude/`, fora da árvore de junctions (spike, "passo crítico"). */
export function globalClaudeJsonPath(deps: ProfilePathsDeps): string {
  return join(deps.homedir(), CLAUDE_JSON_FILE_NAME);
}

export function profileDirPath(slug: string, deps: ProfilePathsDeps): string {
  return join(profilesRootDir(deps), slug);
}

/** kebab-case determinístico e nunca vazio — "Tecnologia Claude 4" -> "tecnologia-claude-4". */
export function slugifyProfileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos (NFD já os separou dos caracteres base)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'perfil';
}

/** Reconstrução de exibição pra perfis SEM metadado (ex. `spike-test`, criado à mão fora do app) — "spike-test" -> "Spike Test". Lossy de propósito: só usado como fallback (ver `PROFILE_METADATA_FILE_NAME`). */
export function titleCaseFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normaliza pra comparação de path Windows-safe: remove prefixo `\\?\` (readlinkSync às vezes devolve), resolve `.`/`..`, lowercase (NTFS é case-insensitive). */
export function normalizeWindowsPath(path: string): string {
  const withoutLongPrefix = path.startsWith('\\\\?\\') ? path.slice(4) : path;
  return normalize(withoutLongPrefix).toLowerCase();
}

// ---------------------------------------------------------------------------
// Plano de criação (PURO) — ordem exata do spike, item 2 de "Implicações":
// dir -> metadado -> 6 junctions -> 2 cópias -> bootstrap (.claude.json
// esqueleto) -> merge de mcpServers. O merge só pode rodar DEPOIS do
// bootstrap (o `.claude.json` do perfil não existe antes disso).
// ---------------------------------------------------------------------------

export type ProfileCreationStep =
  | { readonly kind: 'ensureDir'; readonly path: string }
  | { readonly kind: 'writeMetadata'; readonly configDir: string; readonly name: string }
  | { readonly kind: 'junction'; readonly dirName: string; readonly linkPath: string; readonly targetPath: string }
  | { readonly kind: 'copyFile'; readonly fileName: string; readonly sourcePath: string; readonly destPath: string }
  | { readonly kind: 'bootstrapClaudeJson'; readonly configDir: string }
  | { readonly kind: 'mergeMcpServers'; readonly configDir: string };

export interface ProfileCreationPlan {
  readonly profile: ProfileInfo;
  readonly steps: readonly ProfileCreationStep[];
}

/** Puro — nenhuma I/O. `createProfile` (mais abaixo) monta + executa. */
export function buildProfileCreationPlan(name: string, deps: ProfilePathsDeps): ProfileCreationPlan {
  const slug = slugifyProfileName(name);
  const configDir = profileDirPath(slug, deps);
  const claudeHome = claudeHomeDir(deps);

  const steps: ProfileCreationStep[] = [
    { kind: 'ensureDir', path: configDir },
    { kind: 'writeMetadata', configDir, name },
    ...PROFILE_LINK_DIRS.map(
      (dirName): ProfileCreationStep => ({
        kind: 'junction',
        dirName,
        linkPath: join(configDir, dirName),
        targetPath: join(claudeHome, dirName),
      }),
    ),
    ...PROFILE_COPY_FILES.map(
      (fileName): ProfileCreationStep => ({
        kind: 'copyFile',
        fileName,
        sourcePath: join(claudeHome, fileName),
        destPath: join(configDir, fileName),
      }),
    ),
    { kind: 'bootstrapClaudeJson', configDir },
    { kind: 'mergeMcpServers', configDir },
  ];

  return { profile: { name, slug, configDir, isPrimary: false }, steps };
}

/**
 * Merge PURO e programático (achado novo do spike, critério b) — nunca
 * hardlink/cópia do arquivo inteiro (carregaria identidade do perfil errado).
 * Preserva TUDO que o CLI já gravou no `.claude.json` do perfil
 * (`oauthAccount`, `machineID`, `userID`, `projects`, ...) e só sobrescreve a
 * chave `mcpServers` com a do global. Sem `mcpServers` no global, é no-op
 * (devolve `profileClaudeJson` inalterado).
 */
export function mergeMcpServersIntoProfile(
  profileClaudeJson: Record<string, unknown>,
  globalClaudeJson: Record<string, unknown>,
): Record<string, unknown> {
  if (!('mcpServers' in globalClaudeJson)) return profileClaudeJson;
  return { ...profileClaudeJson, mcpServers: globalClaudeJson.mcpServers };
}

export interface ProfileCreationIoDeps {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string) => void;
  writeFileText: (path: string, content: string) => void;
  copyFile: (sourcePath: string, destPath: string) => void;
  /** `fs.symlinkSync(targetPath, linkPath, 'junction')` real — não pede admin (CLAUDE.md gotcha). */
  createJunction: (targetPath: string, linkPath: string) => void;
  /**
   * `claude -p "OK" --model haiku` com `CLAUDE_CONFIG_DIR=configDir` —
   * best-effort, nunca lança (ver comentário de topo do arquivo). ASSÍNCRONO
   * DE PROPÓSITO: este passo roda dentro de um handler `ipcMain.handle`
   * (main/index.ts, `profiles:create`) — um `spawnSync` aqui bloquearia o
   * event loop do processo main INTEIRO (inclusive o streaming `pty:data` de
   * QUALQUER outra sessão claude já aberta) pelos até ~20s do bootstrap.
   */
  runBootstrapPrompt: (configDir: string) => Promise<void>;
  readClaudeJson: (path: string) => Record<string, unknown> | null;
  writeClaudeJson: (path: string, content: Record<string, unknown>) => void;
  globalClaudeJsonPath: string;
}

/** Executa o plano na ordem — cada passo é resiliente (nunca lança pra cima; falhas parciais viram estado que o `doctor` detecta depois). Async: só o passo `bootstrapClaudeJson` de fato aguarda algo (subprocesso), os demais são I/O síncrono local. */
export async function executeProfileCreationPlan(plan: ProfileCreationPlan, io: ProfileCreationIoDeps): Promise<void> {
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'ensureDir':
        if (!io.existsSync(step.path)) io.mkdirSync(step.path);
        break;

      case 'writeMetadata':
        io.writeFileText(join(step.configDir, PROFILE_METADATA_FILE_NAME), JSON.stringify({ name: step.name }, null, 2));
        break;

      case 'junction':
        if (!io.existsSync(step.linkPath)) io.createJunction(step.targetPath, step.linkPath);
        break;

      case 'copyFile':
        if (io.existsSync(step.sourcePath)) io.copyFile(step.sourcePath, step.destPath);
        break;

      case 'bootstrapClaudeJson':
        await io.runBootstrapPrompt(step.configDir);
        break;

      case 'mergeMcpServers': {
        const profileClaudeJson = io.readClaudeJson(join(step.configDir, CLAUDE_JSON_FILE_NAME));
        const globalClaudeJson = io.readClaudeJson(io.globalClaudeJsonPath);
        // Degradação com graça (ex. bootstrap falhou de vez, claude.exe ausente — CA-5):
        // sem os dois lados, não há o que mesclar; `doctor` reporta o drift depois.
        if (profileClaudeJson && globalClaudeJson) {
          const merged = mergeMcpServersIntoProfile(profileClaudeJson, globalClaudeJson);
          io.writeClaudeJson(join(step.configDir, CLAUDE_JSON_FILE_NAME), merged);
        }
        break;
      }
    }
  }
}

/** I/O — `claude -p "OK" --model haiku` assíncrono com timeout duro (mesma cautela do Start-Job de 30s do spike — nunca travar em prompt interativo), nunca lança/rejeita. */
function runBootstrapPromptAsync(claudeExecutablePath: string, configDir: string): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(claudeExecutablePath, ['-p', 'OK', '--model', 'haiku'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 20_000);

    // Perfil sem login sai com exit 1 "Not logged in" DE PROPÓSITO (spike
    // seção 4/5) — o efeito colateral desejado (.claude.json esqueleto) já
    // aconteceu antes do gate de auth. Qualquer outra falha (ENOENT, etc.)
    // também é absorvida aqui — bootstrap é best-effort, nunca rejeita.
    child.on('error', finish);
    child.on('close', finish);
  });
}

/** Deps reais (filesystem/processo da máquina) — só o main process usa. `claudeExecutablePath` vem de `resolveClaudeExecutable` (claude-executable.ts) — reaproveitado, não reimplementado aqui. */
export function createSystemProfileCreationIoDeps(claudeExecutablePath: string | null, deps: ProfilePathsDeps): ProfileCreationIoDeps {
  return {
    existsSync,
    mkdirSync: (path) => mkdirSync(path, { recursive: true }),
    writeFileText: (path, content) => writeFileSync(path, content, 'utf8'),
    copyFile: (sourcePath, destPath) => copyFileSync(sourcePath, destPath),
    createJunction: (targetPath, linkPath) => symlinkSync(targetPath, linkPath, 'junction'),
    runBootstrapPrompt: (configDir) => {
      if (!claudeExecutablePath) return Promise.resolve(); // CA-5 — claude não resolvido; nada a rodar, doctor reporta mcpServers ausente depois.
      return runBootstrapPromptAsync(claudeExecutablePath, configDir);
    },
    readClaudeJson: (path) => {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    writeClaudeJson: (path, content) => writeFileSync(path, JSON.stringify(content, null, 2), 'utf8'),
    globalClaudeJsonPath: globalClaudeJsonPath(deps),
  };
}

/** Conveniência ponta-a-ponta usada pelo IPC handler (main/index.ts): monta + executa o plano. */
export async function createProfile(name: string, pathDeps: ProfilePathsDeps, io: ProfileCreationIoDeps): Promise<ProfileInfo> {
  const plan = buildProfileCreationPlan(name, pathDeps);
  await executeProfileCreationPlan(plan, io);
  return plan.profile;
}

// ---------------------------------------------------------------------------
// Listagem — sempre inclui o Principal + varre `~/.claude-profiles/*` (não só
// perfis criados pelo app: `spike-test`, deixado no disco pelo T001, também
// precisa aparecer — ver spike seção 7 "fica no disco como insumo do T014").
// ---------------------------------------------------------------------------

export interface ProfileListDeps extends ProfilePathsDeps {
  /** Nomes das entradas diretamente sob `dirPath` (não filtra arquivo/dir — todo perfil é um dir, mas defensivo); [] se ilegível. */
  readDirNames: (dirPath: string) => string[];
  existsSync: (path: string) => boolean;
  /** Conteúdo de um arquivo de texto, ou `null` se ilegível/ausente. */
  readFileText: (path: string) => string | null;
}

function readProfileMetadata(configDir: string, deps: Pick<ProfileListDeps, 'readFileText'>): { name: string } | null {
  const raw = deps.readFileText(join(configDir, PROFILE_METADATA_FILE_NAME));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<{ name: string }>;
    return typeof parsed.name === 'string' && parsed.name.trim() ? { name: parsed.name } : null;
  } catch {
    return null;
  }
}

/** Principal sempre primeiro; demais perfis em ordem alfabética pelo nome de exibição. */
export function listProfiles(deps: ProfileListDeps): ProfileInfo[] {
  const root = profilesRootDir(deps);
  const slugs = deps.existsSync(root) ? deps.readDirNames(root) : [];

  const custom = slugs
    .map((slug): ProfileInfo => {
      const configDir = join(root, slug);
      const metadata = readProfileMetadata(configDir, deps);
      return { name: metadata?.name ?? titleCaseFromSlug(slug), slug, configDir, isPrimary: false };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return [PRINCIPAL_PROFILE, ...custom];
}

export function createSystemProfileListDeps(homedirFn: () => string): ProfileListDeps {
  return {
    homedir: homedirFn,
    existsSync,
    readDirNames: (dirPath) => {
      try {
        return readdirSync(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    readFileText: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Perfil ativo (persistido) — "trocar de perfil afeta só sessões novas"
// (FR-005). NOTA (2026-07-23, T015 — ConfigStore formal): `main/index.ts`
// PAROU de chamar `readActiveProfileConfig`/`writeActiveProfileConfig` —
// o perfil ativo passou a persistir dentro do `config.json` unificado
// (src/main/config-store.ts, campo `activeProfileSlug`), que MIGRA o
// conteúdo deste `active-profile.json` legado na 1ª leitura (parsing
// próprio, sem importar daqui — ver comentário de topo de config-store.ts).
// As duas funções abaixo continuam aqui, intocadas e testadas
// (profile-manager.test.ts), como referência do formato legado — módulo já
// auditado, fora do escopo do T015 reabrir.
// ---------------------------------------------------------------------------

export interface ActiveProfileConfig {
  readonly activeSlug: string;
}

const DEFAULT_ACTIVE_PROFILE_CONFIG: ActiveProfileConfig = { activeSlug: PRINCIPAL_PROFILE_SLUG };

export function readActiveProfileConfig(filePath: string): ActiveProfileConfig {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ActiveProfileConfig>;
    return {
      activeSlug: typeof parsed.activeSlug === 'string' && parsed.activeSlug.trim() ? parsed.activeSlug : PRINCIPAL_PROFILE_SLUG,
    };
  } catch {
    return { ...DEFAULT_ACTIVE_PROFILE_CONFIG };
  }
}

export function writeActiveProfileConfig(filePath: string, config: ActiveProfileConfig): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Profile doctor (FR-005: "verifica e recria junctions quebradas") — junction
// resolve pro alvo esperado; settings.json/CLAUDE.md presentes; mcpServers
// não divergiu silenciosamente (achado do spike, item 3 de "Implicações").
// ---------------------------------------------------------------------------

export type JunctionIssue =
  | { readonly dirName: string; readonly kind: 'missing' }
  | { readonly dirName: string; readonly kind: 'wrong-target'; readonly actualTarget: string; readonly expectedTarget: string };

export interface ProfileDoctorReport {
  readonly slug: string;
  readonly junctionIssues: readonly JunctionIssue[];
  readonly settingsMissing: boolean;
  readonly claudeMdMissing: boolean;
  /** true quando o global tem mcpServers configurados e o perfil não (drift — spike "Implicações" item 3). */
  readonly mcpServersDrift: boolean;
  readonly healthy: boolean;
}

export interface ProfileDoctorDeps {
  /** true se HÁ uma entrada no path (lstat — não segue o link; distingue "sem entrada" de "entrada com alvo quebrado"). */
  linkEntryExists: (path: string) => boolean;
  existsSync: (path: string) => boolean;
  /** Alvo bruto de uma junction (`fs.readlinkSync`), ou `null` se não for possível ler. */
  readJunctionTarget: (linkPath: string) => string | null;
  readClaudeJson: (path: string) => Record<string, unknown> | null;
  globalClaudeJsonPath: string;
}

export function hasMcpServersDrift(profileClaudeJson: Record<string, unknown> | null, globalClaudeJson: Record<string, unknown> | null): boolean {
  const globalServers = globalClaudeJson ? globalClaudeJson.mcpServers : undefined;
  if (!isRecord(globalServers) || Object.keys(globalServers).length === 0) return false; // global sem servers -> nada a exigir do perfil
  const profileServers = profileClaudeJson ? profileClaudeJson.mcpServers : undefined;
  return !isRecord(profileServers) || Object.keys(profileServers).length === 0;
}

/** Perfil Principal (sem `configDir`) é sempre saudável — não é isolado por junctions, não há o que checar. */
export function runProfileDoctor(profile: ProfileInfo, claudeHome: string, deps: ProfileDoctorDeps): ProfileDoctorReport {
  if (!profile.configDir) {
    return { slug: profile.slug, junctionIssues: [], settingsMissing: false, claudeMdMissing: false, mcpServersDrift: false, healthy: true };
  }
  const configDir = profile.configDir;

  const junctionIssues: JunctionIssue[] = [];
  for (const dirName of PROFILE_LINK_DIRS) {
    const linkPath = join(configDir, dirName);
    const expectedTarget = join(claudeHome, dirName);

    if (!deps.linkEntryExists(linkPath)) {
      junctionIssues.push({ dirName, kind: 'missing' });
      continue;
    }
    const actualTarget = deps.readJunctionTarget(linkPath);
    if (!actualTarget || normalizeWindowsPath(actualTarget) !== normalizeWindowsPath(expectedTarget)) {
      junctionIssues.push({ dirName, kind: 'wrong-target', actualTarget: actualTarget ?? '', expectedTarget });
    }
  }

  const settingsMissing = !deps.existsSync(join(configDir, 'settings.json'));
  const claudeMdMissing = !deps.existsSync(join(configDir, 'CLAUDE.md'));

  const profileClaudeJson = deps.readClaudeJson(join(configDir, CLAUDE_JSON_FILE_NAME));
  const globalClaudeJson = deps.readClaudeJson(deps.globalClaudeJsonPath);
  const mcpServersDrift = hasMcpServersDrift(profileClaudeJson, globalClaudeJson);

  return {
    slug: profile.slug,
    junctionIssues,
    settingsMissing,
    claudeMdMissing,
    mcpServersDrift,
    healthy: junctionIssues.length === 0 && !settingsMissing && !claudeMdMissing && !mcpServersDrift,
  };
}

export function createSystemProfileDoctorDeps(pathDeps: ProfilePathsDeps): ProfileDoctorDeps {
  return {
    linkEntryExists: (path) => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    },
    existsSync,
    readJunctionTarget: (linkPath) => {
      try {
        return readlinkSync(linkPath);
      } catch {
        return null;
      }
    },
    readClaudeJson: (path) => {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    globalClaudeJsonPath: globalClaudeJsonPath(pathDeps),
  };
}

// ---------------------------------------------------------------------------
// Reparo (ui-spec §6: "card exibe aviso + botão 'Recriar links'") — recria
// SÓ as junctions com problema, reaproveitando o mesmo `createJunction` do
// plano de criação; nunca mexe em settings.json/CLAUDE.md/.claude.json (o
// doctor só reporta drift nesses, não sobrescreve customização do usuário —
// spike critério d, "oferecer sincronizar, NÃO sincronizar sozinho").
// ---------------------------------------------------------------------------

export interface ProfileRepairIoDeps {
  linkEntryExists: (path: string) => boolean;
  /** Remove uma junction existente (`fs.rmdirSync` — reparse point de diretório no Windows). */
  removeJunction: (linkPath: string) => void;
  createJunction: (targetPath: string, linkPath: string) => void;
}

/** Recria as junctions listadas em `report.junctionIssues` (missing OU wrong-target); no-op se `report.junctionIssues` estiver vazio. */
export function repairProfileJunctions(profile: ProfileInfo, report: ProfileDoctorReport, claudeHome: string, io: ProfileRepairIoDeps): void {
  if (!profile.configDir) return;
  const configDir = profile.configDir;

  for (const issue of report.junctionIssues) {
    const linkPath = join(configDir, issue.dirName);
    const targetPath = join(claudeHome, issue.dirName);
    if (issue.kind === 'wrong-target' && io.linkEntryExists(linkPath)) {
      io.removeJunction(linkPath);
    }
    io.createJunction(targetPath, linkPath);
  }
}

export function createSystemProfileRepairIoDeps(): ProfileRepairIoDeps {
  return {
    linkEntryExists: (path) => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    },
    removeJunction: (linkPath) => rmdirSync(linkPath),
    createJunction: (targetPath, linkPath) => symlinkSync(targetPath, linkPath, 'junction'),
  };
}
