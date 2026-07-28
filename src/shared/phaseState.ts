// T304 (003-modo-dev, Batch A) — derivação pura dos 5 estados de fase (CA-15).
// Requisito literal: identificar falha tem de ser "a coisa mais clara da
// tela" — os 5 estados abaixo são TODOS que existem; nenhum outro é inventado
// (`resultUnreadable` é marcador discreto sobre `stuck`, não um 6º estado).

export type PhaseStatus = 'not-started' | 'running' | 'done' | 'failed' | 'stuck';

export interface PhaseStatusInput {
  readonly ctxExists: boolean;
  /** Shape mínimo — aceita `EsteiraResultManifest` inteiro por estrutura, sem acoplar este módulo puro ao leitor de disco. */
  readonly result: { readonly status: string } | null;
  /**
   * C4 — só documental aqui: `result === null` já cobre "ausente OU ilegível"
   * (quem lê o disco, `esteira-reader.ts`, nunca devolve `result` não-null
   * junto de `resultUnreadable: true`). O marcador discreto na UI usa este
   * campo separadamente do estado retornado por esta função.
   */
  readonly resultUnreadable: boolean;
  readonly sessionAlive: boolean;
}

/**
 * Tabela do CA-15, na ordem de precedência: sessão viva vence tudo; sem
 * `ctx.md` é sempre "não iniciada"; daí em diante o `result` decide.
 */
export function derivePhaseStatus(input: PhaseStatusInput): PhaseStatus {
  if (input.sessionAlive) return 'running';
  if (!input.ctxExists) return 'not-started';
  if (input.result !== null) return input.result.status === 'success' ? 'done' : 'failed';
  return 'stuck'; // result ausente OU ilegível — resultUnreadable é só o marcador discreto (C4)
}
