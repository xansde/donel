import { describe, expect, it } from 'vitest';
import {
  RECENT_PER_PROJECT,
  removeSession,
  selectProjectSessions,
  selectRegisteredIds,
  setPinned,
  shouldRecordVisit,
  upsertVisit,
  VISIT_DEBOUNCE_MS,
  type SessionRegistry,
} from '../src/shared/sessionRegistry';

// T701–T703 (007-favoritos-sessoes, Fatia 0) — modelo puro do registro de
// sessões recentes/fixadas por projeto (D9/CA-7: fonte da lista no boot).
// TDD: nenhuma implementação existia antes deste arquivo.

const PROJECT_A = 'C:\\Users\\fake\\seazone\\donel-dev';
const PROJECT_B = 'C:\\Users\\fake\\seazone\\outro-projeto';

function visit(sessionId: string, atMs: number, projectPath = PROJECT_A, label = `sessão ${sessionId}`) {
  return { sessionId, projectPath, label, atMs };
}

describe('upsertVisit + poda na escrita (CA-2, C4)', () => {
  it('grava a primeira visita de um projeto', () => {
    const registry = upsertVisit({}, visit('s1', 1000));
    expect(registry).toEqual({
      s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'sessão s1', lastActivityAt: 1000, pinned: false },
    });
  });

  it('6ª visita empurra a mais antiga NÃO-fixada', () => {
    let registry: SessionRegistry = {};
    for (let i = 1; i <= 5; i += 1) {
      registry = upsertVisit(registry, visit(`s${i}`, i * 1000));
    }
    expect(Object.keys(registry)).toHaveLength(5);

    registry = upsertVisit(registry, visit('s6', 6000));
    expect(Object.keys(registry)).toHaveLength(5);
    expect(registry.s1).toBeUndefined(); // mais antiga (atMs=1000) foi podada
    expect(registry.s6).toBeDefined();
  });

  it('fixada NUNCA é podada, mesmo com 10 visitas novas depois', () => {
    let registry: SessionRegistry = { pinned1: { sessionId: 'pinned1', projectPath: PROJECT_A, label: 'fixa', lastActivityAt: 1, pinned: true } };
    for (let i = 1; i <= 10; i += 1) {
      registry = upsertVisit(registry, visit(`s${i}`, i * 1000));
    }
    expect(registry.pinned1).toBeDefined();
    expect(registry.pinned1?.pinned).toBe(true);
  });

  it('visita não desfixa uma sessão fixada (preserva pinned)', () => {
    let registry: SessionRegistry = {
      s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'antigo', lastActivityAt: 1, pinned: true },
    };
    registry = upsertVisit(registry, visit('s1', 2000, PROJECT_A, 'novo label'));
    expect(registry.s1).toEqual({ sessionId: 's1', projectPath: PROJECT_A, label: 'novo label', lastActivityAt: 2000, pinned: true });
  });

  it('registro de OUTRO projeto não interfere na poda', () => {
    let registry: SessionRegistry = {};
    for (let i = 1; i <= 5; i += 1) registry = upsertVisit(registry, visit(`a${i}`, i * 1000, PROJECT_A));
    registry = upsertVisit(registry, visit('b1', 999, PROJECT_B));

    expect(Object.keys(registry)).toHaveLength(6); // 5 de A + 1 de B, nenhuma poda cruzada
    expect(registry.b1).toBeDefined();
  });

  it('label vazio (ou só espaço) é rejeitado — nunca cria linha sem texto', () => {
    const registry = upsertVisit({}, visit('s1', 1000, PROJECT_A, '   '));
    expect(registry).toEqual({});
  });

  it('sessionId ou projectPath vazios são no-op', () => {
    expect(upsertVisit({}, visit('', 1000))).toEqual({});
    expect(upsertVisit({}, visit('s1', 1000, ''))).toEqual({});
  });

  it('não muta o registro recebido', () => {
    const before: SessionRegistry = {};
    upsertVisit(before, visit('s1', 1000));
    expect(before).toEqual({});
  });
});

describe('setPinned / removeSession (T702)', () => {
  it('fixa uma sessão existente', () => {
    const before: SessionRegistry = { s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'x', lastActivityAt: 1, pinned: false } };
    const after = setPinned(before, 's1', true);
    expect(after.s1?.pinned).toBe(true);
  });

  it('desfixar NÃO remove a entrada — ela continua existindo e concorrendo pelas vagas', () => {
    const before: SessionRegistry = { s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'x', lastActivityAt: 1, pinned: true } };
    const after = setPinned(before, 's1', false);
    expect(after.s1).toEqual({ sessionId: 's1', projectPath: PROJECT_A, label: 'x', lastActivityAt: 1, pinned: false });
  });

  it('desfixar e depois receber visitas mais novas: ela é podada normalmente se ficar velha', () => {
    let registry: SessionRegistry = { old: { sessionId: 'old', projectPath: PROJECT_A, label: 'old', lastActivityAt: 1, pinned: true } };
    registry = setPinned(registry, 'old', false);
    for (let i = 1; i <= 5; i += 1) registry = upsertVisit(registry, visit(`s${i}`, i * 1000 + 10));
    expect(registry.old).toBeUndefined();
  });

  it('setPinned em sessionId inexistente é no-op (não cria entrada fantasma)', () => {
    expect(setPinned({}, 'nao-existe', true)).toEqual({});
  });

  it('setPinned não muta o mapa recebido', () => {
    const before: SessionRegistry = { s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'x', lastActivityAt: 1, pinned: false } };
    setPinned(before, 's1', true);
    expect(before.s1?.pinned).toBe(false);
  });

  it('removeSession remove a entrada (o "esquecer" do CA-11)', () => {
    const before: SessionRegistry = { s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'x', lastActivityAt: 1, pinned: true } };
    expect(removeSession(before, 's1')).toEqual({});
  });

  it('removeSession de inexistente é no-op', () => {
    const before: SessionRegistry = { s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'x', lastActivityAt: 1, pinned: false } };
    expect(removeSession(before, 'nao-existe')).toEqual(before);
  });

  it('removeSession não muta o mapa recebido', () => {
    const before: SessionRegistry = { s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'x', lastActivityAt: 1, pinned: false } };
    removeSession(before, 's1');
    expect(before.s1).toBeDefined();
  });
});

describe('selectProjectSessions / selectRegisteredIds (T703)', () => {
  it('ordena por lastActivityAt desc', () => {
    const registry: SessionRegistry = {
      s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'a', lastActivityAt: 1000, pinned: false },
      s2: { sessionId: 's2', projectPath: PROJECT_A, label: 'b', lastActivityAt: 3000, pinned: false },
      s3: { sessionId: 's3', projectPath: PROJECT_A, label: 'c', lastActivityAt: 2000, pinned: false },
    };
    expect(selectProjectSessions(registry, PROJECT_A).map((s) => s.sessionId)).toEqual(['s2', 's3', 's1']);
  });

  it('fixada antiga aparece ALÉM das 5, sem duplicar quando já está entre as 5', () => {
    const registry: SessionRegistry = {
      pinnedOld: { sessionId: 'pinnedOld', projectPath: PROJECT_A, label: 'fixa antiga', lastActivityAt: 1, pinned: true },
      s1: { sessionId: 's1', projectPath: PROJECT_A, label: 'a', lastActivityAt: 5000, pinned: false },
      s2: { sessionId: 's2', projectPath: PROJECT_A, label: 'b', lastActivityAt: 4000, pinned: false },
    };
    const result = selectProjectSessions(registry, PROJECT_A);
    expect(result.map((s) => s.sessionId)).toEqual(['s1', 's2', 'pinnedOld']);
    expect(new Set(result.map((s) => s.sessionId)).size).toBe(3); // sem duplicata
  });

  it('projeto sem nada devolve []', () => {
    expect(selectProjectSessions({}, PROJECT_A)).toEqual([]);
  });

  it('selectRegisteredIds devolve a união de 2 projetos e ignora os demais', () => {
    const registry: SessionRegistry = {
      a1: { sessionId: 'a1', projectPath: PROJECT_A, label: 'a', lastActivityAt: 1, pinned: false },
      b1: { sessionId: 'b1', projectPath: PROJECT_B, label: 'b', lastActivityAt: 1, pinned: false },
      c1: { sessionId: 'c1', projectPath: 'C:\\outro\\nao-favoritado', label: 'c', lastActivityAt: 1, pinned: false },
    };
    const ids = selectRegisteredIds(registry, [PROJECT_A, PROJECT_B]);
    expect(ids).toEqual(new Set(['a1', 'b1']));
  });
});

describe('RECENT_PER_PROJECT', () => {
  it('é 5 (D2/CA-2 — falas verbatim do discovery)', () => {
    expect(RECENT_PER_PROJECT).toBe(5);
  });
});

describe('shouldRecordVisit (T707 — debounce de ~10s no gatilho do transcript)', () => {
  const prev = { label: 'nome atual', projectPath: PROJECT_A };

  it('primeira visita (sem escrita anterior) sempre grava', () => {
    expect(shouldRecordVisit({ lastWriteMs: undefined, nowMs: 1000, previous: null, next: prev })).toBe(true);
  });

  it('mesma sessão, < 10s, sem mudança de rótulo/projeto → NÃO grava', () => {
    expect(
      shouldRecordVisit({ lastWriteMs: 1000, nowMs: 1000 + VISIT_DEBOUNCE_MS - 1, previous: prev, next: prev }),
    ).toBe(false);
  });

  it('rótulo mudou → grava na hora, mesmo dentro da janela de debounce', () => {
    expect(
      shouldRecordVisit({
        lastWriteMs: 1000,
        nowMs: 1001,
        previous: prev,
        next: { label: 'nome novo', projectPath: PROJECT_A },
      }),
    ).toBe(true);
  });

  it('projectPath mudou → grava na hora', () => {
    expect(
      shouldRecordVisit({ lastWriteMs: 1000, nowMs: 1001, previous: prev, next: { label: prev.label, projectPath: PROJECT_B } }),
    ).toBe(true);
  });

  it('passaram >= 10s desde a última gravação, sem mudança → grava', () => {
    expect(
      shouldRecordVisit({ lastWriteMs: 1000, nowMs: 1000 + VISIT_DEBOUNCE_MS, previous: prev, next: prev }),
    ).toBe(true);
  });
});
