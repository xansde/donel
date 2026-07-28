import { describe, expect, it } from 'vitest';
import {
  archivePhaseSession,
  closeDiscovery,
  focusDiscovery,
  isArchivedSessionProfileMismatch,
  isValidArchivePhaseSessionIpcInput,
  isValidCardId,
  isValidCardIdList,
  isValidOpenDiscoveryIpcInput,
  linkDiscoveryRepo,
  openDiscovery,
  type DevModeState,
} from '../src/shared/devMode';

// T301 (003-modo-dev, Batch A) — núcleo puro do estado próprio do Modo Dev
// (CA-21/CA-22). Um fato, um dono: tudo aqui é o que o DISCO/board não sabe
// (discoveries abertos, foco, vínculo discovery↔repo, session-id arquivado).

function emptyState(): DevModeState {
  return {
    discoveries: {},
    focusedDiscoveryId: null,
    archivedPhaseSessions: {},
    phaseDefaults: {
      discovery: { model: 'fable', effort: 'high', commandTemplate: '/esteira-discovery {card_id}', opensOwnSession: true },
      plano: { model: 'opus', effort: 'high', commandTemplate: '/esteira-plano {card_id}', opensOwnSession: true },
      implementar: {
        model: 'opus',
        effort: 'high',
        commandTemplate: '/esteira-implementar {card_id} ultracode',
        opensOwnSession: true,
      },
      validar: { model: 'sonnet', effort: 'high', commandTemplate: '/esteira-validar {card_id}', opensOwnSession: true },
      concluir: { model: 'haiku', effort: 'low', commandTemplate: '/esteira-concluir {card_id}', opensOwnSession: false },
    },
    boardConfig: null,
  };
}

describe('openDiscovery', () => {
  it('adiciona uma entrada nova ao mapa de discoveries', () => {
    const state = emptyState();
    const next = openDiscovery(state, { cardId: 'card-1', repoPath: 'C:\\repo', epicId: null, openedAt: 100 });

    expect(next.discoveries['card-1']).toEqual({
      cardId: 'card-1',
      repoPath: 'C:\\repo',
      epicId: null,
      openedAt: 100,
      closedAt: null,
    });
  });

  it('não mexe no foco de outro discovery já em foco (CA-21: abrir não força foco)', () => {
    let state = emptyState();
    state = openDiscovery(state, { cardId: 'card-1', repoPath: 'C:\\repo1', epicId: null, openedAt: 100 });
    state = focusDiscovery(state, 'card-1');

    const next = openDiscovery(state, { cardId: 'card-2', repoPath: 'C:\\repo2', epicId: null, openedAt: 200 });

    expect(next.focusedDiscoveryId).toBe('card-1');
    expect(next.discoveries['card-2']).toBeDefined();
  });

  it('cardId ou repoPath vazio é no-op (porta de entrada desligada, não erro)', () => {
    const state = emptyState();
    const next = openDiscovery(state, { cardId: '', repoPath: 'C:\\repo', epicId: null, openedAt: 100 });
    expect(next).toEqual(state);

    const next2 = openDiscovery(state, { cardId: 'card-1', repoPath: '', epicId: null, openedAt: 100 });
    expect(next2).toEqual(state);
  });
});

describe('focusDiscovery', () => {
  it('muda só o foco — um único discovery em foco (CA-21)', () => {
    let state = emptyState();
    state = openDiscovery(state, { cardId: 'card-1', repoPath: 'C:\\repo1', epicId: null, openedAt: 100 });
    state = openDiscovery(state, { cardId: 'card-2', repoPath: 'C:\\repo2', epicId: null, openedAt: 200 });

    const next = focusDiscovery(state, 'card-2');

    expect(next.focusedDiscoveryId).toBe('card-2');
    expect(next.discoveries).toEqual(state.discoveries);
  });

  it('focar um cardId sem discovery aberto é no-op', () => {
    const state = emptyState();
    const next = focusDiscovery(state, 'card-inexistente');
    expect(next).toEqual(state);
  });
});

describe('closeDiscovery', () => {
  it('id inexistente é no-op', () => {
    const state = emptyState();
    const next = closeDiscovery(state, 'card-inexistente', 999);
    expect(next).toEqual(state);
  });

  it('marca closedAt e limpa o foco quando era o discovery focado (CA-23)', () => {
    let state = emptyState();
    state = openDiscovery(state, { cardId: 'card-1', repoPath: 'C:\\repo1', epicId: null, openedAt: 100 });
    state = focusDiscovery(state, 'card-1');

    const next = closeDiscovery(state, 'card-1', 500);

    expect(next.discoveries['card-1'].closedAt).toBe(500);
    expect(next.focusedDiscoveryId).toBeNull();
  });

  it('fechar um discovery que não estava em foco preserva o foco de outro', () => {
    let state = emptyState();
    state = openDiscovery(state, { cardId: 'card-1', repoPath: 'C:\\repo1', epicId: null, openedAt: 100 });
    state = openDiscovery(state, { cardId: 'card-2', repoPath: 'C:\\repo2', epicId: null, openedAt: 200 });
    state = focusDiscovery(state, 'card-1');

    const next = closeDiscovery(state, 'card-2', 500);

    expect(next.focusedDiscoveryId).toBe('card-1');
  });
});

describe('archivePhaseSession', () => {
  it('grava sessionId + profileSlug + archivedAt na chave composta cardId:marcoId:fase', () => {
    const state = emptyState();
    const next = archivePhaseSession(
      state,
      { cardId: 'card-1', marcoId: 'M1', phase: 'plano' },
      { sessionId: 'sess-1', profileSlug: 'principal', archivedAt: 1000 },
    );

    expect(next.archivedPhaseSessions['card-1:M1:plano']).toEqual({
      sessionId: 'sess-1',
      profileSlug: 'principal',
      archivedAt: 1000,
    });
  });
});

describe('isArchivedSessionProfileMismatch (CA-22)', () => {
  it('detecta divergência de perfil sem falhar', () => {
    const archived = { sessionId: 'sess-1', profileSlug: 'tecnologia-claude-2', archivedAt: 1000 };
    expect(isArchivedSessionProfileMismatch(archived, 'principal')).toBe(true);
    expect(isArchivedSessionProfileMismatch(archived, 'tecnologia-claude-2')).toBe(false);
  });
});

describe('linkDiscoveryRepo', () => {
  it('atualiza o repoPath de um discovery existente', () => {
    let state = emptyState();
    state = openDiscovery(state, { cardId: 'card-1', repoPath: 'C:\\antigo', epicId: null, openedAt: 100 });

    const next = linkDiscoveryRepo(state, 'card-1', 'C:\\novo');

    expect(next.discoveries['card-1'].repoPath).toBe('C:\\novo');
  });

  it('cardId inexistente ou repoPath vazio é no-op', () => {
    const state = emptyState();
    expect(linkDiscoveryRepo(state, 'card-inexistente', 'C:\\novo')).toEqual(state);

    let withOne = openDiscovery(state, { cardId: 'card-1', repoPath: 'C:\\antigo', epicId: null, openedAt: 100 });
    expect(linkDiscoveryRepo(withOne, 'card-1', '')).toEqual(withOne);
  });
});

// T307 — validação PURA de payload da IPC `devMode:*` (o main faz no-op em
// payload inválido, cardId/repoPath vazios; nenhuma tool de escrita entra).
describe('isValidOpenDiscoveryIpcInput', () => {
  it('aceita payload com cardId e repoPath preenchidos', () => {
    expect(isValidOpenDiscoveryIpcInput({ cardId: 'card-1', repoPath: 'C:\\repo', epicId: null })).toBe(true);
  });

  it('rejeita cardId ou repoPath vazio/ausente', () => {
    expect(isValidOpenDiscoveryIpcInput({ cardId: '', repoPath: 'C:\\repo', epicId: null })).toBe(false);
    expect(isValidOpenDiscoveryIpcInput({ cardId: 'card-1', repoPath: '', epicId: null })).toBe(false);
    expect(isValidOpenDiscoveryIpcInput({ cardId: 'card-1' })).toBe(false);
    expect(isValidOpenDiscoveryIpcInput(null)).toBe(false);
    expect(isValidOpenDiscoveryIpcInput('lixo')).toBe(false);
  });
});

describe('isValidArchivePhaseSessionIpcInput', () => {
  it('aceita payload completo com fase conhecida', () => {
    expect(
      isValidArchivePhaseSessionIpcInput({
        cardId: 'card-1',
        marcoId: 'M1',
        phase: 'plano',
        sessionId: 'sess-1',
        profileSlug: 'principal',
      }),
    ).toBe(true);
  });

  it('rejeita fase desconhecida ou qualquer campo vazio', () => {
    expect(
      isValidArchivePhaseSessionIpcInput({
        cardId: 'card-1',
        marcoId: 'M1',
        phase: 'fase-inventada',
        sessionId: 'sess-1',
        profileSlug: 'principal',
      }),
    ).toBe(false);
    expect(
      isValidArchivePhaseSessionIpcInput({ cardId: '', marcoId: 'M1', phase: 'plano', sessionId: 'sess-1', profileSlug: 'principal' }),
    ).toBe(false);
    expect(isValidArchivePhaseSessionIpcInput(null)).toBe(false);
  });
});

describe('isValidCardId', () => {
  it('aceita string não vazia, rejeita vazio/tipo errado', () => {
    expect(isValidCardId('card-1')).toBe(true);
    expect(isValidCardId('')).toBe(false);
    expect(isValidCardId('   ')).toBe(false);
    expect(isValidCardId(null)).toBe(false);
    expect(isValidCardId(42)).toBe(false);
  });
});

// T327 (Batch D) — payload do canal de LEITURA `devMode:readBoardFacts`: a
// lista de cards do discovery EM FOCO (CA-12). Continua valendo a invariante
// 5 — nenhum canal de ESCRITA para TaskDex/vault existe nesta API.
describe('isValidCardIdList', () => {
  it('aceita lista de strings não vazias', () => {
    expect(isValidCardIdList(['SZI-901', 'SZI-902'])).toBe(true);
    expect(isValidCardIdList([])).toBe(true);
  });

  it('rejeita não-array, elemento vazio ou de outro tipo (main faz no-op)', () => {
    expect(isValidCardIdList(null)).toBe(false);
    expect(isValidCardIdList('SZI-901')).toBe(false);
    expect(isValidCardIdList(['SZI-901', ''])).toBe(false);
    expect(isValidCardIdList(['SZI-901', 42])).toBe(false);
  });
});
