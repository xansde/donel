import { describe, expect, it, vi } from 'vitest';
import { hasAnyEntryForProject, pruneOrphans, seedProject } from '../src/main/session-seed';
import type { SessionSummary } from '../src/main/session-indexer';
import type { SessionRegistry } from '../src/shared/sessionRegistry';

// T706 (007-favoritos-sessoes) — a ÚNICA leitura de disco desta feature
// (CA-8). TDD: nenhuma implementação existia antes deste arquivo.

const PROJECT = 'C:\\fake\\projeto';

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    filePath: `C:\\fake\\claude\\projects\\slug\\${id}.jsonl`,
    mtimeMs: 1000,
    size: 100,
    preview: `preview ${id}`,
    corrupted: false,
    lastActivityAt: 1000,
    customTitle: null,
    ...overrides,
  };
}

describe('hasAnyEntryForProject', () => {
  it('false quando não há nenhuma entrada do projeto', () => {
    expect(hasAnyEntryForProject({}, PROJECT)).toBe(false);
  });

  it('true quando há ao menos uma entrada do projeto', () => {
    const registry: SessionRegistry = { s1: { sessionId: 's1', projectPath: PROJECT, label: 'x', lastActivityAt: 1, pinned: false } };
    expect(hasAnyEntryForProject(registry, PROJECT)).toBe(true);
  });

  it('ignora entradas de OUTRO projeto', () => {
    const registry: SessionRegistry = { s1: { sessionId: 's1', projectPath: 'C:\\outro', label: 'x', lastActivityAt: 1, pinned: false } };
    expect(hasAnyEntryForProject(registry, PROJECT)).toBe(false);
  });
});

describe('pruneOrphans (CA-11 — órfã some sozinha, inclusive fixada)', () => {
  it('remove entrada cujo sessionId não está mais no disco', () => {
    const registry: SessionRegistry = {
      viva: { sessionId: 'viva', projectPath: PROJECT, label: 'x', lastActivityAt: 1, pinned: false },
      orfa: { sessionId: 'orfa', projectPath: PROJECT, label: 'y', lastActivityAt: 1, pinned: true }, // C3: até fixada some
    };
    expect(pruneOrphans(registry, PROJECT, new Set(['viva']))).toEqual({ viva: registry.viva });
  });

  it('não mexe em entradas de outro projeto', () => {
    const registry: SessionRegistry = {
      a: { sessionId: 'a', projectPath: PROJECT, label: 'x', lastActivityAt: 1, pinned: false },
      b: { sessionId: 'b', projectPath: 'C:\\outro', label: 'y', lastActivityAt: 1, pinned: false },
    };
    expect(pruneOrphans(registry, PROJECT, new Set())).toEqual({ b: registry.b });
  });

  it('registro sem nenhuma entrada do projeto é no-op', () => {
    expect(pruneOrphans({}, PROJECT, new Set())).toEqual({});
  });
});

describe('seedProject (T706)', () => {
  it('projeto sem registro semeia até RECENT_PER_PROJECT, as mais recentes por atividade', async () => {
    const sessions = [1, 2, 3, 4, 5, 6, 7].map((n) => summary(`s${n}`, { lastActivityAt: n * 1000 }));
    const indexProjectSessions = vi.fn().mockResolvedValue(sessions);

    const result = await seedProject({}, PROJECT, {}, { indexProjectSessions });

    expect(Object.keys(result)).toHaveLength(5);
    expect(result.s7).toBeDefined();
    expect(result.s3).toBeDefined();
    expect(result.s2).toBeUndefined(); // fora do top 5 por recência
    expect(result.s1).toBeUndefined();
  });

  it('resolve o rótulo pela MESMA regra da aba/sidebar (customTitle do CLI vence o preview) — CA-10', async () => {
    const sessions = [summary('s1', { preview: 'preview cru', customTitle: 'Nome dado no CLI' })];
    const indexProjectSessions = vi.fn().mockResolvedValue(sessions);

    const result = await seedProject({}, PROJECT, {}, { indexProjectSessions });
    expect(result.s1?.label).toBe('Nome dado no CLI');
  });

  it('sem customTitle, usa o preview como fallback', async () => {
    const sessions = [summary('s1', { preview: 'preview cru', customTitle: null })];
    const indexProjectSessions = vi.fn().mockResolvedValue(sessions);

    const result = await seedProject({}, PROJECT, {}, { indexProjectSessions });
    expect(result.s1?.label).toBe('preview cru');
  });

  it('projeto COM registro não lê disco — zero chamadas ao indexer (guarda dura)', async () => {
    const registry: SessionRegistry = { existing: { sessionId: 'existing', projectPath: PROJECT, label: 'x', lastActivityAt: 1, pinned: false } };
    const indexProjectSessions = vi.fn().mockResolvedValue([]);

    const result = await seedProject(registry, PROJECT, {}, { indexProjectSessions });

    expect(indexProjectSessions).not.toHaveBeenCalled();
    expect(result).toEqual(registry);
  });

  it('projeto sem sessão nenhuma no disco não cria entrada nem lança', async () => {
    const indexProjectSessions = vi.fn().mockResolvedValue([]);
    const result = await seedProject({}, PROJECT, {}, { indexProjectSessions });
    expect(result).toEqual({});
  });

  it('indexProjectSessions que lança não derruba a semeadura — devolve o registro como estava', async () => {
    const indexProjectSessions = vi.fn().mockRejectedValue(new Error('EIO simulado'));
    const result = await seedProject({}, PROJECT, {}, { indexProjectSessions });
    expect(result).toEqual({});
  });

  it('passa o claudeHome pro indexer quando informado (fixture de perfil isolado)', async () => {
    const indexProjectSessions = vi.fn().mockResolvedValue([]);
    await seedProject({}, PROJECT, {}, { indexProjectSessions }, 'C:\\fake\\claude-home');
    expect(indexProjectSessions).toHaveBeenCalledWith(PROJECT, { claudeHome: 'C:\\fake\\claude-home' });
  });

  it('sem claudeHome, chama o indexer sem opção (usa o default dele)', async () => {
    const indexProjectSessions = vi.fn().mockResolvedValue([]);
    await seedProject({}, PROJECT, {}, { indexProjectSessions });
    expect(indexProjectSessions).toHaveBeenCalledWith(PROJECT, {});
  });
});
