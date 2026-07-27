// T701–T703 (007-favoritos-sessoes, Fatia 0) — modelo puro do registro de
// sessões recentes/fixadas por projeto favoritado. É a peça que decide o que
// pode dar errado na feature (spec.md CA-2, CA-3, CA-5, CA-11; discovery.md
// D2, D9): a fonte de verdade da lista no boot é este registro, mantido
// durante o trabalho pelo RENDERER (plan.md §Fatia 2 — único escritor) — nunca
// uma varredura de `~/.claude`.
//
// Regra dura (D9/plan.md §Fatia 0): poda na ESCRITA, não na leitura. Cada
// `upsertVisit` mantém, por projeto, as `RECENT_PER_PROJECT` (5) sessões
// NÃO-fixadas mais recentes + TODAS as fixadas (CA-2, sem teto — C4). Isso
// mantém o `config.json` pequeno sem precisar de GC depois (§B12).
//
// Módulo puro de propósito: sem fs, sem Electron, sem React.

export interface RegisteredSession {
  readonly sessionId: string;
  readonly projectPath: string;
  /** Rótulo em cache (C1) — o nome resolvido (`resolveSessionName`) no momento da última visita. */
  readonly label: string;
  readonly lastActivityAt: number;
  readonly pinned: boolean;
}

export type SessionRegistry = Readonly<Record<string, RegisteredSession>>;

/** D2/CA-2 — falas verbatim do discovery: "as últimas 5 sessões daquele projeto". */
export const RECENT_PER_PROJECT = 5;

export interface VisitInput {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly label: string;
  readonly atMs: number;
}

/**
 * Por projeto: mantém as `RECENT_PER_PROJECT` NÃO-fixadas mais recentes +
 * TODAS as fixadas (CA-2, sem teto — C4). Entradas de OUTROS projetos nunca
 * são tocadas. No-op se o projeto não tiver nenhuma entrada.
 */
export function pruneProject(registry: SessionRegistry, projectPath: string): SessionRegistry {
  const projectEntries = Object.values(registry).filter((entry) => entry.projectPath === projectPath);
  if (projectEntries.length === 0) return registry;

  const pinnedIds = new Set(projectEntries.filter((entry) => entry.pinned).map((entry) => entry.sessionId));
  const keptNonPinnedIds = new Set(
    projectEntries
      .filter((entry) => !entry.pinned)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, RECENT_PER_PROJECT)
      .map((entry) => entry.sessionId),
  );

  const next: Record<string, RegisteredSession> = {};
  for (const [sessionId, entry] of Object.entries(registry)) {
    if (entry.projectPath !== projectPath || pinnedIds.has(sessionId) || keptNonPinnedIds.has(sessionId)) {
      next[sessionId] = entry;
    }
  }
  return next;
}

/**
 * Grava a visita e poda o projeto NA MESMA operação (plan.md §Fatia 0, regra
 * dura #1). Visita em sessão já fixada preserva `pinned` (regra #2) — só
 * `setPinned` muda esse campo. `sessionId`/`projectPath` vazios, ou `label`
 * vazio (só espaço), são no-op — nunca cria uma linha sem texto (T701 DoD).
 */
export function upsertVisit(registry: SessionRegistry, visit: VisitInput): SessionRegistry {
  const { sessionId, projectPath, label, atMs } = visit;
  if (!sessionId || !projectPath || !label.trim()) return registry;

  const existing = registry[sessionId];
  const nextEntry: RegisteredSession = {
    sessionId,
    projectPath,
    label,
    lastActivityAt: atMs,
    pinned: existing?.pinned ?? false,
  };
  const withVisit: SessionRegistry = { ...registry, [sessionId]: nextEntry };
  return pruneProject(withVisit, projectPath);
}

/**
 * Fixar marca; desfixar NÃO remove — a sessão volta a concorrer pelas
 * `RECENT_PER_PROJECT` vagas por recência na próxima poda (CA-5). No-op em
 * `sessionId` inexistente: nunca cria uma entrada fantasma.
 */
export function setPinned(registry: SessionRegistry, sessionId: string, pinned: boolean): SessionRegistry {
  const existing = registry[sessionId];
  if (!existing) return registry;
  if (existing.pinned === pinned) return registry;
  return { ...registry, [sessionId]: { ...existing, pinned } };
}

/** O "esquecer" do CA-11 (órfã: `.jsonl` sumiu, ou retomada falhou). No-op se a sessão não existir. */
export function removeSession(registry: SessionRegistry, sessionId: string): SessionRegistry {
  if (!(sessionId in registry)) return registry;
  const next = { ...registry };
  delete next[sessionId];
  return next;
}

/**
 * União das sessões do projeto (5 recentes + fixadas — já é o que o registro
 * guarda graças à poda na escrita), ordenada por `lastActivityAt` desc (CA-2).
 * Uma entrada por `sessionId`, então nunca há duplicata.
 */
export function selectProjectSessions(registry: SessionRegistry, projectPath: string): RegisteredSession[] {
  return Object.values(registry)
    .filter((entry) => entry.projectPath === projectPath)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** Insumo do dedupe do CA-3: o conjunto de `sessionId` que já aparecem em algum grupo favoritado. */
export function selectRegisteredIds(registry: SessionRegistry, projectPaths: readonly string[]): ReadonlySet<string> {
  const pathSet = new Set(projectPaths);
  const ids = new Set<string>();
  for (const entry of Object.values(registry)) {
    if (pathSet.has(entry.projectPath)) ids.add(entry.sessionId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// T707 (Fatia 3) — decisão pura de gravar uma visita. O gatilho 3
// (`onTranscriptChanged`) dispara a CADA turn; sem debounce o `config.json`
// (que também guarda favoritos, roots e perfil ativo) seria reescrito dezenas
// de vezes por minuto. Vive aqui (não no App.tsx) para ser testável sem React.
// ---------------------------------------------------------------------------

/** ~10 s (plan.md §Fatia 3) — folga suficiente pra não perder o "durante o trabalho" do D9 sem virar enxurrada de escrita. */
export const VISIT_DEBOUNCE_MS = 10_000;

export interface VisitLabelSnapshot {
  readonly label: string;
  readonly projectPath: string;
}

export interface ShouldRecordVisitInput {
  /** Epoch ms da última escrita desta sessão; `undefined` = nunca gravada ainda. */
  readonly lastWriteMs: number | undefined;
  readonly nowMs: number;
  /** Último snapshot conhecido (o que já foi gravado), ou `null` na primeira visita da sessão. */
  readonly previous: VisitLabelSnapshot | null;
  readonly next: VisitLabelSnapshot;
}

/**
 * `true` quando a visita deve ser gravada: primeira visita da sessão, rótulo
 * ou projeto mudou (grava na hora, CA-10 — nunca deixa o registro com nome
 * velho por causa do debounce), ou já passaram `VISIT_DEBOUNCE_MS` desde a
 * última gravação. Sessão diferente da última gravada é tratada pelo
 * chamador (que mantém `lastWriteMs` por `sessionId`) — aqui só decide para
 * UMA sessão de cada vez.
 */
export function shouldRecordVisit({ lastWriteMs, nowMs, previous, next }: ShouldRecordVisitInput): boolean {
  if (!previous) return true;
  if (previous.label !== next.label || previous.projectPath !== next.projectPath) return true;
  if (lastWriteMs === undefined) return true;
  return nowMs - lastWriteMs >= VISIT_DEBOUNCE_MS;
}
