import { describe, expect, it } from 'vitest';
import type { ArchivedPhaseSessions } from '../src/shared/devMode';
import { buildDiscoveryTree, resolveArtifactPool } from '../src/main/discovery-tree';
import type { EsteiraReaderIoDeps } from '../src/main/esteira-reader';

// T305 (003-modo-dev, Batch A) — montagem da árvore do discovery (CA-7/CA-9/
// CA-10/CA-23). Disco puro: `sessionAlive` é sempre `false` aqui — quem sabe
// qual sessão está viva é o processo main (PTYs em memória), não o disco; a
// Zona 3 (Batch B) sobrepõe "running" por cima com o que já sabe.

const REPO = 'C:\\repo';
const ROOT_CARD = 'card-root';

function discoveryResultPath(cardId: string): string {
  return `C:\\repo\\.esteira\\discovery\\handoffs\\${cardId}\\discovery-result.json`;
}

function phaseResultPath(fase: string, cardId: string): string {
  return `C:\\repo\\.esteira\\${fase}\\handoffs\\${cardId}\\${fase}-result.json`;
}

function phaseCtxPath(fase: string, cardId: string): string {
  return `C:\\repo\\.esteira\\${fase}\\${cardId}-ctx.md`;
}

function successManifest(cardId: string, fase: string): string {
  return JSON.stringify({
    card_id: cardId,
    fase,
    status: 'success',
    started_at: 'x',
    finished_at: 'x',
    executor: 'claude',
    model: 'opus',
    effort: 'high',
    outputs: {},
  });
}

function fakeIo(files: Record<string, string>): EsteiraReaderIoDeps {
  return {
    existsSync: (path) => path in files,
    readFileText: (path) => files[path] ?? null,
  };
}

function threeMarcoFanout(): Record<string, string> {
  return {
    [discoveryResultPath(ROOT_CARD)]: JSON.stringify({
      card_id: ROOT_CARD,
      fase: 'discovery',
      status: 'success',
      started_at: 'x',
      finished_at: 'x',
      executor: 'claude',
      model: 'fable',
      effort: 'high',
      outputs: {
        fanout_cards: [
          { card_id: 'card-m1', marco_id: 'M1' },
          { card_id: 'card-m2', marco_id: 'M2' },
          { card_id: 'card-m3', marco_id: 'M3' },
        ],
      },
    }),
  };
}

const NO_ARCHIVED: ArchivedPhaseSessions = {};

describe('buildDiscoveryTree', () => {
  it('árvore com 3 marcos monta 3 ramos × 5 fases cada', () => {
    const io = fakeIo(threeMarcoFanout());
    const tree = buildDiscoveryTree(REPO, ROOT_CARD, NO_ARCHIVED, io);

    expect(tree.discoveryCardId).toBe(ROOT_CARD);
    expect(tree.marcos).toHaveLength(3);
    for (const marco of tree.marcos) {
      expect(Object.keys(marco.phases).sort()).toEqual(['concluir', 'discovery', 'implementar', 'plano', 'validar'].sort());
    }
    expect(tree.marcos.map((m) => m.marcoId)).toEqual(['M1', 'M2', 'M3']);
    expect(tree.marcos.map((m) => m.cardId)).toEqual(['card-m1', 'card-m2', 'card-m3']);
  });

  it('sem fanout (discovery-result.json ausente/sem fanout_cards) → marcos vazio, allMarcosComplete false', () => {
    const io = fakeIo({});
    const tree = buildDiscoveryTree(REPO, ROOT_CARD, NO_ARCHIVED, io);

    expect(tree.marcos).toEqual([]);
    expect(tree.allMarcosComplete).toBe(false);
  });

  it("allMarcosComplete só é true quando TODA fase concluir de TODO marco tem status success (CA-23)", () => {
    const files = {
      ...threeMarcoFanout(),
      [phaseCtxPath('concluir', 'card-m1')]: '---\ncard_id: card-m1\n---\n',
      [phaseResultPath('concluir', 'card-m1')]: successManifest('card-m1', 'concluir'),
      [phaseCtxPath('concluir', 'card-m2')]: '---\ncard_id: card-m2\n---\n',
      [phaseResultPath('concluir', 'card-m2')]: successManifest('card-m2', 'concluir'),
      // card-m3 concluir: sem ctx.md — ainda não chegou lá.
    };
    const io = fakeIo(files);
    const tree = buildDiscoveryTree(REPO, ROOT_CARD, NO_ARCHIVED, io);

    expect(tree.allMarcosComplete).toBe(false);

    const filesAllDone = {
      ...files,
      [phaseCtxPath('concluir', 'card-m3')]: '---\ncard_id: card-m3\n---\n',
      [phaseResultPath('concluir', 'card-m3')]: successManifest('card-m3', 'concluir'),
    };
    const treeAllDone = buildDiscoveryTree(REPO, ROOT_CARD, NO_ARCHIVED, fakeIo(filesAllDone));
    expect(treeAllDone.allMarcosComplete).toBe(true);
  });

  it('liga archivedPhaseSessions ao nó certo (CA-9)', () => {
    const archived: ArchivedPhaseSessions = {
      'card-m1:M1:plano': { sessionId: 'sess-1', profileSlug: 'principal', archivedAt: 100 },
    };
    const io = fakeIo(threeMarcoFanout());
    const tree = buildDiscoveryTree(REPO, ROOT_CARD, archived, io);

    const m1 = tree.marcos.find((m) => m.marcoId === 'M1')!;
    expect(m1.phases.plano.archivedSession).toEqual({ sessionId: 'sess-1', profileSlug: 'principal', archivedAt: 100 });
    expect(m1.phases.discovery.archivedSession).toBeNull();
  });

  it('discovery antigo sem session-id arquivado (C4) monta igual — archivedSession null em toda fase', () => {
    const io = fakeIo(threeMarcoFanout());
    const tree = buildDiscoveryTree(REPO, ROOT_CARD, NO_ARCHIVED, io);

    for (const marco of tree.marcos) {
      for (const phase of Object.values(marco.phases)) {
        expect(phase.archivedSession).toBeNull();
      }
    }
  });
});

describe('resolveArtifactPool', () => {
  it('nunca lista um path fora da constante fixa', () => {
    const io: EsteiraReaderIoDeps = { existsSync: () => true, readFileText: () => null };
    const pool = resolveArtifactPool(REPO, '003-modo-dev', io);

    const allowedSuffixes = [
      'specs\\003-modo-dev\\spec.md',
      'specs\\003-modo-dev\\plan.md',
      'specs\\003-modo-dev\\tasks.md',
      'specs\\003-modo-dev\\research.md',
      'specs\\003-modo-dev\\data-model.md',
      'specs\\003-modo-dev\\contracts',
      'specs\\003-modo-dev\\e2e.md',
      'lessons.md',
      'docs\\processos',
    ];

    expect(pool.length).toBeGreaterThan(0);
    for (const candidate of pool) {
      expect(allowedSuffixes.some((suffix) => candidate.path.endsWith(suffix))).toBe(true);
    }
  });

  it('só lista os candidatos que EXISTEM (io.existsSync)', () => {
    const io: EsteiraReaderIoDeps = { existsSync: () => false, readFileText: () => null };
    const pool = resolveArtifactPool(REPO, '003-modo-dev', io);
    expect(pool).toEqual([]);
  });
});
