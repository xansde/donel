import type { OrderableSession } from './sessionOrdering';

// T009 — FR-013 (atalhos de troca de sessão), lógica pura: quem monta o
// atalho de teclado (App.tsx) já tem a lista ordenada por sortSessions
// (sessionOrdering.ts) — aqui só decide QUAL sessão focar dado um índice
// (Ctrl+1..9) ou um pedido de "próxima que precisa de atenção" (Ctrl+Tab).

/** `Ctrl+1`..`Ctrl+9` — foca a sessão na posição N (1-based) da lista já ordenada pelo semáforo. `undefined` se não houver sessão nessa posição. */
export function sessionIdAtPosition<T extends { readonly id: string }>(orderedSessions: readonly T[], position1Based: number): string | undefined {
  return orderedSessions[position1Based - 1]?.id;
}

/** Estados que "precisam de atenção" pro Ctrl+Tab (FR-013: "permissão > aguardando"). */
const ATTENTION_STATES: ReadonlySet<OrderableSession['state']> = new Set(['permission', 'waiting']);

/**
 * `Ctrl+Tab` — foca a próxima sessão em {permissão pendente, aguardando
 * resposta} (nessa ordem de prioridade, já garantida por `orderedSessions`
 * vir de `sortSessions`). Cicla dentro do subconjunto que precisa de
 * atenção: se a aba ativa já está nesse subconjunto, avança pra próxima
 * (com wrap-around); se não está (ex.: focada numa sessão 'working'), pula
 * pra primeira do subconjunto (topo do ranking). `undefined` = nenhuma
 * sessão precisa de atenção agora.
 */
export function nextAttentionSessionId<T extends OrderableSession>(orderedSessions: readonly T[], activeId: string | undefined): string | undefined {
  const attention = orderedSessions.filter((session) => ATTENTION_STATES.has(session.state));
  if (attention.length === 0) return undefined;

  const activeIndex = attention.findIndex((session) => session.id === activeId);
  if (activeIndex === -1) return attention[0].id;

  return attention[(activeIndex + 1) % attention.length].id;
}
