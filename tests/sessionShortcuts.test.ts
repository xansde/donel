import { describe, expect, it } from 'vitest';
import { nextAttentionSessionId, sessionIdAtPosition } from '../src/shared/sessionShortcuts';
import type { OrderableSession } from '../src/shared/sessionOrdering';

// T009 — FR-013 (atalhos de troca de sessão), lógica pura. `orderedSessions`
// nos testes já vem na ordem que sortSessions produziria (permission > error
// > waiting > working > done) — sessionShortcuts não reordena, só navega.

const ordered: OrderableSession[] = [
  { id: 'perm-1', state: 'permission', pinned: false },
  { id: 'perm-2', state: 'permission', pinned: false },
  { id: 'waiting-1', state: 'waiting', pinned: false },
  { id: 'working-1', state: 'working', pinned: false },
  { id: 'done-1', state: 'done', pinned: false },
];

describe('sessionIdAtPosition (Ctrl+1..9)', () => {
  it('foca a sessão na posição N (1-based) da lista ordenada', () => {
    expect(sessionIdAtPosition(ordered, 1)).toBe('perm-1');
    expect(sessionIdAtPosition(ordered, 3)).toBe('waiting-1');
    expect(sessionIdAtPosition(ordered, 5)).toBe('done-1');
  });

  it('undefined quando não há sessão nessa posição (menos de N abas abertas)', () => {
    expect(sessionIdAtPosition(ordered, 9)).toBeUndefined();
  });
});

describe('nextAttentionSessionId (Ctrl+Tab)', () => {
  it('pula pra primeira sessão do subconjunto {permission, waiting} quando a aba ativa não precisa de atenção', () => {
    expect(nextAttentionSessionId(ordered, 'working-1')).toBe('perm-1');
  });

  it('avança dentro do subconjunto quando a aba ativa já precisa de atenção', () => {
    expect(nextAttentionSessionId(ordered, 'perm-1')).toBe('perm-2');
  });

  it('dá wrap-around pro início do subconjunto ao passar da última que precisa de atenção', () => {
    expect(nextAttentionSessionId(ordered, 'waiting-1')).toBe('perm-1');
  });

  it('undefined quando nenhuma sessão precisa de atenção', () => {
    const noneNeedAttention: OrderableSession[] = [
      { id: 'working-1', state: 'working', pinned: false },
      { id: 'done-1', state: 'done', pinned: false },
    ];
    expect(nextAttentionSessionId(noneNeedAttention, 'working-1')).toBeUndefined();
  });

  it('permission tem prioridade sobre waiting na ordem de ciclo (FR-013)', () => {
    const mixed: OrderableSession[] = [
      { id: 'perm-only', state: 'permission', pinned: false },
      { id: 'waiting-only', state: 'waiting', pinned: false },
    ];
    // Sem aba ativa dentro do subconjunto — sempre pula pra prioridade máxima.
    expect(nextAttentionSessionId(mixed, undefined)).toBe('perm-only');
  });
});
