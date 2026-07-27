import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProfileHeadroomMap, ProfileQuota, QuotaWindow } from '../shared/profiles';

// T014 — FR-012 (US-7): % de headroom de quota por perfil, via `quota-axi`
// (`npx -y quota-axi --provider claude --json` — SKILL.md do quota-axi,
// ~/.claude/skills/quota-axi) rodado com `CLAUDE_CONFIG_DIR` apontado pro
// perfil (undefined = perfil Principal, sem override — lê a config global).
//
// GOTCHA descoberto NESTA task (não estava no spike nem na skill do
// quota-axi — confirmado rodando o CLI real): o cache do quota-axi
// (`~/.cache/quota-axi/quotas.json`) é ÚNICO/GLOBAL, NÃO escopado por
// `CLAUDE_CONFIG_DIR`. Reprodução: chamado contra o perfil global
// (autenticado) devolveu `state.status: "fresh"` com números corretos e
// gravou esse payload no cache global; chamado em seguida contra um perfil
// SEM sessão válida devolveu OS MESMOS NÚMEROS do perfil anterior, mas com
// `source: "cache"`, `state.stale: true` e
// `state.error: "Claude sign-in required"` — ou seja, sem essa guarda, a UI
// mostraria a quota de um perfil rotulada como se fosse de outro. Regra
// dura: `state.stale`/`state.error` presentes SEMPRE viram "sem dados"
// (`null`), mesmo com `windows` populado — nunca confiar em números vindos
// de um fallback de cache que pode pertencer a outro perfil (ver
// `parseQuotaAxiHeadroom`).

export interface QuotaAxiWindow {
  readonly id: string;
  readonly kind?: string;
  readonly percentRemaining?: number;
  /** T201 — reset da janela (ISO) quando o payload traz; `model:fable` pode vir sem esse campo -> tolerar `undefined`/`null`. */
  readonly resetsAt?: string | null;
  /** T201 — rótulo opcional vindo do quota-axi (não usado hoje pela UI — a UI rotula por posição/`id`, não por este campo; mantido pra não descartar dado do payload). */
  readonly label?: string;
}

export interface QuotaAxiProviderReport {
  readonly provider: string;
  readonly windows?: readonly QuotaAxiWindow[];
  readonly state?: { readonly stale?: boolean; readonly error?: string; readonly status?: string };
}

export interface QuotaAxiOutput {
  readonly providers?: readonly QuotaAxiProviderReport[];
}

/** Ids das janelas do payload `quota-axi --json` mapeados pro shape `ProfileQuota` (T201/T202). `model:fable` é a única janela de modelo suportada nesta entrega (spec.md "fora de escopo": outras `model:*` ficam pro painel US-12). */
const FIVE_HOUR_WINDOW_ID = 'five_hour';
const SEVEN_DAY_WINDOW_ID = 'seven_day';
const FABLE_WINDOW_ID = 'model:fable';

/** `unavailable` fixo — devolvido tanto por payload sem provider `claude`/janelas quanto por `state.stale`/`state.error` (regra dura CA-5, ver comentário de topo do módulo). Const módulo-level: as 3 janelas nulas são reaproveitadas em todo caminho "sem dado confiável", nunca reconstruídas objeto-a-objeto (evita 3 literais divergentes acidentalmente). */
const UNAVAILABLE_QUOTA: ProfileQuota = { status: 'unavailable', fiveHour: null, sevenDay: null, fable: null };

function extractWindow(windows: readonly QuotaAxiWindow[] | undefined, windowId: string): QuotaWindow | null {
  const found = windows?.find((w) => w.id === windowId);
  if (!found || typeof found.percentRemaining !== 'number') return null;
  return { percentRemaining: Math.round(found.percentRemaining), resetsAt: found.resetsAt ?? null };
}

/**
 * Puro — extrai as 3 janelas (`five_hour`/`seven_day`/`model:fable`) do
 * payload `--json` do quota-axi pro provider `claude`, no shape
 * `ProfileQuota` (T202). Regra dura do gotcha de topo do módulo:
 * `state.stale`/`state.error` (ou ausência do provider `claude`) SEMPRE
 * vira `UNAVAILABLE_QUOTA` — nunca um número vindo de fallback de cache que
 * pode ser de OUTRO perfil. Janela ausente/sem `percentRemaining` numérico
 * vira `null` só NAQUELA janela (sucesso parcial ainda é `status: 'ok'`).
 */
export function parseQuotaAxiWindows(output: QuotaAxiOutput | null | undefined): ProfileQuota {
  const claude = output?.providers?.find((provider) => provider.provider === 'claude');
  if (!claude) return UNAVAILABLE_QUOTA;
  if (claude.state?.stale || claude.state?.error) return UNAVAILABLE_QUOTA;

  return {
    status: 'ok',
    fiveHour: extractWindow(claude.windows, FIVE_HOUR_WINDOW_ID),
    sevenDay: extractWindow(claude.windows, SEVEN_DAY_WINDOW_ID),
    fable: extractWindow(claude.windows, FABLE_WINDOW_ID),
  };
}

/**
 * Seletor derivado (T201) — mantido pra quem só precisa do headroom
 * "principal" como número (era o contrato original, pré-002). 5h primária
 * ("dá pra continuar trabalhando agora?"), cai pra semanal quando a janela
 * de sessão não vier no payload. Construído em cima de
 * `parseQuotaAxiWindows` — nunca duplica a regra stale/error.
 */
export function parseQuotaAxiHeadroom(output: QuotaAxiOutput | null | undefined): number | null {
  const quota = parseQuotaAxiWindows(output);
  if (quota.status !== 'ok') return null;
  return quota.fiveHour?.percentRemaining ?? quota.sevenDay?.percentRemaining ?? null;
}

/**
 * FIX (feedback E2E rodada 4, item 8, parte a) — evidência real coletada
 * pelo Alexandre: `npx -y quota-axi --provider claude --json` standalone
 * devolveu JSON VÁLIDO no stdout (percentUsed 32, five_hour) com EXIT CODE
 * 255 (não é um código documentado do quota-axi — SKILL.md só documenta
 * 0/1/2 — indício de que é ruído do wrapper `npx`/`cmd.exe` no Windows, não
 * do próprio quota-axi). INVESTIGAÇÃO desta task: o `close` handler abaixo
 * JÁ NÃO checava `code` antes deste fix (só tentava `JSON.parse(stdout)`
 * incondicionalmente) — a causa raiz do "headroom sumiu" no app não era
 * esta função (era 100% a UI, ver ProfileSwitcher.tsx `HeadroomSlot`).
 * Ainda assim, endurece explicitamente o contrato pedido pela task
 * ("validar pelo CONTEÚDO, nunca pelo exit code"): `parseJsonPayload`
 * abaixo tenta `JSON.parse` direto e, se falhar, tenta extrair o primeiro
 * objeto `{...}` balanceado do stdout — defesa contra ruído
 * extra (warning/prompt do npx) antes/depois do JSON de verdade que
 * poderia quebrar um `JSON.parse` direto em outra máquina/versão do npx.
 * `code`/`signal` do processo NUNCA decidem sucesso/falha — só o conteúdo.
 */
function parseJsonPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    if (start === -1) throw new Error('quota-axi: nenhum objeto JSON encontrado no stdout');
    let depth = 0;
    for (let i = start; i < raw.length; i += 1) {
      if (raw[i] === '{') depth += 1;
      else if (raw[i] === '}') {
        depth -= 1;
        if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
      }
    }
    throw new Error('quota-axi: objeto JSON no stdout está incompleto/desbalanceado');
  }
}

/** FR-012: timeout por perfil (as leituras dos N perfis rodam em paralelo — ver `readAllProfilesHeadroom` — um perfil lento nunca trava os demais). 8s (era 3s) porque `npx -y quota-axi` sozinho já mede ~10.8s de overhead de resolução do npx no Windows; rodar o binário resolvido direto via node (ver `resolveQuotaAxiCli`) roda em ~1.6s, mas o fallback pra npx (quando o resolver não acha nada) ainda precisa da folga. */
const DEFAULT_TIMEOUT_MS = 8000;

let cachedCliPath: string | null = null;

/**
 * Varre o cache do npx (`npm-cache/_npx/<hash>/node_modules/quota-axi/dist/bin/quota-axi.js`)
 * e devolve o path do binário mais recente (por mtime), ou `null` se não
 * achar. Raízes de busca: `%LOCALAPPDATA%/npm-cache/_npx` (Windows padrão),
 * fallback `~/AppData/Local/npm-cache/_npx` e `~/.npm/_npx` (POSIX). Nunca
 * lança — qualquer erro de fs (readdir/stat) é ignorado e a varredura
 * continua pra próxima raiz. Memoiza só o hit válido (path que ainda existe);
 * um miss anterior ou um path memoizado que sumiu do disco disparam nova
 * varredura na próxima chamada.
 */
export function resolveQuotaAxiCli(): string | null {
  if (cachedCliPath && existsSync(cachedCliPath)) return cachedCliPath;
  cachedCliPath = null;

  const roots: string[] = [];
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'));
  roots.push(join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx'));
  roots.push(join(homedir(), '.npm', '_npx'));

  let best: { path: string; mtimeMs: number } | null = null;

  for (const root of roots) {
    try {
      if (!existsSync(root)) continue;
      const hashes = readdirSync(root);
      for (const hash of hashes) {
        const cliPath = join(root, hash, 'node_modules', 'quota-axi', 'dist', 'bin', 'quota-axi.js');
        try {
          if (!existsSync(cliPath)) continue;
          const stat = statSync(cliPath);
          if (!best || stat.mtimeMs > best.mtimeMs) {
            best = { path: cliPath, mtimeMs: stat.mtimeMs };
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  cachedCliPath = best?.path ?? null;
  return cachedCliPath;
}

export interface RunQuotaAxiOptions {
  /** `CLAUDE_CONFIG_DIR` do perfil; `undefined` = perfil Principal (sem override, lê `~/.claude` global). */
  readonly configDir: string | undefined;
  readonly timeoutMs?: number;
  /** Env base a partir do qual montar o env do child (injetável pra teste; default = `process.env` no ponto de chamada real). */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Resolve o path do binário `quota-axi.js` no cache do npx (injetável pra teste; default = `resolveQuotaAxiCli`). `null` => fallback pro `npx -y quota-axi`. */
  readonly resolveCli?: () => string | null;
  /** Executável node usado pra rodar o binário resolvido (injetável pra teste; default = `process.execPath`). */
  readonly nodeExecPath?: string;
}

/**
 * I/O — spawna o quota-axi. FIX (batch A, 002-quota-headroom): `npx -y
 * quota-axi` sozinho tem ~10.8s de overhead de resolução no Windows (matava
 * no timeout antigo de 3s, resultando em "—" sempre). Preferência: resolver
 * o binário `quota-axi.js` já baixado no cache do npx
 * (`resolveQuotaAxiCli`) e rodá-lo direto via `nodeExecPath` (com
 * `ELECTRON_RUN_AS_NODE=1`, sem `shell: true`) — ~1.6s. Fallback (binário
 * não encontrado no cache): `npx -y quota-axi --provider claude --json` com
 * `shell: true` (npx no Windows é `.cmd`/`.ps1`), como antes. Nunca lança:
 * timeout, erro de spawn ou JSON inválido viram `null` (mesmo espírito de
 * "sem dados" do resto do app — SessionIndexer, ProjectScanner).
 */
export function readQuotaAxiQuota(options: RunQuotaAxiOptions): Promise<ProfileQuota> {
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };
  if (options.configDir) {
    env.CLAUDE_CONFIG_DIR = options.configDir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }

  // SEAM DE TESTE (T205, 002-quota-headroom) — os smokes deste app rodam
  // isolados do `%APPDATA%` real e a regra do projeto proíbe abrir sessão
  // claude real só pra ler cota (nenhum número determinístico disponível em
  // CI/dev). Quando `DONEL_QUOTA_AXI_FIXTURE` aponta pra um arquivo JSON, o
  // conteúdo dele SUBSTITUI o payload que normalmente viria do stdout do
  // processo `quota-axi` — mas passa pelo MESMO `parseQuotaAxiWindows` que o
  // caminho real usa (a costura injeta o payload bruto, nunca o resultado
  // já parseado, pra continuar exercitando a regra CA-5 de verdade). Nunca
  // spawna processo nenhum neste ramo. Fora de teste a variável não existe
  // -> comportamento normal abaixo, inalterado.
  const fixturePath = env.DONEL_QUOTA_AXI_FIXTURE;
  if (fixturePath) {
    return Promise.resolve().then(() => {
      try {
        const raw = readFileSync(fixturePath, 'utf8');
        return parseQuotaAxiWindows(JSON.parse(raw) as QuotaAxiOutput);
      } catch {
        return UNAVAILABLE_QUOTA;
      }
    });
  }

  return new Promise((resolve) => {
    const resolveCli = options.resolveCli ?? resolveQuotaAxiCli;
    const cliPath = resolveCli();

    let child: ReturnType<typeof spawn>;
    try {
      if (cliPath) {
        const nodeExecPath = options.nodeExecPath ?? process.execPath;
        child = spawn(nodeExecPath, [cliPath, '--provider', 'claude', '--json'], {
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
        });
      } else {
        child = spawn('npx', ['-y', 'quota-axi', '--provider', 'claude', '--json'], { env, windowsHide: true, shell: true });
      }
    } catch {
      resolve(UNAVAILABLE_QUOTA);
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (result: ProfileQuota): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(UNAVAILABLE_QUOTA);
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(UNAVAILABLE_QUOTA));
    // `code`/`signal` recebidos de propósito (documentam a decisão) mas
    // NUNCA usados pra decidir sucesso/falha — só o conteúdo de `stdout`
    // decide (ver comentário de `parseJsonPayload` acima, fix rodada 4
    // item 8: exit code do quota-axi via npx no Windows não é confiável).
    child.on('close', (_code, _signal) => {
      try {
        finish(parseQuotaAxiWindows(parseJsonPayload(stdout) as QuotaAxiOutput));
      } catch {
        finish(UNAVAILABLE_QUOTA);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Cache de 60s por perfil (FR-012) — em memória, vive no main process
// (mesmo módulo/instância reaproveitada entre chamadas de `profiles:headroom`).
// ---------------------------------------------------------------------------

const HEADROOM_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly quota: ProfileQuota;
  readonly cachedAt: number;
}

export class HeadroomCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** `undefined` = sem entrada válida (nunca lido, TTL expirado, ou última leitura foi `unavailable`) — chamador deve ler de verdade. */
  get(slug: string): ProfileQuota | undefined {
    const entry = this.entries.get(slug);
    if (!entry) return undefined;
    if (this.now() - entry.cachedAt > HEADROOM_CACHE_TTL_MS) return undefined;
    return entry.quota;
  }

  /**
   * T203 (CA-5, decisão 24/07) — `unavailable` NUNCA é cacheado: só `ok`
   * respeita o TTL de 60s. Motivo: um perfil sem login que acaba de fazer
   * `/login` precisa refletir na PRÓXIMA leitura, sem esperar o TTL expirar
   * (o custo de reler `unavailable` é baixo — o processo falha rápido/dá
   * timeout; o custo de reler `ok` é caro, ~1.6-8s, por isso esse sim é
   * cacheado). Ignorar o `set` aqui é suficiente pro `get` nunca devolver
   * uma entrada `unavailable` — não precisa de checagem extra no `get`.
   */
  set(slug: string, quota: ProfileQuota): void {
    if (quota.status === 'unavailable') return;
    this.entries.set(slug, { quota, cachedAt: this.now() });
  }
}

export interface ProfileHeadroomTarget {
  readonly slug: string;
  readonly configDir: string | undefined;
}

export interface ReadAllProfilesHeadroomOptions {
  /** T205 (botão "Atualizar") — ignora o `cache.get` (mas ainda faz `cache.set` do resultado, se `ok`); pré-requisito da Fase B, não usado ainda nesta fase. */
  readonly force?: boolean;
}

/**
 * FR-012 — leituras em PARALELO (`Promise.all`, nunca sequencial: um perfil
 * lento não atrasa os outros); cada leitura individual já carrega seu
 * próprio timeout de 8s (`readQuotaAxiQuota`/`reader`). Cache de 60s evita
 * reabrir processo toda vez que o dropdown é aberto — mas só pra `ok`
 * (`unavailable` sempre relido, ver `HeadroomCache.set`).
 */
export async function readAllProfilesHeadroom(
  profiles: readonly ProfileHeadroomTarget[],
  cache: HeadroomCache,
  reader: (options: RunQuotaAxiOptions) => Promise<ProfileQuota> = readQuotaAxiQuota,
  options?: ReadAllProfilesHeadroomOptions,
): Promise<ProfileHeadroomMap> {
  const entries = await Promise.all(
    profiles.map(async (profile): Promise<readonly [string, ProfileQuota]> => {
      const cached = options?.force ? undefined : cache.get(profile.slug);
      if (cached !== undefined) return [profile.slug, cached];

      const quota = await reader({ configDir: profile.configDir });
      cache.set(profile.slug, quota);
      return [profile.slug, quota];
    }),
  );
  return Object.fromEntries(entries);
}
