import { describe, expect, it } from 'vitest';
import { CLAUDE_NOT_FOUND_PREFIX, parseClaudeNotFound } from '../src/shared';

// T005 — parsing do lado do renderer pra reconhecer o erro CA-5 devolvido
// pelo `pty:create` (main/index.ts) sem depender de Electron/DOM.

describe('parseClaudeNotFound', () => {
  it('extracts the expected path from a CLAUDE_NOT_FOUND error', () => {
    const error = new Error(`${CLAUDE_NOT_FOUND_PREFIX}C:\\Users\\fake-user\\.local\\bin\\claude.exe`);

    expect(parseClaudeNotFound(error)).toBe('C:\\Users\\fake-user\\.local\\bin\\claude.exe');
  });

  it('still extracts the path when Electron wraps the message with extra text before the prefix', () => {
    // Electron às vezes prefixa o erro do handler (ex.: "Error invoking remote
    // method 'pty:create': Error: <mensagem>") — o parsing procura o marcador
    // em qualquer posição da string, não só no início.
    const error = new Error(
      `Error invoking remote method 'pty:create': Error: ${CLAUDE_NOT_FOUND_PREFIX}C:\\fallback\\claude.exe`,
    );

    expect(parseClaudeNotFound(error)).toBe('C:\\fallback\\claude.exe');
  });

  it('returns null for an unrelated error', () => {
    expect(parseClaudeNotFound(new Error('ENOENT: some other failure'))).toBeNull();
  });

  it('returns null for a non-Error thrown value', () => {
    expect(parseClaudeNotFound('plain string failure')).toBeNull();
  });
});
