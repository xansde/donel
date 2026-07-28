import { describe, expect, it } from 'vitest';
import type { DevModeDiscoveries } from '../src/shared/devMode';
import type { DiscoveryTree, MarcoNode, PhaseNode } from '../src/main/discovery-tree';
import type { PhaseStatus } from '../src/shared/phaseState';
import {
  discoveriesToClose,
  isCardLinked,
  resolveEntrySelection,
} from '../src/renderer/src/DevMode/devModeSelection';

// T311/T321 (003-modo-dev, Batch B) — decisões PURAS da Zona 1 (CA-2) e do
// encerramento automático (CA-23). Sem React, sem IPC: só o cruzamento entre
// os cards do board, os discoveries abertos (estado próprio, CA-21) e as
// árvores lidas do disco (CA-14 — o mapa card→marco vem do `fanout_cards`).

function phaseNode(status: PhaseStatus): PhaseNode {
  return {
    phase: 'concluir',
    status,
    artifacts: {
      ctxPath: '',
      resultPath: '',
      ctxExists: false,
      result: null,
      resultUnreadable: false,
      worktreePath: null,
      branch: null,
    },
    archivedSession: null,
  };
}

function marco(marcoId: string, cardId: string, concluirStatus: PhaseStatus): MarcoNode {
  const node = phaseNode(concluirStatus);
  return {
    marcoId,
    cardId,
    phases: {
      discovery: node,
      plano: node,
      implementar: node,
      validar: node,
      concluir: node,
    },
  };
}

function tree(discoveryCardId: string, marcos: MarcoNode[], allMarcosComplete: boolean): DiscoveryTree {
  return { discoveryCardId, marcos, focusedMarcoId: null, allMarcosComplete };
}

const DISCOVERIES: DevModeDiscoveries = {
  'SZI-100': { cardId: 'SZI-100', repoPath: 'C:/repo', epicId: null, openedAt: 1, closedAt: null },
};

const TREES: readonly DiscoveryTree[] = [
  tree('SZI-100', [marco('M1', 'SZI-101', 'done'), marco('M2', 'SZI-102', 'stuck')], false),
];

describe('resolveEntrySelection (CA-2)', () => {
  it('card que já tem discovery aberto traz aquele discovery ao foco, nunca cria outro', () => {
    expect(resolveEntrySelection({ cardId: 'SZI-100', discoveries: DISCOVERIES, trees: TREES })).toEqual({
      kind: 'focus',
      discoveryCardId: 'SZI-100',
    });
  });

  it('card de Plano resolve o discovery PAI (card de entrada), não um discovery novo', () => {
    expect(resolveEntrySelection({ cardId: 'SZI-102', discoveries: DISCOVERIES, trees: TREES })).toEqual({
      kind: 'focus',
      discoveryCardId: 'SZI-100',
    });
  });

  it('card sem vínculo nenhum vira criação de discovery novo', () => {
    expect(resolveEntrySelection({ cardId: 'SZI-777', discoveries: DISCOVERIES, trees: TREES })).toEqual({
      kind: 'create',
      cardId: 'SZI-777',
    });
  });

  it('discovery já encerrado (CA-23) não sequestra o card — o clique volta a ser criação', () => {
    const closed: DevModeDiscoveries = {
      'SZI-100': { cardId: 'SZI-100', repoPath: 'C:/repo', epicId: null, openedAt: 1, closedAt: 2 },
    };
    expect(resolveEntrySelection({ cardId: 'SZI-100', discoveries: closed, trees: [] })).toEqual({
      kind: 'create',
      cardId: 'SZI-100',
    });
  });
});

describe('isCardLinked (CA-2 — o card vinculado aparece marcado)', () => {
  it('marca o card de entrada de um discovery aberto', () => {
    expect(isCardLinked('SZI-100', DISCOVERIES, TREES)).toBe(true);
  });

  it('marca também o card de marco que pertence a um discovery aberto', () => {
    expect(isCardLinked('SZI-101', DISCOVERIES, TREES)).toBe(true);
  });

  it('não marca card sem vínculo', () => {
    expect(isCardLinked('SZI-777', DISCOVERIES, TREES)).toBe(false);
  });
});

describe('discoveriesToClose (CA-23)', () => {
  it('devolve o discovery cujos marcos TODOS concluíram', () => {
    const complete = [tree('SZI-100', [marco('M1', 'SZI-101', 'done')], true)];
    expect(discoveriesToClose(complete, DISCOVERIES)).toEqual(['SZI-100']);
  });

  it('um marco pendente mantém o discovery aberto', () => {
    expect(discoveriesToClose(TREES, DISCOVERIES)).toEqual([]);
  });

  it('discovery já encerrado não é reencerrado (nenhum IPC repetido)', () => {
    const closed: DevModeDiscoveries = {
      'SZI-100': { cardId: 'SZI-100', repoPath: 'C:/repo', epicId: null, openedAt: 1, closedAt: 2 },
    };
    const complete = [tree('SZI-100', [marco('M1', 'SZI-101', 'done')], true)];
    expect(discoveriesToClose(complete, closed)).toEqual([]);
  });

  it('árvore sem marco nenhum nunca encerra (allMarcosComplete falso por construção)', () => {
    expect(discoveriesToClose([tree('SZI-100', [], false)], DISCOVERIES)).toEqual([]);
  });
});
