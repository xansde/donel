import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// FIX (auditoria rodada 5, achado media "playwright.config.ts" — suíte não
// verde por vazamento de estado real) — CAUSA RAIZ confirmada pela
// auditoria: todo smoke deste diretório roda o app buildado contra o
// userData REAL da máquina (`%APPDATA%\donel-dev`), então o ConfigStore
// persistente (T015) vaza entre execuções e entre arquivos de spec —
// `launcherDefaults` flagrado com valor de uma run anterior (não o default
// que os testes assumem) foi a causa raiz real de `terminal.spec.ts:153` e
// `model-injection.spec.ts:44` falharem, sem relação nenhuma com o código
// sob teste. Cada spec que chama `createIsolatedUserDataDir` abaixo ganha um
// `--user-data-dir` do Electron próprio (temp, descartável), nascendo sempre
// limpo — nunca herda nem contamina o estado real do Alexandre nem o de
// outro arquivo de spec.
//
// EXCEÇÃO DELIBERADA: `config-persistence.spec.ts` NÃO usa isto. O propósito
// DECLARADO daquele teste é provar persistência no path REAL de produção
// (`%APPDATA%\donel-dev\config.json`, T015 DoD/roteiro batch 5 passo 1) —
// isolar o userData dele quebraria o próprio objeto do teste. A higiene
// daquele arquivo já é outra (restaura os valores originais no `afterAll`);
// mantém-se assim de propósito.

/** Cria um diretório temp único (`os.tmpdir()`) pra servir de `--user-data-dir` de UM arquivo de spec — nunca compartilhado entre specs. */
export function createIsolatedUserDataDir(specName: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `donel-dev-smoke-${specName}-`));
}

/** Remove o diretório temp criado por `createIsolatedUserDataDir` — chamar sempre no `afterAll`, mesmo se o teste falhou. */
export function removeIsolatedUserDataDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
