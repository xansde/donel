import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSystemResolveDeps,
  fallbackClaudePath,
  resolveClaudeExecutable,
  type ResolveClaudeDeps,
} from '../src/main/claude-executable';

// T005 — resolução do executável do `claude` (spec.md CA-5, plan.md ponto 1).
// Casos (b)/(c) do dossiê de verificação: deps mockadas, sem tocar
// filesystem/processo real. O caso (a) (máquina real) fica no describe
// "integração" no fim do arquivo.

function fakeDeps(overrides: Partial<ResolveClaudeDeps>): ResolveClaudeDeps {
  return {
    which: () => null,
    existsSync: () => false,
    homedir: () => 'C:\\Users\\fake-user',
    ...overrides,
  };
}

describe('resolveClaudeExecutable', () => {
  it('resolves via PATH when `which` finds a match', () => {
    const deps = fakeDeps({ which: (cmd) => (cmd === 'claude' ? 'C:\\tools\\claude.exe' : null) });

    const result = resolveClaudeExecutable(deps);

    expect(result).toEqual({ found: true, path: 'C:\\tools\\claude.exe', source: 'path' });
  });

  it('falls back to ~/.local/bin/claude.exe when PATH misses but the fallback file exists', () => {
    const expectedPath = fallbackClaudePath(() => 'C:\\Users\\fake-user');
    const deps = fakeDeps({
      which: () => null,
      existsSync: (path) => path === expectedPath,
    });

    const result = resolveClaudeExecutable(deps);

    expect(result).toEqual({ found: true, path: expectedPath, source: 'fallback' });
  });

  it('reports not-found with the expected fallback path when neither PATH nor the fallback exist (CA-5)', () => {
    const deps = fakeDeps({ which: () => null, existsSync: () => false });

    const result = resolveClaudeExecutable(deps);

    expect(result.found).toBe(false);
    if (result.found) throw new Error('unreachable');
    expect(result.expectedPath).toBe(join('C:\\Users\\fake-user', '.local', 'bin', 'claude.exe'));
  });

  it('prefers the PATH match over the fallback when both exist', () => {
    const deps = fakeDeps({
      which: () => 'C:\\tools\\claude.exe',
      existsSync: () => true,
    });

    const result = resolveClaudeExecutable(deps);

    expect(result).toEqual({ found: true, path: 'C:\\tools\\claude.exe', source: 'path' });
  });
});

describe('resolveClaudeExecutable — integração com a máquina real', () => {
  it('finds the real claude install on PATH via where.exe (dev machine)', () => {
    const result = resolveClaudeExecutable(createSystemResolveDeps());

    expect(result.found).toBe(true);
    if (!result.found) throw new Error('unreachable');
    expect(result.path.toLowerCase()).toContain('claude');
  });

  it('fallbackClaudePath matches the real homedir', () => {
    expect(fallbackClaudePath(homedir)).toBe(join(homedir(), '.local', 'bin', 'claude.exe'));
  });
});
