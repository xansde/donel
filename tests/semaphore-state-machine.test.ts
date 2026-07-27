import { describe, expect, it } from 'vitest';
import {
  applyPermissionHeuristic,
  defaultMatchesPermissionPrompt,
  INITIAL_SEMAPHORE_STATE,
  reduceSemaphoreState,
  type SemaphoreMachineState,
} from '../src/main/semaphore-state-machine';

// T009 — TDD da máquina de estados pura (FR-010). Transições conforme
// specs/001-mvp/spike-t002-resultado.md ("Decisão de arquitetura para T009")
// + addendum (Notification confirmada em PTY real).

describe('reduceSemaphoreState', () => {
  it('começa em working (INITIAL_SEMAPHORE_STATE)', () => {
    expect(INITIAL_SEMAPHORE_STATE.state).toBe('working');
    expect(INITIAL_SEMAPHORE_STATE.pendingToolSince).toBeNull();
  });

  it('userPromptSubmit -> working', () => {
    const after = reduceSemaphoreState({ state: 'waiting', pendingToolSince: null, stateEnteredAt: 0 }, { type: 'userPromptSubmit', at: 100 });
    expect(after.state).toBe('working');
    expect(after.stateEnteredAt).toBe(100);
  });

  it('preToolUse mantém working e registra pendingToolSince', () => {
    const after = reduceSemaphoreState(INITIAL_SEMAPHORE_STATE, { type: 'preToolUse', at: 50 });
    expect(after.state).toBe('working');
    expect(after.pendingToolSince).toBe(50);
  });

  it('preToolUse refresca pendingToolSince a cada chamada, sem alterar stateEnteredAt de working', () => {
    const workingSince10: SemaphoreMachineState = { state: 'working', pendingToolSince: null, stateEnteredAt: 10 };
    const afterFirst = reduceSemaphoreState(workingSince10, { type: 'preToolUse', at: 20 });
    const afterSecond = reduceSemaphoreState(afterFirst, { type: 'preToolUse', at: 35 });

    expect(afterSecond.state).toBe('working');
    expect(afterSecond.pendingToolSince).toBe(35);
    expect(afterSecond.stateEnteredAt).toBe(10); // não mudou — ainda é o mesmo "working" de antes
  });

  it('postToolUse limpa pendingToolSince (clearPending do spike) sem mudar o estado', () => {
    const pending: SemaphoreMachineState = { state: 'working', pendingToolSince: 42, stateEnteredAt: 0 };
    const after = reduceSemaphoreState(pending, { type: 'postToolUse', at: 99 });

    expect(after.state).toBe('working');
    expect(after.pendingToolSince).toBeNull();
  });

  it('stop -> waiting, mesmo com pendingToolSince setado', () => {
    const pending: SemaphoreMachineState = { state: 'working', pendingToolSince: 42, stateEnteredAt: 0 };
    const after = reduceSemaphoreState(pending, { type: 'stop', at: 100 });

    expect(after.state).toBe('waiting');
    expect(after.pendingToolSince).toBeNull();
    expect(after.stateEnteredAt).toBe(100);
  });

  it('notification -> permission (sinal primário confirmado no addendum T009)', () => {
    const after = reduceSemaphoreState(INITIAL_SEMAPHORE_STATE, { type: 'notification', at: 77 });
    expect(after.state).toBe('permission');
    expect(after.stateEnteredAt).toBe(77);
  });

  it('stop a partir de permission volta pra waiting (turno concluído após aprovação)', () => {
    const pending: SemaphoreMachineState = { state: 'permission', pendingToolSince: null, stateEnteredAt: 10 };
    const after = reduceSemaphoreState(pending, { type: 'stop', at: 200 });

    expect(after.state).toBe('waiting');
    expect(after.stateEnteredAt).toBe(200);
  });

  it('sessionEnd -> done a partir de qualquer estado', () => {
    for (const state of ['working', 'waiting', 'permission'] as const) {
      const after = reduceSemaphoreState({ state, pendingToolSince: null, stateEnteredAt: 0 }, { type: 'sessionEnd', at: 5 });
      expect(after.state).toBe('done');
    }
  });

  it('processExit -> done, tem prioridade e nunca depende de sessionEnd (kill forçado do spike)', () => {
    const permission: SemaphoreMachineState = { state: 'permission', pendingToolSince: null, stateEnteredAt: 10 };
    const after = reduceSemaphoreState(permission, { type: 'processExit', at: 15 });

    expect(after.state).toBe('done');
    expect(after.stateEnteredAt).toBe(15);
  });

  it('done é terminal — nenhum evento tira a sessão desse estado', () => {
    const done: SemaphoreMachineState = { state: 'done', pendingToolSince: null, stateEnteredAt: 10 };

    for (const event of [
      { type: 'userPromptSubmit', at: 20 },
      { type: 'preToolUse', at: 20 },
      { type: 'notification', at: 20 },
      { type: 'stop', at: 20 },
    ] as const) {
      expect(reduceSemaphoreState(done, event)).toBe(done); // mesma referência — no-op real
    }
  });
});

describe('applyPermissionHeuristic', () => {
  const MATCH = () => true;
  const NO_MATCH = () => false;

  it('não-op fora do estado working', () => {
    const waiting: SemaphoreMachineState = { state: 'waiting', pendingToolSince: null, stateEnteredAt: 0 };
    expect(applyPermissionHeuristic(waiting, 10_000, 2500, [], MATCH)).toBe(waiting);
  });

  it('não-op sem pendingToolSince (nenhuma ferramenta em curso)', () => {
    const working: SemaphoreMachineState = { state: 'working', pendingToolSince: null, stateEnteredAt: 0 };
    expect(applyPermissionHeuristic(working, 10_000, 2500, [], MATCH)).toBe(working);
  });

  it('não-op quando o timeout ainda não estourou, mesmo com o padrão batendo', () => {
    const pending: SemaphoreMachineState = { state: 'working', pendingToolSince: 1000, stateEnteredAt: 0 };
    // now - pendingToolSince = 2000ms < timeout de 2500ms
    expect(applyPermissionHeuristic(pending, 3000, 2500, [], MATCH)).toBe(pending);
  });

  it('não-op quando o timeout estourou mas o ring buffer NÃO bate com um prompt de permissão (evita falso positivo de ferramenta lenta)', () => {
    const pending: SemaphoreMachineState = { state: 'working', pendingToolSince: 1000, stateEnteredAt: 0 };
    expect(applyPermissionHeuristic(pending, 5000, 2500, ['baixando dependências...'], NO_MATCH)).toBe(pending);
  });

  it('promove pra permission quando os DOIS sinais concordam (timeout estourado + regex bate)', () => {
    const pending: SemaphoreMachineState = { state: 'working', pendingToolSince: 1000, stateEnteredAt: 0 };
    const after = applyPermissionHeuristic(pending, 5000, 2500, ['Do you want to proceed?'], MATCH);

    expect(after.state).toBe('permission');
    expect(after.stateEnteredAt).toBe(5000);
    expect(after.pendingToolSince).toBeNull();
  });
});

describe('defaultMatchesPermissionPrompt', () => {
  it('reconhece o texto real observado no addendum T009 (PTY real, prompt interativo em inglês)', () => {
    expect(defaultMatchesPermissionPrompt(['Bash requires confirmation for this command.', 'Do you want to proceed? 1. Yes 2. No'])).toBe(true);
  });

  it('reconhece o texto de auto-negação headless do spike original ("Preciso de sua permissão")', () => {
    expect(defaultMatchesPermissionPrompt(['Preciso de sua permissão para usar o Bash.'])).toBe(true);
  });

  it('não reconhece output arbitrário sem relação com permissão', () => {
    expect(defaultMatchesPermissionPrompt(['Compilando...', 'npm run build', '3 arquivos alterados'])).toBe(false);
  });
});
