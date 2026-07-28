import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectRoots, mergeFavorites, scanProjects, type ScanDeps } from '../src/main/project-scanner';

// T007 — ProjectScanner (FR-001). Mesmo padrão de DI de
// tests/claude-executable.test.ts: deps mockadas em memória, sem tocar
// filesystem real. `fakeDeps` modela uma árvore de diretórios como um
// `Record<caminho, filhos[]>` + um conjunto de "caminhos que existem"
// (roots e arquivos-marcador `.git`/`CLAUDE.md`).

function fakeDeps(dirs: Record<string, string[]>, markerPaths: Iterable<string> = []): ScanDeps {
  const markers = new Set(markerPaths);
  return {
    readDirNames: (dirPath) => dirs[dirPath] ?? [],
    existsSync: (path) => path in dirs || markers.has(path),
  };
}

// FIX ambiente genérico (28/07, teste do colega) — modo 'all': toda pasta de
// 1º nível vira projeto, sem exigir `.git`/`CLAUDE.md` (na máquina dele as
// pastas comuns "sumiam" sem explicação). Default segue 'markers'.
describe("scanProjects — modo 'all'", () => {
  it('lista toda pasta de 1º nível, com ou sem marcador', () => {
    const root = 'C:\\roots\\generico';
    const deps = fakeDeps({ [root]: ['com-git', 'pasta-comum'] }, [join(root, 'com-git', '.git')]);

    expect(scanProjects([root], deps, 'all')).toEqual([
      { path: join(root, 'com-git'), name: 'com-git', root },
      { path: join(root, 'pasta-comum'), name: 'pasta-comum', root },
    ]);
  });

  it('não desce ao 2º nível (a pasta de 1º nível já representa o grupo)', () => {
    const root = 'C:\\roots\\generico';
    const group = join(root, 'grupo');
    const nested = join(group, 'proj-aninhado');
    const deps = fakeDeps({ [root]: ['grupo'], [group]: ['proj-aninhado'] }, [join(nested, '.git')]);

    expect(scanProjects([root], deps, 'all')).toEqual([{ path: group, name: 'grupo', root }]);
  });

  it('continua ignorando dotfolders e node_modules', () => {
    const root = 'C:\\roots\\generico';
    const deps = fakeDeps({ [root]: ['.oculta', 'node_modules', 'visivel'] });

    expect(scanProjects([root], deps, 'all')).toEqual([{ path: join(root, 'visivel'), name: 'visivel', root }]);
  });

  it("sem o argumento, o default continua 'markers' (comportamento de sempre)", () => {
    const root = 'C:\\roots\\generico';
    const deps = fakeDeps({ [root]: ['pasta-comum'] });

    expect(scanProjects([root], deps)).toEqual([]);
  });
});

describe('scanProjects', () => {
  it('marca como projeto um diretório de nível 1 com .git', () => {
    const root = 'C:\\roots\\seazone';
    const deps = fakeDeps({ [root]: ['proj-a', 'proj-b'] }, [join(root, 'proj-a', '.git')]);

    expect(scanProjects([root], deps)).toEqual([{ path: join(root, 'proj-a'), name: 'proj-a', root }]);
  });

  it('marca como projeto um diretório de nível 1 com CLAUDE.md', () => {
    const root = 'C:\\roots\\seazone';
    const deps = fakeDeps({ [root]: ['proj-a'] }, [join(root, 'proj-a', 'CLAUDE.md')]);

    expect(scanProjects([root], deps)).toEqual([{ path: join(root, 'proj-a'), name: 'proj-a', root }]);
  });

  it('sem marcador no nível 1, desce pro nível 2 (FR-001 "até 2 níveis")', () => {
    const root = 'C:\\roots\\seazone';
    const group = join(root, 'grupo-sem-marcador');
    const nested = join(group, 'proj-aninhado');
    const deps = fakeDeps({ [root]: ['grupo-sem-marcador'], [group]: ['proj-aninhado'] }, [join(nested, '.git')]);

    expect(scanProjects([root], deps)).toEqual([{ path: nested, name: 'proj-aninhado', root }]);
  });

  it('não desce nos filhos de um nível 1 que já é projeto (evita nested .git de node_modules etc.)', () => {
    const root = 'C:\\roots\\seazone';
    const projectDir = join(root, 'proj-a');
    let readDirCalledForProject = false;
    const deps: ScanDeps = {
      readDirNames: (dirPath) => {
        if (dirPath === projectDir) readDirCalledForProject = true;
        if (dirPath === root) return ['proj-a'];
        return [];
      },
      existsSync: (path) => path === root || path === join(projectDir, '.git'),
    };

    const result = scanProjects([root], deps);

    expect(result).toEqual([{ path: projectDir, name: 'proj-a', root }]);
    expect(readDirCalledForProject).toBe(false);
  });

  it('ignora diretórios ocultos e node_modules em ambos os níveis', () => {
    const root = 'C:\\roots\\seazone';
    const group = join(root, 'grupo');
    const deps = fakeDeps({ [root]: ['.hidden', 'node_modules', 'grupo'], [group]: ['.git-lookalike'] }, []);

    expect(scanProjects([root], deps)).toEqual([]);
  });

  it('pula roots que não existem', () => {
    const deps = fakeDeps({}, []);

    expect(scanProjects(['C:\\nao-existe'], deps)).toEqual([]);
  });

  it('escaneia múltiplos roots preservando o root de origem de cada projeto', () => {
    const rootA = 'C:\\roots\\seazone';
    const rootB = 'C:\\roots\\pessoal';
    const deps = fakeDeps({ [rootA]: ['proj-a'], [rootB]: ['proj-b'] }, [
      join(rootA, 'proj-a', '.git'),
      join(rootB, 'proj-b', '.git'),
    ]);

    expect(scanProjects([rootA, rootB], deps)).toEqual([
      { path: join(rootA, 'proj-a'), name: 'proj-a', root: rootA },
      { path: join(rootB, 'proj-b'), name: 'proj-b', root: rootB },
    ]);
  });
});

describe('defaultProjectRoots', () => {
  it('retorna ~/seazone e ~/pessoal (FR-001)', () => {
    const roots = defaultProjectRoots(() => 'C:\\Users\\fake-user');

    expect(roots).toEqual([join('C:\\Users\\fake-user', 'seazone'), join('C:\\Users\\fake-user', 'pessoal')]);
  });
});

describe('mergeFavorites', () => {
  it('marca favorite=true nos projetos escaneados presentes na lista de favoritos', () => {
    const scanned = [
      { path: 'C:\\r\\a', name: 'a', root: 'C:\\r' },
      { path: 'C:\\r\\b', name: 'b', root: 'C:\\r' },
    ];

    expect(mergeFavorites(scanned, ['C:\\r\\a'])).toEqual([
      { path: 'C:\\r\\a', name: 'a', root: 'C:\\r', favorite: true },
      { path: 'C:\\r\\b', name: 'b', root: 'C:\\r', favorite: false },
    ]);
  });

  it('favorito que sumiu do scan entra como missing:true (ui-spec §2)', () => {
    const scanned = [{ path: 'C:\\r\\a', name: 'a', root: 'C:\\r' }];

    const result = mergeFavorites(scanned, ['C:\\r\\a', 'C:\\removido\\projeto-x']);

    expect(result).toContainEqual({
      path: 'C:\\removido\\projeto-x',
      name: 'projeto-x',
      root: 'C:\\removido',
      favorite: true,
      missing: true,
    });
    expect(result).toHaveLength(2);
  });
});

// `sortProjects` mudou de casa (agora `src/shared/projects.ts`, pura — ver
// comentário de topo do arquivo) — coberta em tests/projects.test.ts, junto
// do cenário de reordenação otimista (feedback E2E rodada 3).
