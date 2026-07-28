import { describe, expect, it } from 'vitest';
import type { DiscoveryTree, MarcoNode, PhaseNode } from '../src/main/discovery-tree';
import type { BoardFacts } from '../src/main/taskdex-board-client';
import type { EsteiraPhase } from '../src/shared/devMode';
import type { PhaseStatus } from '../src/shared/phaseState';
import { annotateTree, detectPhaseDivergence } from '../src/shared/boardAnnotation';

// T325/T326 (003-modo-dev, Batch C) — anotação dos 4 fatos do CA-12 na árvore
// do discovery + detecção de divergência disco×board (CA-13, parte de
// detecção — a sessão de conciliação é T328/Batch D). Pure mapping: sem I/O,
// sem persistência (CA-14 — marco_id continua vindo do disco, o `[Mx]` do
// board é só conferência).

const ALL_PHASES: readonly EsteiraPhase[] = ['discovery', 'plano', 'implementar', 'validar', 'concluir'];

function phaseNode(phase: EsteiraPhase, status: PhaseStatus): PhaseNode {
  return {
    phase,
    status,
    artifacts: { ctxPath: '', resultPath: '', ctxExists: false, result: null, resultUnreadable: false, worktreePath: null, branch: null },
    archivedSession: null,
  };
}

function marco(marcoId: string, cardId: string, statuses: Partial<Record<EsteiraPhase, PhaseStatus>> = {}): MarcoNode {
  const phases = {} as Record<EsteiraPhase, PhaseNode>;
  for (const phase of ALL_PHASES) phases[phase] = phaseNode(phase, statuses[phase] ?? 'not-started');
  return { marcoId, cardId, phases };
}

function tree(marcos: readonly MarcoNode[]): DiscoveryTree {
  return { discoveryCardId: 'disc-1', marcos, focusedMarcoId: null, allMarcosComplete: false };
}

function boardFacts(overrides: Partial<BoardFacts> = {}): BoardFacts {
  return {
    column: 'plano',
    title: 'Card qualquer',
    lockedPhase: null,
    attentionLabels: [],
    prUrl: null,
    prApproved: false,
    ...overrides,
  };
}

describe('annotateTree — overlay dos 4 fatos (T325/CA-12)', () => {
  it('sobrepõe os 4 fatos do board no marco correspondente (por cardId)', () => {
    const t = tree([marco('M1', 'card-1')]);
    const facts = boardFacts({ column: 'implementar', lockedPhase: 'implementar', attentionLabels: ['esteira:precisa-atencao'], prUrl: 'https://x/pr/1', prApproved: true });

    const annotated = annotateTree(t, { 'card-1': facts });

    expect(annotated.marcos[0].boardFacts).toEqual(facts);
  });

  it('marco sem fato correspondente no board → boardFacts null (nunca lança)', () => {
    const t = tree([marco('M1', 'card-1')]);
    const annotated = annotateTree(t, {});
    expect(annotated.marcos[0].boardFacts).toBeNull();
  });

  it('não altera o PhaseNode/MarcoNode original — imutabilidade', () => {
    const t = tree([marco('M1', 'card-1', { plano: 'done' })]);
    const snapshotBefore = JSON.parse(JSON.stringify(t));

    annotateTree(t, { 'card-1': boardFacts() });

    expect(JSON.parse(JSON.stringify(t))).toEqual(snapshotBefore);
  });

  it('"[Mx]" do título do card divergindo do marco_id de disco gera marcador de conferência, nunca substitui marco_id (CA-14)', () => {
    const t = tree([marco('M1', 'card-1')]);
    const annotated = annotateTree(t, { 'card-1': boardFacts({ title: '[M2] Card com prefixo errado' }) });

    expect(annotated.marcos[0].marcoIdMismatch).toBe(true);
    expect(annotated.marcos[0].marcoId).toBe('M1'); // nunca substituído — CA-14
  });

  it('"[Mx]" do título batendo com o marco_id de disco → sem marcador', () => {
    const t = tree([marco('M1', 'card-1')]);
    const annotated = annotateTree(t, { 'card-1': boardFacts({ title: '[M1] Card certo' }) });
    expect(annotated.marcos[0].marcoIdMismatch).toBe(false);
  });

  it('título sem prefixo "[Mx]" não gera marcador (card antigo, sem convenção ainda)', () => {
    const t = tree([marco('M1', 'card-1')]);
    const annotated = annotateTree(t, { 'card-1': boardFacts({ title: 'Card sem prefixo' }) });
    expect(annotated.marcos[0].marcoIdMismatch).toBe(false);
  });

  it('card fora do discovery em foco nunca entra na anotação — chaves extras do board são ignoradas (CA-12)', () => {
    const t = tree([marco('M1', 'card-1')]);
    const annotated = annotateTree(t, {
      'card-1': boardFacts(),
      'card-fora-do-foco': boardFacts({ column: 'concluir' }),
    });

    expect(annotated.marcos).toHaveLength(1);
    expect(annotated.marcos[0].cardId).toBe('card-1');
  });
});

describe('detectPhaseDivergence — detecção disco×board (T326/CA-13)', () => {
  it('fase done + card ainda na coluna anterior à esperada → marca divergência com os dois fatos', () => {
    const divergence = detectPhaseDivergence('implementar', 'done', 'implementar');
    expect(divergence).toEqual({ diskStatus: 'done', boardColumn: 'implementar' });
  });

  it('fase validar done + card ainda na coluna de antes de Validar → NÃO marca (caso esperado pela Esteira)', () => {
    expect(detectPhaseDivergence('validar', 'done', 'implementar')).toBeNull();
  });

  it('fase concluir done → sem coluna seguinte esperada, nunca marca', () => {
    expect(detectPhaseDivergence('concluir', 'done', 'implementar')).toBeNull();
  });

  it('fase não concluída no disco → nunca marca, seja qual for a coluna', () => {
    expect(detectPhaseDivergence('implementar', 'running', 'plano')).toBeNull();
    expect(detectPhaseDivergence('implementar', 'not-started', 'plano')).toBeNull();
    expect(detectPhaseDivergence('implementar', 'failed', 'plano')).toBeNull();
    expect(detectPhaseDivergence('implementar', 'stuck', 'plano')).toBeNull();
  });

  it('card já avançou além da coluna esperada (ou até ela) → sem divergência', () => {
    expect(detectPhaseDivergence('discovery', 'done', 'plano')).toBeNull();
    expect(detectPhaseDivergence('discovery', 'done', 'validar')).toBeNull();
  });

  it('coluna do board fora da esteira conhecida (ex.: "backlog") → sem base de comparação, não alarma à toa', () => {
    expect(detectPhaseDivergence('implementar', 'done', 'backlog')).toBeNull();
  });
});

describe('annotateTree — wiring da divergência por fase (T326)', () => {
  it('fase implementar done + coluna do board ainda em implementar → PhaseNode.divergence com os dois fatos', () => {
    const t = tree([marco('M1', 'card-1', { implementar: 'done' })]);
    const annotated = annotateTree(t, { 'card-1': boardFacts({ column: 'implementar' }) });

    expect(annotated.marcos[0].phases.implementar.divergence).toEqual({ diskStatus: 'done', boardColumn: 'implementar' });
  });

  it('fase validar done + coluna ainda em implementar → sem divergência (caso esperado, CA-13)', () => {
    const t = tree([marco('M1', 'card-1', { implementar: 'done', validar: 'done' })]);
    const annotated = annotateTree(t, { 'card-1': boardFacts({ column: 'implementar' }) });

    expect(annotated.marcos[0].phases.validar.divergence).toBeNull();
  });

  it('sem boardFacts (marco fora do board) → nenhuma fase marca divergência', () => {
    const t = tree([marco('M1', 'card-1', { implementar: 'done' })]);
    const annotated = annotateTree(t, {});

    for (const phase of ALL_PHASES) {
      expect(annotated.marcos[0].phases[phase].divergence).toBeNull();
    }
  });
});
