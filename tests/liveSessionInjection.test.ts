// T011 — Injeção de modelo/esforço em sessão viva (FR-011), TDD.
//
// `canInjectLiveCommand`/`buildModelInjection`/`buildEffortInjection` são
// puras (sem I/O) — quem de fato escreve no stdin do PTY é
// TerminalPane.injectCommand (via window.donel.pty.input), chamado pelo
// App.tsx só quando esta função devolver `true`. Ver comentário de topo de
// src/shared/liveSessionInjection.ts pra evidência de que `/model` e
// `/effort` existem os dois como slash commands reais na versão instalada
// do CLI (2.1.218) — a "degradação" do FR-011 só entra por falta de
// PROCESSO VIVO, não por falta de comando nativo.
import { describe, expect, it } from 'vitest';
import {
  buildEffortInjection,
  buildModelInjection,
  canInjectLiveCommand,
  hasLiveInjectionConfirmation,
} from '../src/shared/liveSessionInjection';

describe('canInjectLiveCommand', () => {
  it('permite quando o semáforo está "waiting" (prompt ocioso) e o processo está vivo', () => {
    expect(canInjectLiveCommand('waiting', true)).toBe(true);
  });

  (['working', 'permission', 'error', 'done'] as const).forEach((state) => {
    it(`bloqueia quando o semáforo está "${state}" mesmo com o processo vivo`, () => {
      expect(canInjectLiveCommand(state, true)).toBe(false);
    });
  });

  it('bloqueia quando o estado é undefined (aba recém-criada, ainda sem primeiro evento de hook)', () => {
    expect(canInjectLiveCommand(undefined, true)).toBe(false);
  });

  it('bloqueia "waiting" sem processo vivo (sessão encerrada entre o último hook e o clique — corrida rara, defesa em profundidade)', () => {
    expect(canInjectLiveCommand('waiting', false)).toBe(false);
  });
});

describe('buildModelInjection', () => {
  (['fable', 'opus', 'sonnet', 'haiku'] as const).forEach((alias) => {
    it(`monta "/model ${alias}\\r" pro alias ${alias}`, () => {
      expect(buildModelInjection(alias)).toBe(`/model ${alias}\r`);
    });
  });
});

describe('buildEffortInjection', () => {
  (['low', 'medium', 'high', 'xhigh', 'max'] as const).forEach((level) => {
    it(`monta "/effort ${level}\\r" pro nível ${level}`, () => {
      expect(buildEffortInjection(level)).toBe(`/effort ${level}\r`);
    });
  });
});

// T013 (correção herdada) — a UI não pode mais assumir sucesso só porque
// `injectCommand` escreveu no stdin; ela passa a esperar a confirmação real
// do CLI no snapshot ATUAL do buffer JÁ RENDERIZADO do terminal (xterm
// `term.buffer.active`, lido via evento — `onRenderedUpdate`, nunca
// `setInterval`, ver App.tsx `watchLiveInjection`). Sem baseline: ver
// comentário de topo destas funções em src/shared/liveSessionInjection.ts
// pro porquê (três tentativas alternativas falharam contra o CLI real —
// a última delas, um diffing "só linhas novas desde um baseline", quebrou
// porque este CLI redesenha um viewport de tamanho FIXO, não um log
// sequencial que só cresce).
describe('hasLiveInjectionConfirmation', () => {
  it('detects "Set model to <display name>" for kind "model"', () => {
    const current = ['some earlier output', 'Set model to Sonnet 5'];
    expect(hasLiveInjectionConfirmation(current, 'model')).toBe(true);
  });

  it('detects "Set effort level to <level>" for kind "effort"', () => {
    const current = ['some earlier output', 'Set effort level to high'];
    expect(hasLiveInjectionConfirmation(current, 'effort')).toBe(true);
  });

  it('detects the confirmation line even when it is NOT the last line of the snapshot (viewport fixo, a barra de status vem depois)', () => {
    const current = [
      '❯ /model sonnet',
      '  ⎿  Set model to Sonnet 5 and saved as your default for new sessions',
      '                                                 Stop hook error occurred · ctrl+o to see',
      '────────────────────────────────────────────────────────────────── model-injection-test ──',
      '❯ ',
      '──────────────────────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ accept edits on (shift+tab to cycle)                                             /rc ',
    ];
    expect(hasLiveInjectionConfirmation(current, 'model')).toBe(true);
  });

  it('does not cross-match model confirmation text against an effort check', () => {
    expect(hasLiveInjectionConfirmation(['Set model to Sonnet 5'], 'effort')).toBe(false);
  });

  it('returns false while only the interactive "Switch model?" prompt (not yet confirmed) is visible', () => {
    const current = ['prompt idle', 'Switch model?', '❯ 1. Yes, switch to Sonnet 5', '  2. No, keep current model'];
    expect(hasLiveInjectionConfirmation(current, 'model')).toBe(false);
  });

  it('returns false for an empty snapshot (terminal ainda não montado)', () => {
    expect(hasLiveInjectionConfirmation([], 'model')).toBe(false);
  });
});
