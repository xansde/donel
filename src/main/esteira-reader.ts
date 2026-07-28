import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EsteiraPhase } from '../shared/devMode';

// T303 (003-modo-dev, Batch A) — leitura dos artefatos que a Esteira já grava
// em disco (achado 2/[MD-03]): `.esteira/<fase>/<card_id>-ctx.md` e
// `.esteira/<fase>/handoffs/<card_id>/<fase>-result.json`. Mesmo estilo de
// `config-store.ts`: I/O injetável, NUNCA lança — degrada para "não sei" em
// vez de crashar (C4). O app só LÊ; quem escreve estes arquivos é sempre a
// skill, nunca o app (invariante 5/CA-19).

export interface EsteiraReaderIoDeps {
  existsSync: (path: string) => boolean;
  /** `null` = ausente/ilegível — nunca lança. */
  readFileText: (path: string) => string | null;
}

export function createSystemEsteiraReaderIoDeps(): EsteiraReaderIoDeps {
  return {
    existsSync,
    readFileText: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Shape lido de `<fase>-result.json` (produzido pela SKILL, nunca pelo app). */
export interface EsteiraResultManifest {
  readonly card_id: string;
  readonly fase: string;
  readonly status: string; // "success" | outro valor = falhou (CA-15)
  readonly started_at: string;
  readonly finished_at: string;
  readonly executor: string;
  readonly model: string;
  readonly effort: string;
  readonly outputs: {
    readonly summary?: string;
    /** só no discovery-result.json — mapa card_id → marco_id (Modelo de domínio). */
    readonly fanout_cards?: readonly { card_id: string; marco_id: string }[];
    /** CA-8: os ÚNICOS artefatos declarados por uma fase — nunca varredura. */
    readonly artifact_paths?: readonly string[];
    readonly e2e_path?: string;
    readonly documents?: readonly string[];
    readonly knowledge?: { readonly repo_lessons?: string; readonly consulted?: unknown };
    readonly [key: string]: unknown;
  };
  readonly registrations?: {
    readonly taskdex?: unknown;
    readonly vault?: { readonly path: string | null; readonly section: string | null };
  };
  readonly next_fase_suggested?: string | null;
}

export interface PhaseArtifacts {
  readonly ctxPath: string; // .esteira/<fase>/<card_id>-ctx.md
  readonly resultPath: string; // .esteira/<fase>/handoffs/<card_id>/<fase>-result.json
  readonly ctxExists: boolean;
  readonly result: EsteiraResultManifest | null; // null = ausente OU ilegível
  /** C4 — distingue "ausente" de "ilegível": o nó mostra o que der pra ler + um marcador discreto, nunca crash. */
  readonly resultUnreadable: boolean;
  /** D3 — lidos do frontmatter do `ctx.md`; ausência de qualquer um dos dois é `null`, nunca erro. */
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

/**
 * A skill da Esteira grava `artifact_paths` como OBJETO nomeado
 * ({spec: "...", plan: "..."}), não como array — o tipo aqui prometia array e
 * o cast cru chegou ao renderer, onde o spread de um não-iterável derrubou a
 * árvore inteira (tela preta, 1º teste com manifesto real em 28/07). O reader
 * aceita os dois formatos e entrega SEMPRE lista de paths; valor de formato
 * desconhecido degrada para lista vazia (C4), nunca lança.
 */
function normalizePathList(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'object') {
    return Object.values(value).filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function normalizeManifest(parsed: EsteiraResultManifest): EsteiraResultManifest {
  const outputs = parsed.outputs;
  if (!outputs || typeof outputs !== 'object') return parsed;

  const artifactPaths = normalizePathList(outputs.artifact_paths);
  const documents = normalizePathList(outputs.documents);
  if (artifactPaths === outputs.artifact_paths && documents === outputs.documents) return parsed;

  return {
    ...parsed,
    outputs: {
      ...outputs,
      ...(artifactPaths !== undefined ? { artifact_paths: artifactPaths } : {}),
      ...(documents !== undefined ? { documents } : {}),
    },
  };
}

function esteiraCtxPath(repoPath: string, fase: EsteiraPhase, cardId: string): string {
  return join(repoPath, '.esteira', fase, `${cardId}-ctx.md`);
}

function esteiraResultPath(repoPath: string, fase: EsteiraPhase, cardId: string): string {
  return join(repoPath, '.esteira', fase, 'handoffs', cardId, `${fase}-result.json`);
}

/**
 * Extrai um campo escalar simples do bloco de frontmatter YAML (`---`...`---`
 * no topo do arquivo). Não é um parser YAML completo — só o suficiente para os
 * campos planos que o `ctx.md` da Esteira grava (`chave: valor` numa linha só).
 * `null`/`~`/vazio/ausente viram `null`, nunca lançam.
 */
function extractFrontmatterField(text: string, field: string): string | null {
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!frontmatterMatch) return null;

  const body = frontmatterMatch[1];
  const lineMatch = new RegExp(`^${field}:[ \\t]*(.*)$`, 'm').exec(body);
  if (!lineMatch) return null;

  const raw = lineMatch[1].trim();
  if (!raw || raw === 'null' || raw === '~') return null;
  return raw.replace(/^['"]|['"]$/g, '');
}

/** CA-8/CA-10/D3 — leitura pura de UMA fase de UM card. Nunca lança. */
export function readPhaseArtifacts(repoPath: string, fase: EsteiraPhase, cardId: string, io: EsteiraReaderIoDeps): PhaseArtifacts {
  const ctxPath = esteiraCtxPath(repoPath, fase, cardId);
  const resultPath = esteiraResultPath(repoPath, fase, cardId);

  const ctxExists = io.existsSync(ctxPath);
  const ctxText = ctxExists ? io.readFileText(ctxPath) : null;
  const worktreePath = ctxText ? extractFrontmatterField(ctxText, 'worktree_path') : null;
  const branch = ctxText ? extractFrontmatterField(ctxText, 'branch') : null;

  const resultExists = io.existsSync(resultPath);
  const resultText = resultExists ? io.readFileText(resultPath) : null;

  let result: EsteiraResultManifest | null = null;
  let resultUnreadable = false;
  if (resultText !== null) {
    try {
      result = normalizeManifest(JSON.parse(resultText) as EsteiraResultManifest);
    } catch {
      resultUnreadable = true;
    }
  }

  return { ctxPath, resultPath, ctxExists, result, resultUnreadable, worktreePath, branch };
}

/** CA-14/Modelo de domínio — mapa card_id → marco_id lido do `discovery-result.json` do card raiz. Nunca lança; ausente/ilegível/sem campo vira `[]`. */
export function readDiscoveryFanout(
  repoPath: string,
  cardId: string,
  io: EsteiraReaderIoDeps,
): readonly { cardId: string; marcoId: string }[] {
  const { result, resultUnreadable } = readPhaseArtifacts(repoPath, 'discovery', cardId, io);
  if (resultUnreadable || result === null) return [];

  const fanoutCards = result.outputs.fanout_cards;
  if (!fanoutCards) return [];

  return fanoutCards.map((entry) => ({ cardId: entry.card_id, marcoId: entry.marco_id }));
}
