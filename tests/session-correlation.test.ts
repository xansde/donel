import { describe, expect, it } from 'vitest';
import { resolveClaudeCorrelation } from '../src/main/session-correlation';

// T009 — correlação sessão<->aba (spike: `--session-id <uuid>` fixo no spawn,
// determinístico; `-r <id>` já resolve sozinho, sem precisar da flag extra).

describe('resolveClaudeCorrelation', () => {
  it('gera um uuid novo e anexa --session-id quando não há retomada no argv', () => {
    const result = resolveClaudeCorrelation(['--model', 'sonnet'], () => 'generated-uuid');

    expect(result.correlationId).toBe('generated-uuid');
    expect(result.extraArgs).toEqual(['--session-id', 'generated-uuid']);
  });

  it('reaproveita o session-id de uma retomada (-r <id>) em vez de gerar um novo', () => {
    const result = resolveClaudeCorrelation(['-r', 'existing-session-id'], () => 'should-not-be-used');

    expect(result.correlationId).toBe('existing-session-id');
    expect(result.extraArgs).toEqual([]);
  });

  it('reaproveita o session-id também num fork (-r <id> --fork-session)', () => {
    const result = resolveClaudeCorrelation(['-r', 'forked-from-id', '--fork-session'], () => 'should-not-be-used');

    expect(result.correlationId).toBe('forked-from-id');
    expect(result.extraArgs).toEqual([]);
  });

  it('argv vazio (abertura direta pela sidebar, sem Launcher) ainda gera correlação', () => {
    const result = resolveClaudeCorrelation([], () => 'fresh-id');

    expect(result.correlationId).toBe('fresh-id');
    expect(result.extraArgs).toEqual(['--session-id', 'fresh-id']);
  });
});
