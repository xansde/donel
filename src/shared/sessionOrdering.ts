import type { SessionState } from '@donel-dev/design-system';

// T007 — ordenação da lista de SESSÕES na sidebar (ui-spec §2/§3, título da
// task "sessões fixadas"). Módulo puro e testável: o estado do semáforo
// sempre vence (permissão > falha/quota > aguardando > trabalhando >
// encerrada); pin só desempata DENTRO do mesmo estado. T009 alimenta `state`
// com valores de verdade (session-semaphore-manager.ts) e acrescenta
// `stateEnteredAt` pro desempate específico do FR-010/CA-6: "entre 2+
// sessões com permissão pendente simultaneamente, a mais antiga aparece
// primeiro" — a mais antiga é quem tem o MENOR `stateEnteredAt` (entrou em
// `permission` há mais tempo). Pin continua sendo o desempate geral pros
// demais estados (ui-spec §2), aplicado só depois da idade dentro de
// `permission` especificamente.

const STATE_RANK: Record<SessionState, number> = {
  permission: 0,
  error: 1,
  waiting: 2,
  working: 3,
  done: 4,
};

export interface OrderableSession {
  readonly id: string;
  readonly state: SessionState;
  readonly pinned: boolean;
  /** Epoch ms de quando `state` passou a valer — usado só pro desempate de FR-010/CA-6 dentro de `permission`. Sessões ainda sem leitura do semáforo podem omitir (tratado como 0 = "mais antiga possível", nunca perde o desempate por omissão). */
  readonly stateEnteredAt?: number;
}

/**
 * T709 (007-favoritos-sessoes) — pior estado entre um conjunto de sessões
 * VIVAS (CA-6: o cabeçalho do projeto colapsado "grita" o pior estado de
 * dentro). Reusa a MESMA `STATE_RANK` do `sortSessions` acima — não escreve
 * uma segunda tabela de precedência. `undefined` = nenhuma sessão (sem aba
 * viva daquele projeto agora).
 */
export function worstState(states: readonly SessionState[]): SessionState | undefined {
  if (states.length === 0) return undefined;
  return [...states].sort((a, b) => STATE_RANK[a] - STATE_RANK[b])[0];
}

/** Ordena sessões pelo semáforo primeiro; dentro de `permission`, a mais antiga (FR-010/CA-6) vem primeiro; pin desempata dentro do mesmo estado (nos demais casos). */
export function sortSessions<T extends OrderableSession>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => {
    const rankDiff = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rankDiff !== 0) return rankDiff;

    if (a.state === 'permission') {
      const ageDiff = (a.stateEnteredAt ?? 0) - (b.stateEnteredAt ?? 0);
      if (ageDiff !== 0) return ageDiff; // menor stateEnteredAt = mais antiga = vem primeiro
    }

    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return 0;
  });
}
