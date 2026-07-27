import { createReadStream, promises as fs, type Dirent } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractCustomTitle, extractCustomTitleFromLine } from '../shared/sessionName';

// T012 — SessionIndexer (FR-004, plan.md ponto 4). Indexa as sessões
// anteriores do Claude Code para um projeto sem nunca carregar o transcript
// inteiro: stat (mtime/size) + streaming das primeiras linhas até achar a
// primeira mensagem de usuário genuína, mais uma leitura de cauda (tail)
// opcional/best-effort para a última atividade.
//
// Formato real inspecionado em `~/.claude/projects/<slug>/*.jsonl` (sessões
// deste e de outros projetos na máquina, anonimizadas nas fixtures de
// teste — ver tests/fixtures/sessions/):
// - Cada linha é um registro JSON solto (JSON Lines), não um array.
// - O transcript quase sempre ABRE com registros de controle antes da
//   primeira mensagem de usuário — `type: "custom-title"`, `type: "mode"`,
//   `type: "attachment"` (erros de hook não-bloqueantes, deltas de tools
//   deferidas) — nenhum deles tem `type: "user"`. O `custom-title` NÃO é mais
//   descartado (T403, 004-nomear-sessoes): é o nome que o `/rename` do CLI
//   grava, e vira o `customTitle` do summary.
// - Mensagens de slash-command aparecem como `type: "user"` com o texto
//   `<command-name>...</command-name>` (o aviso que normalmente vem antes,
//   `<local-command-caveat>`, já é filtrado por vir com `isMeta: true`).
//   Nenhuma das duas é "mensagem de usuário genuína" pela regra do FR-004.
// - `message.content` de uma linha `type: "user"` pode ser uma string
//   (mensagem digitada) OU um array de blocos de conteúdo — inclui blocos
//   `tool_result` (resposta injetada de uma tool call, nunca digitada pelo
//   usuário) e blocos `text` (mensagem real, às vezes ao lado de imagem).
//   Só um bloco `text` conta como "genuína"; um array sem bloco `text`
//   (ex.: só `tool_result`) é tratado como não-genuíno e o scan continua —
//   regra inferida da inspeção do formato real, não literal no FR-004, mas
//   necessária para não confundir uma resposta de tool com uma mensagem do
//   usuário.

export interface SessionSummary {
  /** Session id — nome do arquivo sem a extensão `.jsonl` (spec: "nome do arquivo"). */
  readonly id: string;
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly size: number;
  /** Primeira mensagem de usuário genuína (FR-004), ou um dos fallbacks abaixo. */
  readonly preview: string;
  /** true quando o transcript não tinha NENHUMA linha JSON válida (corrompido/truncado). */
  readonly corrupted: boolean;
  /** Timestamp (ms) da última atividade lido por tail; null se indisponível. */
  readonly lastActivityAt: number | null;
  /** T403 (004) — último `custom-title` do transcript (o nome dado por `/rename` no CLI); null se a sessão nunca foi renomeada. */
  readonly customTitle: string | null;
}

export interface IndexSessionsOptions {
  /** Raiz `~/.claude` a usar — injetável para testes; default = `defaultClaudeHome()`. */
  readonly claudeHome?: string;
}

// Fallback do FR-004: transcript bem-formado (linhas JSON válidas), mas sem
// nenhuma mensagem de usuário genuína entre elas.
const NO_USER_MESSAGE_FALLBACK = '(sem mensagem de usuário)';
// Fallback do ui-spec §5 (edge case): transcript corrompido/truncado — nenhuma
// linha pôde ser parseada como JSON.
const UNREADABLE_FALLBACK = '(ilegível)';

export const MAX_PREVIEW_LENGTH = 160;
const PREVIEW_ELLIPSIS = '…';

/** Bound de segurança: nunca varre mais que isso, mesmo num transcript patológico. */
const MAX_SCAN_LINES = 1000;

/**
 * Cauda lida numa passada só — nunca o arquivo inteiro. Era 8 KB (T012, só
 * `lastActivityAt`); subiu para 64 KB no T403 por MEDIÇÃO nos 317 transcripts
 * reais desta máquina (`specs/004-nomear-sessoes/medicao-t403.md`): a janela
 * de 8 KB alcança o último `custom-title` de apenas 44% deles, contra 99% com
 * 64 KB (mediana 10 KB do fim, p90 29 KB, máximo 0,2 MB). Cada miss custa uma
 * varredura completa do arquivo — em transcripts de 15 MB, é a diferença que
 * o usuário sente ao abrir a lista de sessões.
 * O `lastActivityAt` não muda de comportamento: a janela maior é um
 * superconjunto da antiga e a busca continua sendo "última linha válida".
 */
export const TAIL_READ_BYTES = 64 * 1024;

/**
 * Slug real observado nos diretórios de `~/.claude/projects/`: todo
 * caractere não-alfanumérico do path absoluto vira `-`, um por um, sem
 * colapsar repetições — confirmado contra um diretório real da máquina
 * (`.no-mistakes-worktrees` → `--no-mistakes-worktrees`, o `:` do drive e
 * cada `\` também viram `-`).
 */
export function slugifyProjectPath(absoluteProjectPath: string): string {
  return absoluteProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

export function defaultClaudeHome(): string {
  return join(homedir(), '.claude');
}

export function resolveProjectSessionsDir(projectPath: string, claudeHome: string): string {
  return join(claudeHome, 'projects', slugifyProjectPath(projectPath));
}

function truncatePreview(text: string): string {
  if (text.length <= MAX_PREVIEW_LENGTH) return text;
  return text.slice(0, MAX_PREVIEW_LENGTH - PREVIEW_ELLIPSIS.length) + PREVIEW_ELLIPSIS;
}

/** Casa `<command-name>`, `<command-args>`, `<local-command-caveat>`, `<local-command-stdout>`... */
const COMMAND_PAYLOAD_PATTERN = /<(local-)?command-[a-z-]+>/i;

/**
 * Extrai o texto "genuíno" de `message.content` de uma linha `type: user`
 * já filtrada por `isMeta`. Retorna `null` quando o conteúdo não é uma
 * mensagem de usuário genuína (payload de slash-command, bloco só de
 * `tool_result`, ou texto vazio após normalizar espaços).
 */
function extractGenuineText(content: unknown): string | null {
  let raw: string | null = null;

  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        raw = (block as { text: string }).text;
        break;
      }
    }
  }

  if (raw === null) return null;
  if (COMMAND_PAYLOAD_PATTERN.test(raw)) return null;

  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

interface RawTranscriptLine {
  readonly type?: unknown;
  readonly isMeta?: unknown;
  readonly message?: { readonly content?: unknown };
}

interface PreviewResult {
  readonly preview: string;
  readonly corrupted: boolean;
}

/**
 * Lê as primeiras linhas do transcript por streaming (nunca o arquivo
 * inteiro) até achar a primeira mensagem de usuário genuína (FR-004).
 * Tolera linhas JSON inválidas — uma linha corrompida não derruba o índice,
 * só é pulada; o transcript inteiro só vira "(ilegível)" quando NENHUMA
 * linha pôde ser parseada.
 *
 * `sizeHint` é o tamanho (bytes) já obtido via `stat` pelo chamador — um
 * arquivo de 0 bytes é tratado como "sem mensagem de usuário" (transcript
 * válido, só ainda vazio), não como corrompido.
 */
export async function readSessionPreview(filePath: string, sizeHint?: number): Promise<PreviewResult> {
  if (sizeHint === 0) {
    return { preview: NO_USER_MESSAGE_FALLBACK, corrupted: false };
  }

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let sawAnyValidJsonLine = false;
  let linesScanned = 0;
  let genuine: string | null = null;

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      linesScanned += 1;

      let parsed: RawTranscriptLine | undefined;
      try {
        parsed = JSON.parse(line) as RawTranscriptLine;
        sawAnyValidJsonLine = true;
      } catch {
        parsed = undefined;
      }

      if (parsed && parsed.type === 'user' && parsed.isMeta !== true) {
        const text = extractGenuineText(parsed.message?.content);
        if (text !== null) {
          genuine = text;
          break;
        }
      }

      if (linesScanned >= MAX_SCAN_LINES) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (genuine !== null) {
    return { preview: truncatePreview(genuine), corrupted: false };
  }
  if (sawAnyValidJsonLine) {
    return { preview: NO_USER_MESSAGE_FALLBACK, corrupted: false };
  }
  return { preview: UNREADABLE_FALLBACK, corrupted: true };
}

interface TailLine {
  readonly timestamp?: unknown;
}

export interface SessionTailInfo {
  /** Timestamp (ms) da última linha válida com `timestamp`; null se indisponível. */
  readonly lastActivityAt: number | null;
  /** Último `custom-title` do transcript INTEIRO (ver a nota sobre a janela de 8 KB abaixo). */
  readonly customTitle: string | null;
}

const EMPTY_TAIL_INFO: SessionTailInfo = { lastActivityAt: null, customTitle: null };

/**
 * Cache do resultado por `filePath` + (`mtimeMs`, `size`) — exigido pela
 * MEDIÇÃO do T403 (`specs/004-nomear-sessoes/medicao-t403.md`): o fallback de
 * varredura completa custa 754 ms no projeto mais pesado do Alexandre
 * (115 MB / 59 transcripts), acima do teto de ~300 ms fixado na task. A chave
 * é forte: qualquer append muda `size`, e um append que por acaso mantenha o
 * tamanho muda o `mtime`.
 *
 * O `main` é longevo, então o mapa é limpo inteiro ao passar do teto — não é
 * LRU de propósito: o custo de um miss é justamente o que o cache já paga uma
 * vez, e uma política mais esperta seria estrutura sem necessidade provada.
 */
const MAX_TAIL_CACHE_ENTRIES = 4000;
const tailInfoCache = new Map<string, { mtimeMs: number; size: number; info: SessionTailInfo }>();

/** Só para testes — o cache é global e sobreviveria entre casos. */
export function clearSessionTailCache(): void {
  tailInfoCache.clear();
}

/**
 * Best-effort: lê só a cauda do arquivo buscando, na MESMA passada, o
 * `timestamp` da última linha válida e o último `custom-title` (T403). Nunca
 * lança — qualquer falha vira `null` nos dois campos.
 *
 * **A janela de 8 KB e o `custom-title`.** Um `/rename` feito no começo de uma
 * sessão longa fica fora da cauda, e é justamente o caso de uso principal
 * (reachar uma sessão de semanas atrás pelo nome). Por isso, quando o arquivo
 * é maior que a cauda E a cauda não trouxe título, cai-se numa varredura
 * completa por streaming. A ordem está correta em todos os casos: se a cauda
 * tem um título, ele é por definição o último do arquivo; se não tem, só a
 * varredura completa responde. Custo medido antes de fixar esta escolha — ver
 * `specs/004-nomear-sessoes/medicao-t403.md`.
 */
export async function readSessionTailInfo(
  filePath: string,
  size: number,
  mtimeMs?: number,
): Promise<SessionTailInfo> {
  if (size <= 0) return EMPTY_TAIL_INFO;

  const cached = mtimeMs === undefined ? undefined : tailInfoCache.get(filePath);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.info;

  const info = await readSessionTailInfoUncached(filePath, size);

  if (mtimeMs !== undefined) {
    if (tailInfoCache.size >= MAX_TAIL_CACHE_ENTRIES) tailInfoCache.clear();
    tailInfoCache.set(filePath, { mtimeMs, size, info });
  }
  return info;
}

/**
 * Últimos `maxBytes` do arquivo como texto, ou `null` em qualquer falha (nunca
 * lança). Extraído para helper porque o `transcript-watcher.ts` (T411) precisa
 * da MESMA leitura de cauda — duplicar o bloco de `fs.open`/`read` seria manter
 * duas versões da mesma mecânica.
 */
export async function readFileTail(
  filePath: string,
  size: number,
  maxBytes: number = TAIL_READ_BYTES,
): Promise<string | null> {
  if (size <= 0) return null;

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readSessionTailInfoUncached(filePath: string, size: number): Promise<SessionTailInfo> {
  const tailText = await readFileTail(filePath, size);
  if (tailText === null) return EMPTY_TAIL_INFO;

  const lastActivityAt = extractLastTimestamp(tailText);
  const tailTitle = extractCustomTitle(tailText);
  if (tailTitle !== null || size <= TAIL_READ_BYTES) {
    // Cauda com título já é a resposta final; e num arquivo que cabe inteiro
    // na cauda, "não achou na cauda" == "não existe no arquivo".
    return { lastActivityAt, customTitle: tailTitle };
  }

  return { lastActivityAt, customTitle: await scanFullFileForCustomTitle(filePath) };
}

/**
 * Compat: o `lastActivityAt` sozinho (contrato do T012). Continua exportado
 * porque é o contrato testado do módulo; internamente é a mesma leitura de
 * `readSessionTailInfo`.
 */
export async function readLastActivity(filePath: string, size: number): Promise<number | null> {
  const { lastActivityAt } = await readSessionTailInfo(filePath, size);
  return lastActivityAt;
}

function extractLastTimestamp(tailText: string): number | null {
  const lines = tailText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as TailLine;
      if (typeof parsed.timestamp === 'string') {
        const ms = Date.parse(parsed.timestamp);
        if (!Number.isNaN(ms)) return ms;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fallback do gotcha acima: varre o arquivo inteiro por streaming (linha a
 * linha, nunca carregando tudo em memória) guardando o ÚLTIMO `custom-title`.
 * Nunca lança.
 */
async function scanFullFileForCustomTitle(filePath: string): Promise<string | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lastTitle: string | null = null;
  try {
    for await (const rawLine of rl) {
      const title = extractCustomTitleFromLine(rawLine);
      if (title !== null) lastTitle = title;
    }
  } catch {
    return lastTitle;
  } finally {
    rl.close();
    stream.destroy();
  }
  return lastTitle;
}

/**
 * Índice das sessões anteriores de um projeto (FR-004, CA-2). Lista
 * `~/.claude/projects/<slug>/*.jsonl` só no nível raiz do diretório —
 * transcripts de subagentes vivem aninhados em `<session-id>/subagents/` e
 * nunca entram na lista. Um projeto que nunca abriu sessão retorna `[]` sem
 * lançar. Ordenado por `mtimeMs` decrescente (mais recente primeiro, CA-2:
 * "as 3 sessões aparecem ordenadas por data").
 */
export async function indexProjectSessions(
  projectPath: string,
  opts: IndexSessionsOptions = {},
): Promise<SessionSummary[]> {
  const claudeHome = opts.claudeHome ?? defaultClaudeHome();
  const dir = resolveProjectSessionsDir(projectPath, claudeHome);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));

  const summaries = await Promise.all(
    jsonlFiles.map(async (entry): Promise<SessionSummary> => {
      const filePath = join(dir, entry.name);
      const stats = await fs.stat(filePath);
      const [{ preview, corrupted }, { lastActivityAt, customTitle }] = await Promise.all([
        readSessionPreview(filePath, stats.size),
        readSessionTailInfo(filePath, stats.size, stats.mtimeMs),
      ]);
      return {
        id: entry.name.slice(0, -'.jsonl'.length),
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        preview,
        corrupted,
        lastActivityAt,
        customTitle,
      };
    }),
  );

  return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
