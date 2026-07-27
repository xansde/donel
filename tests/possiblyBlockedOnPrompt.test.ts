// FIX (auditoria rodada 6, achado media "sem testes de unidade pra
// possiblyBlockedOnPrompt") — cobertura de unidade da decisão extraída de
// App.tsx (`shared/possiblyBlockedOnPrompt.ts`); antes só existia via smoke
// Playwright caro (empty-state.spec.ts), e nenhum smoke sequer asserta o
// texto do hint (session-details-hint) que essa decisão liga.
import { describe, expect, it, vi } from 'vitest';
import { computePossiblyBlockedOnPrompt } from '../src/shared/possiblyBlockedOnPrompt';

const THRESHOLD_MS = 20_000;
const TRUST_DIALOG_LINES = [
  ' Quick safety check: Is this a project you created or one you trust?',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  ' Enter to confirm · Esc to cancel ',
];

describe('computePossiblyBlockedOnPrompt', () => {
  it('aba ociosa (sem semáforo ainda) há mais de 20s SEM diálogo de confiança visível -> false (caso normal, nenhum turno ainda)', () => {
    const getRenderedLines = vi.fn(() => ['> ', 'Bem-vindo ao Claude Code']);
    const result = computePossiblyBlockedOnPrompt({
      alive: true,
      semaphorePending: true,
      aliveSince: 0,
      now: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      getRenderedLines,
    });
    expect(result).toBe(false);
    expect(getRenderedLines).toHaveBeenCalledTimes(1);
  });

  it('aba viva há mais de 20s, semáforo pendente E diálogo de confiança de fato visível -> true', () => {
    const result = computePossiblyBlockedOnPrompt({
      alive: true,
      semaphorePending: true,
      aliveSince: 0,
      now: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      getRenderedLines: () => TRUST_DIALOG_LINES,
    });
    expect(result).toBe(true);
  });

  it('aba morta (processo não vivo) -> false mesmo com diálogo "visível" no buffer antigo', () => {
    const getRenderedLines = vi.fn(() => TRUST_DIALOG_LINES);
    const result = computePossiblyBlockedOnPrompt({
      alive: false,
      semaphorePending: true,
      aliveSince: 0,
      now: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      getRenderedLines,
    });
    expect(result).toBe(false);
    // Short-circuit: nem chega a ler o buffer renderizado (checagem barata primeiro).
    expect(getRenderedLines).not.toHaveBeenCalled();
  });

  it('semáforo já chegou (não pendente) -> false, mesmo com diálogo visível (já resolveu, não está mais bloqueada)', () => {
    const result = computePossiblyBlockedOnPrompt({
      alive: true,
      semaphorePending: false,
      aliveSince: 0,
      now: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      getRenderedLines: () => TRUST_DIALOG_LINES,
    });
    expect(result).toBe(false);
  });

  it('ainda dentro do limiar (< 20s viva) -> false mesmo com diálogo visível (ainda pode estar só conectando)', () => {
    const result = computePossiblyBlockedOnPrompt({
      alive: true,
      semaphorePending: true,
      aliveSince: 0,
      now: THRESHOLD_MS - 1,
      thresholdMs: THRESHOLD_MS,
      getRenderedLines: () => TRUST_DIALOG_LINES,
    });
    expect(result).toBe(false);
  });

  it('aliveSince undefined (nunca registrado) -> false', () => {
    const result = computePossiblyBlockedOnPrompt({
      alive: true,
      semaphorePending: true,
      aliveSince: undefined,
      now: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      getRenderedLines: () => TRUST_DIALOG_LINES,
    });
    expect(result).toBe(false);
  });
});
