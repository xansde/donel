import { describe, expect, it } from 'vitest';
import {
  RESUME_FAILURE_WINDOW_MS,
  forgetIfOrphan,
  resumedSessionIdFromArgs,
  shouldForgetOnResumeFailure,
} from '../src/shared/resumeFailure';
import type { SessionRegistry } from '../src/shared/sessionRegistry';

// T805/T806 (008) — o 2º momento do CA-11 da 007: "quando uma tentativa de
// retomar aquela sessão falha". A medição contra o binário real está em
// `specs/008-fechar-pendencias/medicao-t710.md`: no PTY, `claude -r <uuid
// inexistente>` sai com exitCode 1 em ~8,5–10,4 s (3/3), enquanto sessão válida
// e sessão nova seguem VIVAS aos 40 s. O sinal é o exit code, não o texto.

describe('resumedSessionIdFromArgs', () => {
  it('extrai o id de `-r <id>` (o que o CommandBuilder monta para retomar)', () => {
    expect(resumedSessionIdFromArgs(['-r', 'd93ef8af-820a-4cfe-9adc-b719838ab908'])).toBe('d93ef8af-820a-4cfe-9adc-b719838ab908');
  });

  it('reconhece fork (`-r <id> --fork-session`) — a sessão de ORIGEM é a mesma prova de existência', () => {
    expect(resumedSessionIdFromArgs(['-r', 'abc', '--fork-session'])).toBe('abc');
  });

  it('acha o id mesmo com outras flags antes', () => {
    expect(resumedSessionIdFromArgs(['--model', 'sonnet', '-r', 'abc', '--settings', 'x.json'])).toBe('abc');
  });

  it('sessão NOVA (sem -r) devolve null — nunca é candidata a ser esquecida', () => {
    expect(resumedSessionIdFromArgs(['--session-id', 'novo-uuid'])).toBeNull();
    expect(resumedSessionIdFromArgs([])).toBeNull();
    expect(resumedSessionIdFromArgs(undefined)).toBeNull();
  });

  it('`-r` no fim do argv, sem valor, devolve null (nunca `undefined` virando id)', () => {
    expect(resumedSessionIdFromArgs(['--model', 'sonnet', '-r'])).toBeNull();
  });

  it('ignora `-r` cujo valor é outra flag', () => {
    expect(resumedSessionIdFromArgs(['-r', '--fork-session'])).toBeNull();
  });
});

describe('shouldForgetOnResumeFailure', () => {
  const base = { resumedSessionId: 'abc', exitCode: 1, msSinceSpawn: 8_600 };

  it('retomada que morre com código 1 no tempo medido → dispara', () => {
    expect(shouldForgetOnResumeFailure(base)).toBe(true);
  });

  it('saída limpa (código 0) nunca dispara, por rápida que seja', () => {
    expect(shouldForgetOnResumeFailure({ ...base, exitCode: 0, msSinceSpawn: 300 })).toBe(false);
  });

  it('sessão nova (sem `-r`) nunca dispara, mesmo saindo com erro', () => {
    expect(shouldForgetOnResumeFailure({ ...base, resumedSessionId: null })).toBe(false);
  });

  it('sessão que o usuário USOU e fechou (fora da janela) não dispara', () => {
    expect(shouldForgetOnResumeFailure({ ...base, msSinceSpawn: RESUME_FAILURE_WINDOW_MS + 1 })).toBe(false);
  });

  it('a borda da janela ainda conta', () => {
    expect(shouldForgetOnResumeFailure({ ...base, msSinceSpawn: RESUME_FAILURE_WINDOW_MS })).toBe(true);
  });

  it('a janela é folgada de propósito (a prova real é o disco, no forgetIfOrphan)', () => {
    // 9x o pior tempo medido (10.449 ms) — contenção da suíte de smokes deixa
    // o spawn bem mais lento que a medição isolada.
    expect(RESUME_FAILURE_WINDOW_MS).toBeGreaterThanOrEqual(90_000);
  });

  it('exitCode desconhecido (undefined) não dispara — sem contrato, sem decisão', () => {
    expect(shouldForgetOnResumeFailure({ ...base, exitCode: undefined })).toBe(false);
  });
});

describe('forgetIfOrphan — a PROVA antes de apagar', () => {
  const registry: SessionRegistry = {
    orfa: { sessionId: 'orfa', projectPath: 'C:\\p', label: 'sumiu', lastActivityAt: 1, pinned: true },
    viva: { sessionId: 'viva', projectPath: 'C:\\p', label: 'existe', lastActivityAt: 2, pinned: false },
  };

  it('transcript AUSENTE → remove (é a definição do CA-11), inclusive fixada (C3)', () => {
    const next = forgetIfOrphan(registry, 'orfa', false);
    expect(Object.keys(next)).toEqual(['viva']);
  });

  it('transcript PRESENTE → no-op: a falha foi outra (cota, claude não encontrado, Ctrl+C precoce)', () => {
    expect(forgetIfOrphan(registry, 'viva', true)).toBe(registry);
  });

  it('sessionId que não está no registro é no-op', () => {
    expect(forgetIfOrphan(registry, 'nao-existe', false)).toBe(registry);
  });

  it('não muta o registro recebido', () => {
    const snapshot = JSON.stringify(registry);
    forgetIfOrphan(registry, 'orfa', false);
    expect(JSON.stringify(registry)).toBe(snapshot);
  });
});
