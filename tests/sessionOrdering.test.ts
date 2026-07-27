import { describe, expect, it } from 'vitest';
import { sortSessions, worstState, type OrderableSession } from '../src/shared/sessionOrdering';

// T007 — ordenação da lista de SESSÕES (ui-spec §2/§3, título da task
// "sessões fixadas"): o estado do semáforo sempre vence; pin só desempata
// dentro do mesmo estado. `state` é placeholder até o T009 alimentar valores
// reais — a regra de ordenação em si já é a definitiva.

describe('sortSessions', () => {
  it('estado do semáforo vence: permissão > falha/quota > aguardando > trabalhando > encerrada', () => {
    const sessions: OrderableSession[] = [
      { id: 'done', state: 'done', pinned: false },
      { id: 'working', state: 'working', pinned: false },
      { id: 'waiting', state: 'waiting', pinned: false },
      { id: 'error', state: 'error', pinned: false },
      { id: 'permission', state: 'permission', pinned: false },
    ];

    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['permission', 'error', 'waiting', 'working', 'done']);
  });

  it('pin não sobe uma sessão acima de um estado mais urgente', () => {
    const sessions: OrderableSession[] = [
      { id: 'working-pinned', state: 'working', pinned: true },
      { id: 'waiting-unpinned', state: 'waiting', pinned: false },
    ];

    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['waiting-unpinned', 'working-pinned']);
  });

  it('dentro do mesmo estado, a sessão fixada fica acima', () => {
    const sessions: OrderableSession[] = [
      { id: 'a-unpinned', state: 'working', pinned: false },
      { id: 'b-pinned', state: 'working', pinned: true },
      { id: 'c-unpinned', state: 'working', pinned: false },
    ];

    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['b-pinned', 'a-unpinned', 'c-unpinned']);
  });

  it('FR-010/CA-6: entre 2+ sessões com permissão pendente, a mais antiga (menor stateEnteredAt) aparece primeiro', () => {
    const sessions: OrderableSession[] = [
      { id: 'permission-recent', state: 'permission', pinned: false, stateEnteredAt: 6_000 }, // há 1min (agora=7000)
      { id: 'permission-old', state: 'permission', pinned: false, stateEnteredAt: 1_000 }, // há 6min
    ];

    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['permission-old', 'permission-recent']);
  });

  it('desempate por idade em permission vale mesmo com pin — idade decide antes do pin', () => {
    const sessions: OrderableSession[] = [
      { id: 'permission-recent-pinned', state: 'permission', pinned: true, stateEnteredAt: 6_000 },
      { id: 'permission-old-unpinned', state: 'permission', pinned: false, stateEnteredAt: 1_000 },
    ];

    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['permission-old-unpinned', 'permission-recent-pinned']);
  });

  it('sessão sem stateEnteredAt em permission é tratada como a mais antiga (0), nunca perde o desempate por omissão', () => {
    const sessions: OrderableSession[] = [
      { id: 'permission-with-timestamp', state: 'permission', pinned: false, stateEnteredAt: 500 },
      { id: 'permission-without-timestamp', state: 'permission', pinned: false },
    ];

    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['permission-without-timestamp', 'permission-with-timestamp']);
  });

  it('idade não interfere fora do estado permission — pin continua desempatando normalmente', () => {
    const sessions: OrderableSession[] = [
      { id: 'waiting-recent-unpinned', state: 'waiting', pinned: false, stateEnteredAt: 6_000 },
      { id: 'waiting-old-pinned', state: 'waiting', pinned: true, stateEnteredAt: 1_000 },
    ];

    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['waiting-old-pinned', 'waiting-recent-unpinned']);
  });

  it('não muta o array recebido', () => {
    const sessions: OrderableSession[] = [
      { id: 'a', state: 'done', pinned: false },
      { id: 'b', state: 'permission', pinned: false },
    ];
    const originalOrder = sessions.map((s) => s.id);

    sortSessions(sessions);

    expect(sessions.map((s) => s.id)).toEqual(originalOrder);
  });
});

// T709 (007-favoritos-sessoes) — CA-6: o cabeçalho do projeto colapsado
// "grita" o pior estado das abas vivas. Mesma precedência do sortSessions
// acima (permission > error > waiting > working > done) — sem 2ª tabela.
describe('worstState', () => {
  it('vazio (nenhuma aba viva) devolve undefined', () => {
    expect(worstState([])).toBeUndefined();
  });

  it('uma sessão só devolve o próprio estado', () => {
    expect(worstState(['working'])).toBe('working');
  });

  it('permission vence qualquer combinação', () => {
    expect(worstState(['done', 'working', 'waiting', 'error', 'permission'])).toBe('permission');
  });

  it('sem permission, error vence', () => {
    expect(worstState(['done', 'working', 'waiting', 'error'])).toBe('error');
  });

  it('sem permission/error, waiting vence', () => {
    expect(worstState(['done', 'working', 'waiting'])).toBe('waiting');
  });

  it('só working/done: working vence', () => {
    expect(worstState(['done', 'working'])).toBe('working');
  });

  it('não muta o array recebido', () => {
    const states: ('done' | 'working')[] = ['done', 'working'];
    worstState(states);
    expect(states).toEqual(['done', 'working']);
  });
});
