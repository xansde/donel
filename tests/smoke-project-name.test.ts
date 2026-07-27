import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T804 (008) — cerca de regressão do §B19.
//
// O §B19 era invisível: 5 smokes falhavam 100% das vezes fora da pasta
// `donel-dev`, e quem não soubesse do achado leria os vermelhos como regressão
// da própria feature — ou pior, mascararia como "vermelho conhecido". O
// conserto (T801–T803) troca o nome hardcoded pelo `PROJECT_NAME` calculado de
// `tests/smoke/repoUnderTest.ts`; esta cerca é o que impede a próxima sessão de
// reintroduzir o hardcode sem perceber.
//
// A checagem é sobre CÓDIGO EXECUTÁVEL: comentário citando `donel-dev` é
// legítimo (e útil — vários explicam justamente esta armadilha).

const SMOKE_DIRS = ['tests/smoke', 'tests/smoke-dev'];

/**
 * Ocorrências em que `donel-dev` NÃO é a pasta do repo escaneado — trocar por
 * `PROJECT_NAME` quebraria o teste em qualquer worktree. Cada uma nomeada com o
 * motivo: é o Grupo C da auditoria do `specs/008-fechar-pendencias/plan.md`.
 */
const ALLOWLIST: Record<string, readonly { readonly snippet: string; readonly reason: string }[]> = {
  'config-persistence.spec.ts': [
    {
      snippet: `path.join(String(process.env.APPDATA), 'donel-dev', 'config.json')`,
      reason: 'nome do APP (app.setName), não da pasta do repo — %APPDATA%\\donel-dev é o mesmo em qualquer worktree',
    },
    {
      snippet: `const TEST_ROOT = 'C:\\\\donel-dev-smoke-t015-root'`,
      reason: 'root de projeto FANTASMA inventado pelo teste, não existe no disco',
    },
    {
      snippet: `'Verifique %APPDATA%\\\\donel-dev\\\\config.json manualmente.'`,
      reason: 'texto do aviso de falha de restauração — cita o userData do APP, não a pasta do repo',
    },
  ],
  'userDataIsolation.ts': [
    {
      snippet: 'donel-dev-smoke-${specName}-',
      reason: 'prefixo de mkdtemp (pasta temporária do teste), não o projeto escaneado',
    },
  ],
};

/** Remove comentários de linha e de bloco — o que sobra é o que o runtime enxerga. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Trechos de código (uma linha cada) que citam `donel-dev` e não estão na allowlist do arquivo. */
export function findHardcodedProjectName(source: string, allowed: readonly string[]): string[] {
  return stripComments(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('donel-dev'))
    .filter((line) => !allowed.some((snippet) => line.includes(snippet)));
}

function smokeFiles(): { readonly path: string; readonly name: string }[] {
  const files: { path: string; name: string }[] = [];
  for (const dir of SMOKE_DIRS) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.ts')) files.push({ path: join(dir, name), name });
    }
  }
  return files;
}

describe('§B19 — nenhum smoke hardcoda o nome do projeto', () => {
  it('encontra os arquivos de smoke (a varredura não pode passar vazia e dar verde de graça)', () => {
    const files = smokeFiles();
    expect(files.length).toBeGreaterThanOrEqual(14);
    expect(files.map((file) => file.name)).toContain('favorite-sessions.spec.ts');
    expect(files.map((file) => file.name)).toContain('dev-mode.spec.ts');
  });

  for (const file of smokeFiles()) {
    it(`${file.path} usa PROJECT_NAME, não o literal`, () => {
      const allowed = (ALLOWLIST[file.name] ?? []).map((entry) => entry.snippet);
      const offenders = findHardcodedProjectName(readFileSync(file.path, 'utf8'), allowed);
      expect(
        offenders,
        `${file.path} hardcoda 'donel-dev' em código. Importe PROJECT_NAME de tests/smoke/repoUnderTest.ts ` +
          '(o projeto na sidebar é o basename da PASTA — numa worktree é donel-dev-wt-x). ' +
          'Se a ocorrência NÃO é a pasta do repo (nome do app, pasta temporária, root fantasma), ' +
          'adicione-a à ALLOWLIST deste teste com o motivo.',
      ).toEqual([]);
    });
  }
});

describe('a cerca de verdade pega o hardcode (autoteste do detector)', () => {
  it('flagra o padrão exato que causou o §B19', () => {
    const offending = [
      `const row = sidebar.locator('[data-testid="project-row-donel-dev"]');`,
      `await projectRow.getByRole('button', { name: 'donel-dev', exact: true }).click();`,
      `getByRole('button', { name: 'Sessões anteriores de donel-dev', exact: true })`,
    ].join('\n');
    expect(findHardcodedProjectName(offending, [])).toHaveLength(3);
  });

  it('não flagra comentário nem o que está na allowlist', () => {
    const benign = [
      `// numa worktree (donel-dev-wt-007) o projeto aparece com ESSE nome`,
      `/* %APPDATA%\\donel-dev\\config.json é o userData do app */`,
      `const configPath = path.join(String(process.env.APPDATA), 'donel-dev', 'config.json');`,
    ].join('\n');
    const allowed = ALLOWLIST['config-persistence.spec.ts'].map((entry) => entry.snippet);
    expect(findHardcodedProjectName(benign, allowed)).toEqual([]);
  });

  it('não flagra a forma calculada', () => {
    const fixed = [
      'const row = sidebar.locator(`[data-testid="project-row-${PROJECT_NAME}"]`);',
      `await projectRow.getByRole('button', { name: PROJECT_NAME, exact: true }).click();`,
    ].join('\n');
    expect(findHardcodedProjectName(fixed, [])).toEqual([]);
  });
});
