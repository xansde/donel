// T706 (007-favoritos-sessoes) — a ÚNICA leitura de disco desta feature
// (CA-8). Vive num módulo próprio, e não em `main/index.ts`, pelo mesmo motivo
// de `session-indexer.ts`/`profile-manager.ts`/`config-store.ts`: `main/index.ts`
// importa `electron` e nunca é importado por um teste unit — qualquer lógica
// que precise de TDD sem subir o Electron mora num arquivo próprio, com
// dependências injetáveis.

import type { SessionNamesMap } from '../shared/config';
import { resolveSessionName } from '../shared/sessionName';
import { RECENT_PER_PROJECT, removeSession, upsertVisit, type SessionRegistry } from '../shared/sessionRegistry';
import type { SessionSummary } from './session-indexer';

export interface SeedProjectDeps {
  readonly indexProjectSessions: (projectPath: string, opts?: { claudeHome?: string }) => Promise<SessionSummary[]>;
}

/** Guarda dura do CA-8: `true` quando o registro já tem QUALQUER entrada daquele projeto — é o que impede o handler de ler disco de novo (proteção contra o renderer chamar em loop). */
export function hasAnyEntryForProject(registry: SessionRegistry, projectPath: string): boolean {
  return Object.values(registry).some((entry) => entry.projectPath === projectPath);
}

/**
 * CA-11 — remove do registro, SÓ daquele projeto, qualquer entrada cujo
 * `sessionId` não esteja em `existingIds` (o que o disco tem AGORA). Inclusive
 * fixada (C3, consequência aceita). Puro: usado por `seedProject` e testável
 * isoladamente, sem depender do caminho real de guarda de `hasAnyEntryForProject`.
 */
export function pruneOrphans(registry: SessionRegistry, projectPath: string, existingIds: ReadonlySet<string>): SessionRegistry {
  let next = registry;
  for (const [sessionId, entry] of Object.entries(registry)) {
    if (entry.projectPath === projectPath && !existingIds.has(sessionId)) {
      next = removeSession(next, sessionId);
    }
  }
  return next;
}

/**
 * Semeadura única de um projeto favoritado (CA-8/plan.md §Fatia 2): só roda
 * quando o projeto não tem NENHUMA entrada no registro. Converte as
 * `RECENT_PER_PROJECT` sessões mais recentes do disco em visitas, com o
 * rótulo resolvido pela MESMA regra da aba/sidebar (`resolveSessionName`,
 * CA-10) — nunca um segundo jeito de nomear a mesma sessão. Nunca lança:
 * falha do indexer (ou projeto sem sessão nenhuma) devolve o registro como
 * estava, sem criar entrada nem derrubar o handler.
 */
export async function seedProject(
  registry: SessionRegistry,
  projectPath: string,
  sessionNames: SessionNamesMap,
  deps: SeedProjectDeps,
  claudeHome?: string,
): Promise<SessionRegistry> {
  if (hasAnyEntryForProject(registry, projectPath)) return registry;

  let sessions: SessionSummary[];
  try {
    sessions = await deps.indexProjectSessions(projectPath, claudeHome ? { claudeHome } : {});
  } catch {
    return registry;
  }

  const existingIds = new Set(sessions.map((session) => session.id));
  let next = pruneOrphans(registry, projectPath, existingIds);

  const mostRecent = [...sessions]
    .sort((a, b) => (b.lastActivityAt ?? b.mtimeMs) - (a.lastActivityAt ?? a.mtimeMs))
    .slice(0, RECENT_PER_PROJECT);

  for (const session of mostRecent) {
    const label = resolveSessionName({
      fallback: session.preview,
      customTitle: session.customTitle,
      stored: sessionNames[session.id] ?? null,
    });
    next = upsertVisit(next, {
      sessionId: session.id,
      projectPath,
      label,
      atMs: session.lastActivityAt ?? session.mtimeMs,
    });
  }

  return next;
}
