import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeLaunchSpec,
  createSystemResolveDeps,
  fallbackClaudePath,
  resolveClaudeExecutable,
  type ResolveClaudeDeps,
} from '../src/main/claude-executable';

// T005 — resolução do executável do `claude` (spec.md CA-5, plan.md ponto 1).
// Casos (b)/(c) do dossiê de verificação: deps mockadas, sem tocar
// filesystem/processo real. O caso (a) (máquina real) fica no describe
// "integração" no fim do arquivo.
//
// FIX ambiente genérico (28/07): `which` passou a devolver TODOS os matches
// do PATH e o resultado ganhou `launch` — shim `.cmd`/`.ps1` (instalação via
// `npm i -g`) precisa do interpretador; spawná-lo cru no ConPTY era a causa
// do "não dava pra abrir sessão claude" na máquina do colega.

function fakeDeps(overrides: Partial<ResolveClaudeDeps>): ResolveClaudeDeps {
  return {
    which: () => [],
    existsSync: () => false,
    homedir: () => 'C:\\Users\\fake-user',
    ...overrides,
  };
}

describe('resolveClaudeExecutable', () => {
  it('resolves via PATH when `which` finds a match', () => {
    const deps = fakeDeps({ which: (cmd) => (cmd === 'claude' ? ['C:\\tools\\claude.exe'] : []) });

    const result = resolveClaudeExecutable(deps);

    expect(result).toEqual({
      found: true,
      path: 'C:\\tools\\claude.exe',
      source: 'path',
      launch: { command: 'C:\\tools\\claude.exe', argsPrefix: [] },
    });
  });

  it('prefere um `.exe` mesmo quando o shim `.cmd` vem primeiro no PATH (npm -g + instalador nativo)', () => {
    const deps = fakeDeps({
      which: () => ['C:\\Users\\fake-user\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\tools\\claude.exe'],
    });

    const result = resolveClaudeExecutable(deps);

    expect(result.found).toBe(true);
    if (!result.found) throw new Error('unreachable');
    expect(result.path).toBe('C:\\tools\\claude.exe');
    expect(result.launch).toEqual({ command: 'C:\\tools\\claude.exe', argsPrefix: [] });
  });

  it('só shim `.cmd` no PATH (npm -g puro) → launch embrulha em cmd.exe /c', () => {
    const shim = 'C:\\Users\\fake-user\\AppData\\Roaming\\npm\\claude.cmd';
    const deps = fakeDeps({ which: () => [shim] });

    const result = resolveClaudeExecutable(deps);

    expect(result.found).toBe(true);
    if (!result.found) throw new Error('unreachable');
    expect(result.path).toBe(shim);
    expect(result.launch).toEqual({ command: 'cmd.exe', argsPrefix: ['/c', shim] });
  });

  it('falls back to ~/.local/bin/claude.exe when PATH misses but the fallback file exists', () => {
    const expectedPath = fallbackClaudePath(() => 'C:\\Users\\fake-user');
    const deps = fakeDeps({
      which: () => [],
      existsSync: (path) => path === expectedPath,
    });

    const result = resolveClaudeExecutable(deps);

    expect(result).toEqual({
      found: true,
      path: expectedPath,
      source: 'fallback',
      launch: { command: expectedPath, argsPrefix: [] },
    });
  });

  it('reports not-found with the expected fallback path when neither PATH nor the fallback exist (CA-5)', () => {
    const deps = fakeDeps({ which: () => [], existsSync: () => false });

    const result = resolveClaudeExecutable(deps);

    expect(result.found).toBe(false);
    if (result.found) throw new Error('unreachable');
    expect(result.expectedPath).toBe(join('C:\\Users\\fake-user', '.local', 'bin', 'claude.exe'));
  });

  it('prefers the PATH match over the fallback when both exist', () => {
    const deps = fakeDeps({
      which: () => ['C:\\tools\\claude.exe'],
      existsSync: () => true,
    });

    const result = resolveClaudeExecutable(deps);

    expect(result.found).toBe(true);
    if (!result.found) throw new Error('unreachable');
    expect(result.path).toBe('C:\\tools\\claude.exe');
    expect(result.source).toBe('path');
  });
});

describe('buildClaudeLaunchSpec', () => {
  it('.exe roda direto, sem prefixo', () => {
    expect(buildClaudeLaunchSpec('C:\\tools\\claude.exe')).toEqual({ command: 'C:\\tools\\claude.exe', argsPrefix: [] });
  });

  it('.cmd/.bat embrulham em cmd.exe /c (case-insensitive)', () => {
    expect(buildClaudeLaunchSpec('C:\\npm\\claude.CMD')).toEqual({ command: 'cmd.exe', argsPrefix: ['/c', 'C:\\npm\\claude.CMD'] });
    expect(buildClaudeLaunchSpec('C:\\npm\\claude.bat')).toEqual({ command: 'cmd.exe', argsPrefix: ['/c', 'C:\\npm\\claude.bat'] });
  });

  it('.ps1 embrulha em powershell -File com bypass de execution policy', () => {
    expect(buildClaudeLaunchSpec('C:\\npm\\claude.ps1')).toEqual({
      command: 'powershell.exe',
      argsPrefix: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\npm\\claude.ps1'],
    });
  });

  it('caminho sem extensão conhecida roda direto (não inventa interpretador)', () => {
    expect(buildClaudeLaunchSpec('C:\\tools\\claude')).toEqual({ command: 'C:\\tools\\claude', argsPrefix: [] });
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
