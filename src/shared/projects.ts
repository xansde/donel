// T007 — tipos IPC do domínio de projetos (FR-001, plan.md "projects:list|favorite").
// ProjectScanner + merge de favoritos vivem no main process
// (src/main/project-scanner.ts, src/main/project-config-store.ts); aqui só o
// contrato compartilhado com preload/renderer.

export const PROJECT_CHANNELS = {
  list: 'projects:list',
  favorite: 'projects:favorite',
} as const;

export interface ProjectInfo {
  /** Caminho absoluto do diretório do projeto. */
  path: string;
  /** Nome do diretório, ex. "donel-dev". */
  name: string;
  /** Root de scan (ou dirname do favorito) em que o projeto foi agrupado. */
  root: string;
  favorite: boolean;
  /**
   * true quando o projeto era favorito mas não apareceu no scan atual —
   * removido do disco ou movido pra fora dos roots configurados. A UI mostra
   * esmaecido com ação "remover" (ui-spec §2).
   */
  missing?: boolean;
}

/** API tipada exposta pelo preload em `window.donel.projects`. */
export interface DonelProjectsApi {
  /** Lista projetos escaneados (FR-001) com favoritos mesclados, já ordenados. */
  list(): Promise<ProjectInfo[]>;
  /** Marca/desmarca favorito; retorna a lista já atualizada (evita round-trip extra). */
  setFavorite(path: string, favorite: boolean): Promise<ProjectInfo[]>;
}

/**
 * Favoritos no topo (dentro do próprio root); resto alfabético (ui-spec §2).
 *
 * Movida de `src/main/project-scanner.ts` (correção do feedback E2E rodada
 * 3, "favoritar projeto só reflete após reiniciar o app") — função pura, sem
 * `node:fs`/`node:path`, por isso pode viver em `shared/` e ser importada
 * pelo RENDERER também: `App.tsx` reordena a lista otimisticamente no
 * próprio clique da estrela (mesma regra de ordenação do main process,
 * agora com uma única fonte de verdade), sem esperar o round-trip do IPC
 * (`projects:favorite`) — o scan de projetos no main é uma varredura
 * síncrona de filesystem (`scanProjects`) que pode levar dezenas/centenas
 * de ms com vários repos sob os roots, tempo suficiente pra parecer "não
 * reflete" a um clique impaciente. `project-scanner.ts` reexporta esta
 * função (mesmo caminho de import de antes, `main/index.ts` e os testes
 * existentes não mudam).
 */
export function sortProjects(projects: readonly ProjectInfo[]): ProjectInfo[] {
  return [...projects].sort((a, b) => {
    const rootCompare = a.root.localeCompare(b.root);
    if (rootCompare !== 0) return rootCompare;
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
