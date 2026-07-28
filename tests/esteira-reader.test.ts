import { describe, expect, it } from 'vitest';
import { readDiscoveryFanout, readPhaseArtifacts, type EsteiraReaderIoDeps } from '../src/main/esteira-reader';

// T303 (003-modo-dev, Batch A) — leitura dos artefatos de fase no disco
// (`.esteira/<fase>/<card_id>-ctx.md` e
// `.esteira/<fase>/handoffs/<card_id>/<fase>-result.json`). Nunca lança —
// degrada para "não sei" (C4). I/O 100% injetável, sem tocar disco real.

function fakeIo(files: Record<string, string>): EsteiraReaderIoDeps {
  return {
    existsSync: (path) => path in files,
    readFileText: (path) => files[path] ?? null,
  };
}

const REPO = 'C:\\repo';
const CTX_PATH = 'C:\\repo\\.esteira\\plano\\card-1-ctx.md';
const RESULT_PATH = 'C:\\repo\\.esteira\\plano\\handoffs\\card-1\\plano-result.json';

describe('readPhaseArtifacts', () => {
  it('ctx.md presente + result.json ausente → ctxExists true, result null, resultUnreadable false', () => {
    const io = fakeIo({ [CTX_PATH]: '---\ncard_id: card-1\n---\n' });
    const artifacts = readPhaseArtifacts(REPO, 'plano', 'card-1', io);

    expect(artifacts.ctxExists).toBe(true);
    expect(artifacts.result).toBeNull();
    expect(artifacts.resultUnreadable).toBe(false);
  });

  it('ctx.md ausente → ctxExists false', () => {
    const io = fakeIo({});
    const artifacts = readPhaseArtifacts(REPO, 'plano', 'card-1', io);
    expect(artifacts.ctxExists).toBe(false);
  });

  it('result.json com JSON corrompido → resultUnreadable true, nunca lança', () => {
    const io = fakeIo({
      [CTX_PATH]: '---\ncard_id: card-1\n---\n',
      [RESULT_PATH]: '{ isso não é json valido',
    });
    const artifacts = readPhaseArtifacts(REPO, 'plano', 'card-1', io);

    expect(artifacts.result).toBeNull();
    expect(artifacts.resultUnreadable).toBe(true);
  });

  it('result.json bem formado devolve os campos outputs tal como estão, sem transformação', () => {
    const manifest = {
      card_id: 'card-1',
      fase: 'plano',
      status: 'success',
      started_at: '2026-07-27T10:00:00Z',
      finished_at: '2026-07-27T10:30:00Z',
      executor: 'claude',
      model: 'opus',
      effort: 'high',
      outputs: {
        summary: 'resumo',
        artifact_paths: ['specs/003-modo-dev/spec.md'],
        e2e_path: 'specs/003-modo-dev/e2e.md',
        documents: ['doc1.md'],
      },
    };
    const io = fakeIo({
      [CTX_PATH]: '---\ncard_id: card-1\n---\n',
      [RESULT_PATH]: JSON.stringify(manifest),
    });
    const artifacts = readPhaseArtifacts(REPO, 'plano', 'card-1', io);

    expect(artifacts.resultUnreadable).toBe(false);
    expect(artifacts.result).toEqual(manifest);
  });

  it('frontmatter do ctx.md com worktree_path/branch → devolve os dois valores (D3)', () => {
    const io = fakeIo({
      [CTX_PATH]: '---\ncard_id: card-1\nbranch: feature/card-1\nworktree_path: C:\\worktrees\\card-1\n---\n\nconteudo\n',
    });
    const artifacts = readPhaseArtifacts(REPO, 'plano', 'card-1', io);

    expect(artifacts.branch).toBe('feature/card-1');
    expect(artifacts.worktreePath).toBe('C:\\worktrees\\card-1');
  });

  it('frontmatter sem worktree_path/branch (ctx.md antigo) → null, nunca lança (D3)', () => {
    const io = fakeIo({ [CTX_PATH]: '---\ncard_id: card-1\n---\n' });
    const artifacts = readPhaseArtifacts(REPO, 'plano', 'card-1', io);

    expect(artifacts.branch).toBeNull();
    expect(artifacts.worktreePath).toBeNull();
  });

  it('worktree_path explicitamente null no frontmatter vira null, não a string "null"', () => {
    const io = fakeIo({ [CTX_PATH]: '---\ncard_id: card-1\nbranch: main\nworktree_path: null\n---\n' });
    const artifacts = readPhaseArtifacts(REPO, 'plano', 'card-1', io);

    expect(artifacts.worktreePath).toBeNull();
    expect(artifacts.branch).toBe('main');
  });

  it('ctx.md sem nenhum frontmatter (arquivo vazio/sem marcadores) → branch/worktreePath null, nunca lança', () => {
    const io = fakeIo({ [CTX_PATH]: 'sem frontmatter nenhum' });
    const artifacts = readPhaseArtifacts(REPO, 'plano', 'card-1', io);

    expect(artifacts.branch).toBeNull();
    expect(artifacts.worktreePath).toBeNull();
  });
});

describe('readDiscoveryFanout', () => {
  const DISCOVERY_RESULT_PATH = 'C:\\repo\\.esteira\\discovery\\handoffs\\card-root\\discovery-result.json';

  it('fanout_cards ausente (fase que não é discovery) → []', () => {
    const io = fakeIo({
      [DISCOVERY_RESULT_PATH]: JSON.stringify({
        card_id: 'card-root',
        fase: 'discovery',
        status: 'success',
        started_at: 'x',
        finished_at: 'x',
        executor: 'claude',
        model: 'fable',
        effort: 'high',
        outputs: {},
      }),
    });
    expect(readDiscoveryFanout(REPO, 'card-root', io)).toEqual([]);
  });

  it('devolve o mapa card_id → marco_id de outputs.fanout_cards', () => {
    const io = fakeIo({
      [DISCOVERY_RESULT_PATH]: JSON.stringify({
        card_id: 'card-root',
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
          ],
        },
      }),
    });

    expect(readDiscoveryFanout(REPO, 'card-root', io)).toEqual([
      { cardId: 'card-m1', marcoId: 'M1' },
      { cardId: 'card-m2', marcoId: 'M2' },
    ]);
  });

  it('discovery-result.json ausente → []', () => {
    const io = fakeIo({});
    expect(readDiscoveryFanout(REPO, 'card-root', io)).toEqual([]);
  });

  it('discovery-result.json ilegível → [], nunca lança', () => {
    const io = fakeIo({ [DISCOVERY_RESULT_PATH]: '{ corrompido' });
    expect(readDiscoveryFanout(REPO, 'card-root', io)).toEqual([]);
  });
});
