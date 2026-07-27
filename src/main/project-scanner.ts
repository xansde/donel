import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ProjectInfo } from '../shared';
import { sortProjects } from '../shared/projects';

// `sortProjects` mora em `src/shared/projects.ts` (pura, sem node:fs) desde
// a correção do feedback E2E rodada 3 ("favoritar só reflete após reiniciar
// o app") — o renderer (App.tsx) reusa a MESMA função pra reordenar a
// sidebar otimisticamente no clique da estrela, sem esperar o round-trip do
// IPC. Reexportada aqui pra `main/index.ts` e os testes existentes
// continuarem importando de `./project-scanner` sem mudança.
export { sortProjects };

// T007 — ProjectScanner (FR-001, plan.md "Arquitetura de processos").
// `scanProjects` é uma função pura — recebe as dependências injetadas
// (readDirNames/existsSync) — pra ser 100% testável com vitest sem tocar
// filesystem real. `createSystemScanDeps()` monta as dependências de verdade
// usadas pelo main process. Mesmo padrão de src/main/claude-executable.ts.

export interface ScanDeps {
  /** Nomes dos diretórios diretamente sob `dirPath` (não arquivos); [] se ilegível. */
  readDirNames: (dirPath: string) => string[];
  /** true se `path` existe (usado pra checar o marcador `.git`/`CLAUDE.md`). */
  existsSync: (path: string) => boolean;
}

const IGNORED_DIR_NAMES = new Set(['node_modules']);

function isCandidateDirName(name: string): boolean {
  return !name.startsWith('.') && !IGNORED_DIR_NAMES.has(name);
}

function hasProjectMarker(dirPath: string, deps: ScanDeps): boolean {
  return deps.existsSync(join(dirPath, '.git')) || deps.existsSync(join(dirPath, 'CLAUDE.md'));
}

/**
 * Varre `roots` até 2 níveis de profundidade (FR-001), listando diretórios
 * que contenham `.git/` ou `CLAUDE.md`. Um diretório de nível 1 com marcador
 * é um projeto (não desce mais); sem marcador, os filhos de nível 2 são
 * checados. `favorite`/`missing` NÃO são preenchidos aqui — `mergeFavorites`
 * cuida disso a partir do config (T015 formaliza o ConfigStore).
 */
export function scanProjects(roots: readonly string[], deps: ScanDeps): Omit<ProjectInfo, 'favorite' | 'missing'>[] {
  const projects: Omit<ProjectInfo, 'favorite' | 'missing'>[] = [];
  const seenPaths = new Set<string>();

  const addProject = (path: string, name: string, root: string): void => {
    if (seenPaths.has(path)) return;
    seenPaths.add(path);
    projects.push({ path, name, root });
  };

  for (const root of roots) {
    if (!deps.existsSync(root)) continue;

    for (const level1Name of deps.readDirNames(root).filter(isCandidateDirName)) {
      const level1Path = join(root, level1Name);
      if (hasProjectMarker(level1Path, deps)) {
        addProject(level1Path, level1Name, root);
        continue;
      }

      for (const level2Name of deps.readDirNames(level1Path).filter(isCandidateDirName)) {
        const level2Path = join(level1Path, level2Name);
        if (hasProjectMarker(level2Path, deps)) {
          addProject(level2Path, level2Name, root);
        }
      }
    }
  }

  return projects;
}

/**
 * Mescla o resultado do scan com os favoritos persistidos (FR-001: "favoritos
 * são persistidos no config"). Favoritos que não apareceram no scan atual
 * entram como `missing: true` (removidos do disco ou movidos pra fora dos
 * roots) — ui-spec §2: "favorito removido do disco aparece esmaecido com
 * ação remover".
 */
export function mergeFavorites(
  scanned: readonly Omit<ProjectInfo, 'favorite' | 'missing'>[],
  favoritePaths: readonly string[],
): ProjectInfo[] {
  const favoriteSet = new Set(favoritePaths);
  const scannedPaths = new Set(scanned.map((project) => project.path));

  const merged: ProjectInfo[] = scanned.map((project) => ({
    ...project,
    favorite: favoriteSet.has(project.path),
  }));

  for (const favoritePath of favoritePaths) {
    if (scannedPaths.has(favoritePath)) continue;
    merged.push({
      path: favoritePath,
      name: basename(favoritePath),
      root: dirname(favoritePath),
      favorite: true,
      missing: true,
    });
  }

  return merged;
}

/** Roots default do FR-001: `~/seazone` e `~/pessoal`. */
export function defaultProjectRoots(homedirFn: () => string): string[] {
  return [join(homedirFn(), 'seazone'), join(homedirFn(), 'pessoal')];
}

/** Dependências reais (filesystem da máquina) — só o main process usa. */
export function createSystemScanDeps(): ScanDeps {
  return {
    readDirNames: (dirPath) => {
      try {
        return readdirSync(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    existsSync,
  };
}
