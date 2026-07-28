import { join } from 'node:path';
import type { DevModeBoardConfig } from '../shared/devMode';

// T309 (003-modo-dev, Batch A) — cliente MÍNIMO de leitura do board (CA-1/
// CA-2): porta de entrada da Zona 1, restrita às colunas Backlog/Discovery/
// Plano de UM board único configurado (`DevModeBoardConfig`).
//
// **Escopo estritamente Fatia 1** — nenhuma outra tool de leitura entra
// aqui; a lista fechada de tools do CA-11 (com token dedicado, superfície de
// rede nova) é Fatia 2 e chega em T324, que ESTENDE este arquivo com a
// implementação de sistema real. Por isso `TaskdexBoardReader` é só um
// contrato injetável aqui — sem `createSystemTaskdexBoardReader` ainda: essa
// é justamente a peça que T324 adiciona (credencial dedicada, C5).

/** Colunas restritas da porta de entrada (CA-1) — cards de outras colunas, inclusive concluídos, não aparecem. */
export type EntryColumn = 'backlog' | 'discovery' | 'plano';

const ENTRY_COLUMNS: readonly EntryColumn[] = ['backlog', 'discovery', 'plano'];

function isEntryColumn(column: string): column is EntryColumn {
  return (ENTRY_COLUMNS as readonly string[]).includes(column);
}

/** Shape cru devolvido pelo board (nome da coluna como string livre — validado por `isEntryColumn`). */
export interface TaskdexBoardCard {
  readonly cardId: string;
  readonly column: string;
  readonly title: string;
}

export interface EntryColumnCard {
  readonly cardId: string;
  readonly column: EntryColumn;
  readonly title: string;
}

/** Injetável (mesmo espírito de `ConfigIoDeps`/`EsteiraReaderIoDeps`) — a implementação de sistema chega em T324 (Fatia 2). */
export interface TaskdexBoardReader {
  fetchBoardCards(boardConfig: DevModeBoardConfig): Promise<readonly TaskdexBoardCard[]>;
}

/**
 * CA-1/CA-2 — lista só os cards das 3 colunas de entrada de UM board
 * configurado. `boardConfig` ausente é a porta de entrada desligada (não
 * erro): nem chama o `reader`. Card de coluna desconhecida é ignorado, nunca
 * lança.
 */
export async function listEntryColumnCards(
  boardConfig: DevModeBoardConfig | null,
  reader: TaskdexBoardReader,
): Promise<readonly EntryColumnCard[]> {
  if (!boardConfig) return [];

  const cards = await reader.fetchBoardCards(boardConfig);
  return cards
    .filter((card): card is TaskdexBoardCard & { column: EntryColumn } => isEntryColumn(card.column))
    .map((card) => ({ cardId: card.cardId, column: card.column, title: card.title }));
}

// ---------------------------------------------------------------------------
// T311 (Batch B) — de onde os cards vêm ENQUANTO a Fatia 2 não chega.
//
// O cliente de sistema real (rede + credencial dedicada + lista fechada de
// tools, CA-11) é a T324, da Fatia 2. Até lá a porta de entrada nasce
// DESLIGADA em produção — lista vazia, nunca um erro na cara do usuário
// (mesma degradação do `boardConfig` ausente logo acima). O único jeito de
// alimentá-la nesta fatia é apontar `DONEL_DEVMODE_BOARD_FIXTURE` para um
// arquivo JSON, que é o que o smoke roteirizado da Fatia 1 faz ("board
// mockado", tasks.md T322) — nenhuma chamada de rede, nenhum token.
// ---------------------------------------------------------------------------

/** Nome da variável de ambiente que aponta o board mockado do smoke (nunca usada em produção). */
export const BOARD_FIXTURE_ENV_VAR = 'DONEL_DEVMODE_BOARD_FIXTURE';

/** `null` = ausente/ilegível (mesmo contrato de `EsteiraReaderIoDeps.readFileText`). */
export type ReadFileText = (path: string) => string | null;

function toBoardCard(raw: unknown): TaskdexBoardCard | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<TaskdexBoardCard>;
  if (typeof candidate.cardId !== 'string' || !candidate.cardId) return null;
  if (typeof candidate.column !== 'string' || !candidate.column) return null;
  return { cardId: candidate.cardId, column: candidate.column, title: typeof candidate.title === 'string' ? candidate.title : '' };
}

/** Leitor de fixture: aceita `[...]` ou `{ cards: [...] }`. Nunca lança — arquivo ausente/corrompido vira `[]`. */
export function createFixtureTaskdexBoardReader(fixturePath: string, readFileText: ReadFileText): TaskdexBoardReader {
  return {
    fetchBoardCards: async (): Promise<readonly TaskdexBoardCard[]> => {
      const text = readFileText(fixturePath);
      if (text === null) return [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return [];
      }

      const rawCards = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { cards?: unknown }).cards)
          ? ((parsed as { cards: unknown[] }).cards)
          : [];

      return rawCards.map(toBoardCard).filter((card): card is TaskdexBoardCard => card !== null);
    },
  };
}

/** Reader vazio — a Fatia 1 sem fixture: a porta de entrada existe, só não tem fonte ainda (T324). */
const EMPTY_BOARD_READER: TaskdexBoardReader = { fetchBoardCards: async () => [] };

/** Escolhe o leitor a usar a partir do ambiente do processo (main). Sem fixture = leitor vazio. */
export function resolveBoardReader(env: Record<string, string | undefined>, readFileText: ReadFileText): TaskdexBoardReader {
  const fixturePath = env[BOARD_FIXTURE_ENV_VAR];
  if (!fixturePath) return EMPTY_BOARD_READER;
  return createFixtureTaskdexBoardReader(fixturePath, readFileText);
}

// ---------------------------------------------------------------------------
// T324 (003-modo-dev, Batch C) — cliente de leitura REAL do board (CA-11):
// credencial de serviço DEDICADA (fora do repo, mesmo padrão de
// `~/.claude/esteira-config/` — nunca em log nem versionada), restrita a uma
// LISTA FECHADA de tools de leitura. A lista é o próprio TIPO do parâmetro
// (`BoardReadTool`, união de literais) — não uma allowlist checada em
// runtime: chamar com uma tool fora da união falha em `npm run typecheck`,
// nunca em produção. Nenhuma tool de escrita entra neste arquivo (garantia
// estrutural, CA-11).
// ---------------------------------------------------------------------------

/**
 * Lista fechada de tools de leitura do MCP TaskDex usadas pelo espelho
 * (CA-11/CA-12). Cresce por PR (mais um literal na união), nunca por
 * allowlist de runtime que alguém possa esquecer de checar. Hoje contém a
 * única tool necessária: um `get_task_details` devolve, num payload só, os 4
 * fatos do CA-12 (coluna, trava/etiquetas via labels, PR+aprovação).
 */
export type BoardReadTool = 'get_task_details';

/** Assinatura restrita ao `BoardReadTool` — nem o fake de teste nem a implementação real aceitam `string` solto. */
export type CallBoardReadTool = (tool: BoardReadTool, params: { readonly cardId: string }) => Promise<unknown>;

/** Credencial de serviço dedicada (nunca a pessoal do usuário) — carregada de fora do repo. */
export interface TaskdexServiceCredential {
  readonly token: string;
  readonly baseUrl: string;
}

/** Os 4 fatos do CA-12 já mapeados, mais o título cru (usado pela conferência `[Mx]` do CA-14 em `boardAnnotation.ts`). */
export interface BoardFacts {
  readonly column: string;
  readonly title: string;
  /** `esteira:em-andamento:<fase>` do board, já sem o prefixo — `null` = sem trava (CA-13/D1). */
  readonly lockedPhase: string | null;
  /** Subconjunto presente entre `esteira:escalado`/`esteira:precisa-atencao` (CA-12). */
  readonly attentionLabels: readonly string[];
  readonly prUrl: string | null;
  readonly prApproved: boolean;
}

export interface BoardFactsReader {
  fetchBoardFacts(cardId: string): Promise<BoardFacts | null>;
}

const LOCK_LABEL_PREFIX = 'esteira:em-andamento:';
const ATTENTION_LABELS = ['esteira:escalado', 'esteira:precisa-atencao'] as const;

function lockedPhaseFromLabels(labels: readonly string[]): string | null {
  const lockLabel = labels.find((label) => label.startsWith(LOCK_LABEL_PREFIX));
  return lockLabel ? lockLabel.slice(LOCK_LABEL_PREFIX.length) : null;
}

function attentionLabelsFrom(labels: readonly string[]): readonly string[] {
  return ATTENTION_LABELS.filter((known) => labels.includes(known));
}

/** Shape cru esperado da resposta de `get_task_details` — validado campo a campo, nunca lançado (degrada para `null`). */
function toBoardFacts(raw: unknown): BoardFacts | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as {
    column?: unknown;
    title?: unknown;
    labels?: unknown;
    pullRequest?: { url?: unknown; approved?: unknown } | null;
  };
  if (typeof candidate.column !== 'string' || !candidate.column) return null;

  const labels = Array.isArray(candidate.labels) ? candidate.labels.filter((l): l is string => typeof l === 'string') : [];
  const pr = candidate.pullRequest;
  const prUrl = pr && typeof pr.url === 'string' && pr.url ? pr.url : null;
  const prApproved = !!pr && typeof pr.approved === 'boolean' && pr.approved;

  return {
    column: candidate.column,
    title: typeof candidate.title === 'string' ? candidate.title : '',
    lockedPhase: lockedPhaseFromLabels(labels),
    attentionLabels: attentionLabelsFrom(labels),
    prUrl,
    prApproved,
  };
}

/**
 * Reader de sistema (CA-11) — a chamada de rede/MCP em si é INJETADA
 * (`callTool`), nunca hardcoded aqui: quem monta o `callTool` real (fora do
 * escopo desta task) é quem sabe autenticar com a credencial dedicada. Este
 * módulo não loga nada — nem o payload, nem erro de chamada — então o token
 * nunca pode vazar por aqui (ele nem chega a este arquivo: mora em quem
 * implementa `callTool`).
 */
export function createSystemBoardFactsReader(callTool: CallBoardReadTool): BoardFactsReader {
  return {
    fetchBoardFacts: async (cardId: string): Promise<BoardFacts | null> => {
      if (!cardId) return null;
      const raw = await callTool('get_task_details', { cardId });
      return toBoardFacts(raw);
    },
  };
}

// ---------------------------------------------------------------------------
// T327 (003-modo-dev, Batch D) — a FONTE dos 4 fatos que chega até a UI.
//
// `createSystemBoardFactsReader` (T324) já existe, mas depende de um
// `callTool` real — o transporte MCP/rede autenticado pela credencial
// dedicada, que nenhuma task desta entrega especificou (nem endpoint, nem
// protocolo). Enquanto ele não existe, o espelho tem UMA fonte isolada: o
// mesmo arquivo de fixture da porta de entrada (`DONEL_DEVMODE_BOARD_FIXTURE`),
// agora também com uma chave `facts`. Sem fixture, o espelho fica sem fonte —
// `null` por card, exatamente a mesma degradação de `boardConfig` ausente
// (C4): a árvore continua inteira, só não recebe anotação. Nunca um erro na
// cara do usuário, e **nenhuma escrita** em lugar nenhum (invariante 5).
// ---------------------------------------------------------------------------

/** Leitor de fatos por fixture: reusa `toBoardFacts`, o MESMO mapeamento do reader de sistema — o teste exercita produção, não um atalho. */
export function createFixtureBoardFactsReader(fixturePath: string, readFileText: ReadFileText): BoardFactsReader {
  return {
    fetchBoardFacts: async (cardId: string): Promise<BoardFacts | null> => {
      const text = readFileText(fixturePath);
      if (text === null) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }

      if (typeof parsed !== 'object' || parsed === null) return null;
      const facts = (parsed as { facts?: unknown }).facts;
      if (typeof facts !== 'object' || facts === null) return null;

      return toBoardFacts((facts as Record<string, unknown>)[cardId]);
    },
  };
}

/** Espelho sem fonte — a Fatia 2 sem fixture e sem `callTool` real: nenhum fato, nenhum erro. */
const EMPTY_BOARD_FACTS_READER: BoardFactsReader = { fetchBoardFacts: async () => null };

/** Mesmo espírito de `resolveBoardReader`: escolhe a fonte a partir do ambiente do processo (main). */
export function resolveBoardFactsReader(env: Record<string, string | undefined>, readFileText: ReadFileText): BoardFactsReader {
  const fixturePath = env[BOARD_FIXTURE_ENV_VAR];
  if (!fixturePath) return EMPTY_BOARD_FACTS_READER;
  return createFixtureBoardFactsReader(fixturePath, readFileText);
}

/**
 * CA-12 — os fatos dos cards do discovery EM FOCO, e só deles: a consulta é
 * card a card, a partir da lista que o renderer manda, nunca uma varredura do
 * board. Card sem fato (ou consulta que falha) simplesmente não entra no mapa
 * — o espelho degrada por omissão, nunca lança nem loga (o token vive em quem
 * implementa `callTool`, e nada aqui escreve em log).
 */
export async function readBoardFactsFor(
  cardIds: readonly string[],
  reader: BoardFactsReader,
): Promise<Record<string, BoardFacts>> {
  const unique = [...new Set(cardIds.map((cardId) => cardId.trim()).filter((cardId) => cardId.length > 0))];
  const facts: Record<string, BoardFacts> = {};

  for (const cardId of unique) {
    try {
      const card = await reader.fetchBoardFacts(cardId);
      if (card) facts[cardId] = card;
    } catch {
      // Board indisponível para ESTE card: some do mapa. Um espelho que
      // derruba a árvore quando a rede oscila seria pior que um sem anotação.
    }
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Credencial de serviço dedicada — fora do repo, nunca versionada, nunca logada.
// ---------------------------------------------------------------------------

export interface TaskdexCredentialIoDeps {
  readonly readFileText: ReadFileText;
  readonly homedir: () => string;
}

/** Mesmo diretório de `~/.claude/esteira-config/` (spec.md) — arquivo dedicado deste app, nunca commitado. */
export function taskdexCredentialPath(homedirFn: () => string): string {
  return join(homedirFn(), '.claude', 'esteira-config', 'donel-board-credential.json');
}

function toCredential(raw: unknown): TaskdexServiceCredential | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<TaskdexServiceCredential>;
  if (typeof candidate.token !== 'string' || !candidate.token) return null;
  if (typeof candidate.baseUrl !== 'string' || !candidate.baseUrl) return null;
  return { token: candidate.token, baseUrl: candidate.baseUrl };
}

/**
 * `null` = ausente/ilegível/incompleta — o espelho fica sem fonte de fatos
 * (mesma degradação de `boardConfig` ausente, C4): nunca lança, e nunca loga
 * o conteúdo do arquivo (só campos booleanos de sucesso/falha em quem chama).
 */
export function loadTaskdexServiceCredential(io: TaskdexCredentialIoDeps): TaskdexServiceCredential | null {
  const text = io.readFileText(taskdexCredentialPath(io.homedir));
  if (text === null) return null;

  try {
    return toCredential(JSON.parse(text));
  } catch {
    return null;
  }
}
