import type { DiscoveryTree, MarcoNode, PhaseNode } from '../main/discovery-tree';
import type { BoardFacts } from '../main/taskdex-board-client';
import type { EsteiraPhase } from './devMode';
import type { PhaseStatus } from './phaseState';

// T325/T326 (003-modo-dev, Batch C) — o espelho anota a árvore (CA-12) e
// detecta divergência disco×board (CA-13, parte de detecção — a sessão de
// conciliação é T328/Batch D). 100% puro: nenhuma função aqui faz I/O nem
// persiste nada (CA-14 — `marco_id` continua vindo do disco/`fanout_cards`,
// o `[Mx]` do título do card no board é só conferência, nunca substitui).
//
// `DiscoveryTree`/`MarcoNode`/`PhaseNode` (`../main/discovery-tree.ts`) e
// `BoardFacts` (`../main/taskdex-board-client.ts`) são importados só como
// TIPO — mesmo padrão de `shared/index.ts`: `import type` erasa no build,
// este módulo shared nunca passa a depender de `node:fs`/rede em runtime.

const ALL_PHASES: readonly EsteiraPhase[] = ['discovery', 'plano', 'implementar', 'validar', 'concluir'];

/** Fase → próxima fase esperada quando a atual termina `done`. `validar` fica de fora de propósito: por invariante da Esteira ela nunca move o card de coluna (CA-13), então não há coluna esperada a checar. `concluir` também fica de fora — é o fim da esteira, fora do escopo desta detecção. */
const NEXT_PHASE: Readonly<Partial<Record<EsteiraPhase, EsteiraPhase>>> = {
  discovery: 'plano',
  plano: 'implementar',
  implementar: 'validar',
};

function phaseIndex(value: string): number {
  return ALL_PHASES.indexOf(value as EsteiraPhase);
}

/** Os dois fatos exibidos lado a lado quando disco e board discordam (CA-13). */
export interface PhaseDivergence {
  readonly diskStatus: PhaseStatus;
  readonly boardColumn: string;
}

/**
 * CA-13 (detecção) — fase concluída no disco, mas o board ainda não chegou
 * (ou passou) na coluna esperada. Divergência **esperada pelo processo**
 * (fase `validar`, que por invariante da Esteira nunca move o card de
 * coluna) nunca marca — é filtrada explicitamente aqui, não silenciada por
 * acidente em outro lugar.
 */
export function detectPhaseDivergence(phase: EsteiraPhase, diskStatus: PhaseStatus, boardColumn: string): PhaseDivergence | null {
  if (diskStatus !== 'done') return null;

  const expectedPhase = NEXT_PHASE[phase];
  if (!expectedPhase) return null;

  const actualIndex = phaseIndex(boardColumn);
  if (actualIndex < 0) return null; // coluna fora da esteira conhecida (ex.: "backlog") — sem base de comparação, não alarma à toa

  if (actualIndex >= phaseIndex(expectedPhase)) return null; // já chegou lá (ou foi além) — progresso normal, não divergência

  return { diskStatus, boardColumn };
}

/** `[Mx]` no início do título do card no board — só conferência (CA-14), nunca fonte do `marco_id`. */
function titleMarcoId(title: string): string | null {
  const match = /^\[(M\d+)\]/.exec(title.trim());
  return match ? match[1] : null;
}

export interface AnnotatedPhaseNode extends PhaseNode {
  /** CA-13 — `null` quando disco e board concordam (ou não há fato de board pra comparar). */
  readonly divergence: PhaseDivergence | null;
}

export interface AnnotatedMarcoNode extends Omit<MarcoNode, 'phases'> {
  readonly phases: Readonly<Record<EsteiraPhase, AnnotatedPhaseNode>>;
  /** Os 4 fatos do CA-12 para este marco; `null` = card fora do board (ou board indisponível) — nunca erro. */
  readonly boardFacts: BoardFacts | null;
  /** CA-14 — `[Mx]` do título do card diverge do `marco_id` de disco. Só um marcador de conferência: `marcoId` abaixo continua o valor de disco, nunca é substituído. */
  readonly marcoIdMismatch: boolean;
}

export interface AnnotatedDiscoveryTree extends Omit<DiscoveryTree, 'marcos'> {
  readonly marcos: readonly AnnotatedMarcoNode[];
}

function annotatePhase(phase: EsteiraPhase, node: PhaseNode, boardColumn: string | null): AnnotatedPhaseNode {
  const divergence = boardColumn === null ? null : detectPhaseDivergence(phase, node.status, boardColumn);
  return { ...node, divergence };
}

function annotateMarco(marco: MarcoNode, facts: BoardFacts | null): AnnotatedMarcoNode {
  const phases = {} as Record<EsteiraPhase, AnnotatedPhaseNode>;
  for (const phase of ALL_PHASES) {
    phases[phase] = annotatePhase(phase, marco.phases[phase], facts?.column ?? null);
  }

  const boardTitleMarcoId = facts ? titleMarcoId(facts.title) : null;
  const marcoIdMismatch = boardTitleMarcoId !== null && boardTitleMarcoId !== marco.marcoId;

  return { ...marco, phases, boardFacts: facts, marcoIdMismatch };
}

/**
 * CA-12 — sobrepõe a cada marco da árvore (já montada 100% de disco pelo
 * Batch A, `discovery-tree.ts`) os 4 fatos que o disco não sabe: coluna real,
 * trava ativa (via `lockedPhase` de `BoardFacts`), etiquetas de atenção e
 * PR+aprovação. `boardFacts` é indexado por `cardId` — **só os cards do
 * discovery em foco entram aqui**: qualquer chave extra no mapa que não
 * corresponda a um marco desta árvore é simplesmente ignorada (CA-12,
 * "nunca cards fora do discovery em foco"). Nunca muta `tree` (imutabilidade)
 * nem persiste nada (CA-14).
 */
export function annotateTree(tree: DiscoveryTree, boardFacts: Readonly<Record<string, BoardFacts>>): AnnotatedDiscoveryTree {
  return {
    ...tree,
    marcos: tree.marcos.map((marco) => annotateMarco(marco, boardFacts[marco.cardId] ?? null)),
  };
}
