import { join } from 'node:path';
import type { ArchivedPhaseSession, ArchivedPhaseSessions, EsteiraPhase } from '../shared/devMode';
import { archivedPhaseSessionKey } from '../shared/devMode';
import { derivePhaseStatus, type PhaseStatus } from '../shared/phaseState';
import { readDiscoveryFanout, readPhaseArtifacts, type EsteiraReaderIoDeps, type PhaseArtifacts } from './esteira-reader';

// T305 (003-modo-dev, Batch A) — árvore do discovery (CA-7/CA-9/CA-10/CA-23):
// marcos × fases, tudo lido do disco (`esteira-reader.ts`) + do estado
// próprio arquivado (`archivedPhaseSessions`, CA-21). `sessionAlive` NUNCA
// entra aqui: só o processo main (registro de PTYs em memória) sabe quem está
// vivo — este módulo é 100% disco puro, testável sem Electron. A Zona 3
// (Batch B, T316/T319) sobrepõe "running" por cima usando o que já tem em
// memória, sem recalcular a árvore inteira a cada tick.

const ALL_PHASES: readonly EsteiraPhase[] = ['discovery', 'plano', 'implementar', 'validar', 'concluir'];

export interface PhaseNode {
  readonly phase: EsteiraPhase;
  readonly status: PhaseStatus; // CA-15, sempre com sessionAlive: false (ver comentário de topo)
  readonly artifacts: PhaseArtifacts;
  readonly archivedSession: ArchivedPhaseSession | null; // CA-9/CA-21
}

export interface MarcoNode {
  readonly marcoId: string; // "M1", "M2"... (outputs.fanout_cards)
  readonly cardId: string; // card de Plano deste marco
  readonly phases: Readonly<Record<EsteiraPhase, PhaseNode>>;
}

export interface DiscoveryTree {
  readonly discoveryCardId: string;
  readonly marcos: readonly MarcoNode[];
  /** Layout/UI (Batch B) decide qual marco destacar — este módulo não sabe seleção, só disco. */
  readonly focusedMarcoId: string | null;
  /** CA-23 — true quando TODO marco tem a fase concluir com status "success". Disco puro, sem board. */
  readonly allMarcosComplete: boolean;
}

function buildPhaseNode(
  repoPath: string,
  fase: EsteiraPhase,
  cardId: string,
  marcoId: string,
  archived: ArchivedPhaseSessions,
  io: EsteiraReaderIoDeps,
): PhaseNode {
  const artifacts = readPhaseArtifacts(repoPath, fase, cardId, io);
  const status = derivePhaseStatus({
    ctxExists: artifacts.ctxExists,
    result: artifacts.result,
    resultUnreadable: artifacts.resultUnreadable,
    sessionAlive: false, // ver comentário de topo do arquivo
  });
  const archivedSession = archived[archivedPhaseSessionKey({ cardId, marcoId, phase: fase })] ?? null;

  return { phase: fase, status, artifacts, archivedSession };
}

function buildMarcoNode(
  repoPath: string,
  marco: { cardId: string; marcoId: string },
  archived: ArchivedPhaseSessions,
  io: EsteiraReaderIoDeps,
): MarcoNode {
  const phases = {} as Record<EsteiraPhase, PhaseNode>;
  for (const phase of ALL_PHASES) {
    phases[phase] = buildPhaseNode(repoPath, phase, marco.cardId, marco.marcoId, archived, io);
  }
  return { marcoId: marco.marcoId, cardId: marco.cardId, phases };
}

/** CA-7/CA-9/CA-10/CA-23 — monta o discovery em foco por completo, a partir do disco. Nunca lança. */
export function buildDiscoveryTree(
  repoPath: string,
  discoveryCardId: string,
  archived: ArchivedPhaseSessions,
  io: EsteiraReaderIoDeps,
): DiscoveryTree {
  const fanout = readDiscoveryFanout(repoPath, discoveryCardId, io);
  const marcos = fanout.map((entry) => buildMarcoNode(repoPath, entry, archived, io));

  const allMarcosComplete = marcos.length > 0 && marcos.every((marco) => marco.phases.concluir.status === 'done');

  return { discoveryCardId, marcos, focusedMarcoId: null, allMarcosComplete };
}

// ---------------------------------------------------------------------------
// Pool de artefatos consultável (CA-10) — lista FIXA de candidatos, constante
// versionada no código (nunca varredura/descoberta em runtime). Cresce por
// PR, não por I/O.
// ---------------------------------------------------------------------------

export type ArtifactCandidateKind =
  | 'spec'
  | 'plan'
  | 'tasks'
  | 'research'
  | 'data-model'
  | 'contracts'
  | 'e2e'
  | 'lessons'
  | 'docs-processos';

export interface ArtifactCandidate {
  readonly kind: ArtifactCandidateKind;
  readonly path: string;
}

function fixedCandidates(repoPath: string, specSlug: string): readonly ArtifactCandidate[] {
  const specsDir = join(repoPath, 'specs', specSlug);
  return [
    { kind: 'spec', path: join(specsDir, 'spec.md') },
    { kind: 'plan', path: join(specsDir, 'plan.md') },
    { kind: 'tasks', path: join(specsDir, 'tasks.md') },
    { kind: 'research', path: join(specsDir, 'research.md') },
    { kind: 'data-model', path: join(specsDir, 'data-model.md') },
    { kind: 'contracts', path: join(specsDir, 'contracts') },
    { kind: 'e2e', path: join(specsDir, 'e2e.md') },
    { kind: 'lessons', path: join(repoPath, 'lessons.md') },
    { kind: 'docs-processos', path: join(repoPath, 'docs', 'processos') },
  ];
}

/** CA-10 — só confere EXISTÊNCIA de uma lista fixa de candidatos; não é varredura. */
export function resolveArtifactPool(repoPath: string, specSlug: string, io: EsteiraReaderIoDeps): readonly ArtifactCandidate[] {
  return fixedCandidates(repoPath, specSlug).filter((candidate) => io.existsSync(candidate.path));
}
