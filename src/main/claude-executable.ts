import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// T005 — Resolução do executável do `claude` (plan.md ponto 1, spec.md CA-5
// e FR-006). `resolveClaudeExecutable` é uma função pura — recebe as
// dependências injetadas (which/existsSync/homedir) — para ser 100% testável
// com vitest sem tocar filesystem/processo real. `createSystemResolveDeps()`
// monta as dependências de verdade usadas pelo main process.
//
// FIX ambiente genérico (28/07, teste do colega): o CLI instalado via
// `npm i -g` expõe `claude.cmd`/`claude.ps1` (shims de script), não um
// `.exe` — e o ConPTY não executa script direto (o spawn morria e a sessão
// nunca abria). A resolução agora devolve TODOS os matches do PATH, prefere
// um `.exe`, e quando só há shim entrega um `launch` que embrulha no
// interpretador certo (`cmd.exe /c` / `powershell -File`).

export interface ResolveClaudeDeps {
  /** TODOS os caminhos resolvidos no PATH pra um comando, na ordem do `where.exe`; [] se não achou. */
  which: (command: string) => readonly string[];
  existsSync: (path: string) => boolean;
  homedir: () => string;
}

/** Como spawnar o `claude` resolvido: `command` + prefixo de args ANTES dos args da sessão. */
export interface ClaudeLaunchSpec {
  readonly command: string;
  readonly argsPrefix: readonly string[];
}

export type ResolvedClaudeExecutable =
  | { readonly found: true; readonly path: string; readonly source: 'path' | 'fallback'; readonly launch: ClaudeLaunchSpec }
  | { readonly found: false; readonly expectedPath: string };

/** Caminho de fallback documentado no CA-5 da spec: `~/.local/bin/claude.exe`. */
export function fallbackClaudePath(homedirFn: () => string): string {
  return join(homedirFn(), '.local', 'bin', 'claude.exe');
}

/**
 * Traduz o caminho resolvido no jeito certo de spawná-lo num PTY. Executável
 * de verdade roda direto; shim de script precisa do interpretador — ConPTY
 * (e o `child_process.spawn` sem `shell` do bootstrap de perfil) não executam
 * `.cmd`/`.bat`/`.ps1` sozinhos.
 */
export function buildClaudeLaunchSpec(resolvedPath: string): ClaudeLaunchSpec {
  const lower = resolvedPath.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return { command: 'cmd.exe', argsPrefix: ['/c', resolvedPath] };
  }
  if (lower.endsWith('.ps1')) {
    return { command: 'powershell.exe', argsPrefix: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedPath] };
  }
  return { command: resolvedPath, argsPrefix: [] };
}

/** Entre os matches do PATH, um `.exe` real vence qualquer shim de script — mesmo aparecendo depois. */
function pickBestMatch(matches: readonly string[]): string | null {
  if (matches.length === 0) return null;
  const exe = matches.find((match) => match.toLowerCase().endsWith('.exe'));
  return exe ?? matches[0];
}

/**
 * PATH → fallback `~/.local/bin/claude.exe` (spec.md CA-5, plan.md ponto 1).
 * Nunca lança — o chamador decide o que fazer com `found: false`.
 */
export function resolveClaudeExecutable(deps: ResolveClaudeDeps): ResolvedClaudeExecutable {
  const expectedPath = fallbackClaudePath(deps.homedir);

  const fromPath = pickBestMatch(deps.which('claude'));
  if (fromPath) {
    return { found: true, path: fromPath, source: 'path', launch: buildClaudeLaunchSpec(fromPath) };
  }

  if (deps.existsSync(expectedPath)) {
    return { found: true, path: expectedPath, source: 'fallback', launch: buildClaudeLaunchSpec(expectedPath) };
  }

  return { found: false, expectedPath };
}

/**
 * `where.exe <command>` real. Isolado do resto do módulo pra não precisar de
 * `vi.mock`/spawn real nos testes — só é usado por `createSystemResolveDeps`.
 * `where.exe` sai com código != 0 quando não acha nada; `execFileSync` lança
 * nesse caso, o que tratamos como "não encontrado" (não como erro fatal).
 */
function whereExecutable(command: string): readonly string[] {
  try {
    const output = execFileSync('where.exe', [command], { encoding: 'utf8' });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Dependências reais (filesystem/PATH da máquina) — só o main process usa. */
export function createSystemResolveDeps(): ResolveClaudeDeps {
  return { which: whereExecutable, existsSync, homedir };
}
