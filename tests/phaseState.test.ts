import { describe, expect, it } from 'vitest';
import { derivePhaseStatus, type PhaseStatusInput } from '../src/shared/phaseState';

// T304 (003-modo-dev, Batch A) — os 5 estados de fase do CA-15, todos
// inferíveis de disco + processo próprio, sem depender do board.
// "resultUnreadable" nunca vira um 6º estado — é marcador discreto (C4),
// dobra dentro de "stuck" pelas mesmas condições estruturais.

function baseInput(overrides: Partial<PhaseStatusInput> = {}): PhaseStatusInput {
  return {
    ctxExists: false,
    result: null,
    resultUnreadable: false,
    sessionAlive: false,
    ...overrides,
  };
}

describe('derivePhaseStatus', () => {
  it('sem ctx.md → not-started', () => {
    expect(derivePhaseStatus(baseInput({ ctxExists: false }))).toBe('not-started');
  });

  it('sessão viva → running, independente do resto', () => {
    expect(
      derivePhaseStatus(
        baseInput({ ctxExists: true, sessionAlive: true, result: { status: 'success' } }),
      ),
    ).toBe('running');
    expect(derivePhaseStatus(baseInput({ ctxExists: false, sessionAlive: true }))).toBe('running');
  });

  it("result.status === 'success' → done", () => {
    expect(derivePhaseStatus(baseInput({ ctxExists: true, result: { status: 'success' } }))).toBe('done');
  });

  it('result presente com status ≠ success → failed', () => {
    expect(derivePhaseStatus(baseInput({ ctxExists: true, result: { status: 'error' } }))).toBe('failed');
  });

  it('ctx.md presente + result ausente + sessão não viva → stuck', () => {
    expect(derivePhaseStatus(baseInput({ ctxExists: true, result: null, sessionAlive: false }))).toBe('stuck');
  });

  it('resultUnreadable: true nunca vira um 6º estado — dobra em stuck (marcador é discreto, à parte)', () => {
    const status = derivePhaseStatus(
      baseInput({ ctxExists: true, result: null, resultUnreadable: true, sessionAlive: false }),
    );
    expect(['not-started', 'running', 'done', 'failed', 'stuck']).toContain(status);
    expect(status).toBe('stuck');
  });
});
