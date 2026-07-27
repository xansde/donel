import { describe, expect, it } from 'vitest';
import {
  filterSessionsByQuery,
  formatFileSize,
  formatRelativeTime,
  sessionTabName,
} from '../src/shared/sessions';
import type { SessionSummaryDto } from '../src/shared/sessions';

// T013 — funções puras de apresentação do domínio de sessões anteriores
// (FR-004, ui-spec §5). SessionIndexer (T012) já tem sua própria suíte
// (tests/session-indexer.test.ts) — aqui só o que a UI faz com o resultado
// dele.

function makeSession(overrides: Partial<SessionSummaryDto> = {}): SessionSummaryDto {
  return {
    id: 'aaaaaaaa-1111-1111-1111-111111111111',
    filePath: 'C:\\fake\\aaaaaaaa-1111-1111-1111-111111111111.jsonl',
    mtimeMs: 0,
    size: 0,
    preview: 'Placeholder preview text',
    corrupted: false,
    lastActivityAt: null,
    customTitle: null,
    ...overrides,
  };
}

describe('sessionTabName', () => {
  it('returns the preview as-is when it already fits the tab name limit', () => {
    expect(sessionTabName(makeSession({ preview: 'Short preview' }))).toBe('Short preview');
  });

  it('truncates a long preview to 40 chars with an ellipsis', () => {
    const preview = 'A'.repeat(160);
    const result = sessionTabName(makeSession({ preview }));
    expect(result.length).toBe(40);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('A'.repeat(39))).toBe(true);
  });

  it('trims surrounding whitespace before measuring length', () => {
    expect(sessionTabName(makeSession({ preview: '  padded  ' }))).toBe('padded');
  });
});

describe('filterSessionsByQuery', () => {
  const sessions = [
    makeSession({ id: 'aaaaaaaa-0000', preview: 'Summarize the release notes' }),
    makeSession({ id: 'bbbbbbbb-0000', preview: 'Fix the login bug' }),
    makeSession({ id: 'cccccccc-0000', preview: '(ilegível)' }),
  ];

  it('returns a copy of the full list for an empty/whitespace-only query', () => {
    const result = filterSessionsByQuery(sessions, '   ');
    expect(result).toEqual(sessions);
    expect(result).not.toBe(sessions);
  });

  it('matches case-insensitively against the preview', () => {
    expect(filterSessionsByQuery(sessions, 'RELEASE').map((s) => s.id)).toEqual(['aaaaaaaa-0000']);
  });

  it('matches against the session id when the preview does not match', () => {
    expect(filterSessionsByQuery(sessions, 'bbbbbbbb').map((s) => s.id)).toEqual(['bbbbbbbb-0000']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterSessionsByQuery(sessions, 'nonexistent-token')).toEqual([]);
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-01-10T12:00:00.000Z');

  it('reports "agora" for anything under a minute ago', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('agora');
  });

  it('reports minutes under an hour', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('há 5 min');
  });

  it('reports hours under a day', () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('há 3h');
  });

  it('reports days under 30, with singular for 1 day', () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('há 2 dias');
    expect(formatRelativeTime(now - 1 * 86_400_000, now)).toBe('há 1 dia');
  });

  it('reports months under a year, with singular for 1 mês', () => {
    expect(formatRelativeTime(now - 45 * 86_400_000, now)).toBe('há 1 mês');
    expect(formatRelativeTime(now - 90 * 86_400_000, now)).toBe('há 3 meses');
  });

  it('reports years beyond 12 months', () => {
    expect(formatRelativeTime(now - 400 * 86_400_000, now)).toBe('há 1 ano');
  });

  it('treats a timestamp in the future as "agora" instead of a negative diff', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('agora');
  });
});

describe('formatFileSize', () => {
  it('shows raw bytes under 1024', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('shows KB with 1 decimal under 10 units', () => {
    expect(formatFileSize(2048)).toBe('2.0 KB');
  });

  it('shows KB with 0 decimals at/above 10 units', () => {
    expect(formatFileSize(15 * 1024)).toBe('15 KB');
  });

  it('rolls over to MB', () => {
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
