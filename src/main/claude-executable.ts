import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// T005 — Resolução do executável do `claude` (plan.md ponto 1, spec.md CA-5
// e FR-006). `resolveClaudeExecutable` é uma função pura — recebe as
// dependências injetadas (which/existsSync/homedir) — para ser 100% testável
// com vitest sem tocar filesystem/processo real. `createSystemResolveDeps()`
// monta as dependências de verdade usadas pelo main process.

export interface ResolveClaudeDeps {
  /** Primeiro caminho resolvido no PATH pra um comando, ou null se não achou. */
  which: (command: string) => string | null;
  existsSync: (path: string) => boolean;
  homedir: () => string;
}

export type ResolvedClaudeExecutable =
  | { readonly found: true; readonly path: string; readonly source: 'path' | 'fallback' }
  | { readonly found: false; readonly expectedPath: string };

/** Caminho de fallback documentado no CA-5 da spec: `~/.local/bin/claude.exe`. */
export function fallbackClaudePath(homedirFn: () => string): string {
  return join(homedirFn(), '.local', 'bin', 'claude.exe');
}

/**
 * PATH → fallback `~/.local/bin/claude.exe` (spec.md CA-5, plan.md ponto 1).
 * Nunca lança — o chamador decide o que fazer com `found: false`.
 */
export function resolveClaudeExecutable(deps: ResolveClaudeDeps): ResolvedClaudeExecutable {
  const expectedPath = fallbackClaudePath(deps.homedir);

  const fromPath = deps.which('claude');
  if (fromPath) {
    return { found: true, path: fromPath, source: 'path' };
  }

  if (deps.existsSync(expectedPath)) {
    return { found: true, path: expectedPath, source: 'fallback' };
  }

  return { found: false, expectedPath };
}

/**
 * `where.exe <command>` real. Isolado do resto do módulo pra não precisar de
 * `vi.mock`/spawn real nos testes — só é usado por `createSystemResolveDeps`.
 * `where.exe` sai com código != 0 quando não acha nada; `execFileSync` lança
 * nesse caso, o que tratamos como "não encontrado" (não como erro fatal).
 */
function whereExecutable(command: string): string | null {
  try {
    const output = execFileSync('where.exe', [command], { encoding: 'utf8' });
    const [firstMatch] = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return firstMatch ?? null;
  } catch {
    return null;
  }
}

/** Dependências reais (filesystem/PATH da máquina) — só o main process usa. */
export function createSystemResolveDeps(): ResolveClaudeDeps {
  return { which: whereExecutable, existsSync, homedir };
}
