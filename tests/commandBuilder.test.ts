// T006 — CommandBuilder (TDD)
//
// Tests written before the implementation. Cover every row of the FR-003
// table (spec.md), the "flag omitted when control is empty" rule, and the
// `-n` escaping gotcha called out in plan.md point 3: `buildClaudeArgs`
// returns a plain argv array (no shell involved — node-pty/ConPTY spawns the
// process directly), so a value must NEVER be wrapped in literal quote
// characters. The `-n "<nome>"` notation in the FR-003 table and in CA-1 is
// just human-readable shorthand for "the flag followed by the value as one
// argv token" — adding real quote chars would corrupt the session name.
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, parseModelEffortFromArgs, type BuildClaudeArgsOptions } from '../src/shared/commandBuilder';

describe('buildClaudeArgs', () => {
  it('returns an empty argv when no option is provided (all flags omitted, CLI uses user default)', () => {
    expect(buildClaudeArgs()).toEqual([]);
    expect(buildClaudeArgs({})).toEqual([]);
  });

  describe('Modelo — --model <alias>', () => {
    (['fable', 'opus', 'sonnet', 'haiku'] as const).forEach((alias) => {
      it(`maps model=${alias} to --model ${alias}`, () => {
        expect(buildClaudeArgs({ model: alias })).toEqual(['--model', alias]);
      });
    });

    it('omits --model when not provided', () => {
      expect(buildClaudeArgs({ effort: 'high' })).not.toContain('--model');
    });
  });

  describe('Esforço — --effort <low|medium|high|xhigh|max>', () => {
    (['low', 'medium', 'high', 'xhigh', 'max'] as const).forEach((level) => {
      it(`maps effort=${level} to --effort ${level}`, () => {
        expect(buildClaudeArgs({ effort: level })).toEqual(['--effort', level]);
      });
    });

    it('omits --effort when not provided', () => {
      expect(buildClaudeArgs({ model: 'sonnet' })).not.toContain('--effort');
    });
  });

  describe('Permissões — --permission-mode <manual|acceptEdits|auto|plan|dontAsk|bypassPermissions>', () => {
    (
      ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const
    ).forEach((mode) => {
      it(`maps permissionMode=${mode} to --permission-mode ${mode}`, () => {
        expect(buildClaudeArgs({ permissionMode: mode })).toEqual(['--permission-mode', mode]);
      });
    });

    it('omits --permission-mode when not provided', () => {
      expect(buildClaudeArgs({ model: 'sonnet' })).not.toContain('--permission-mode');
    });
  });

  describe('Nome da sessão — -n "<nome>"', () => {
    it('maps sessionName to -n <nome> as two separate argv tokens', () => {
      expect(buildClaudeArgs({ sessionName: 'radar' })).toEqual(['-n', 'radar']);
    });

    it('omits -n when sessionName is empty (ui-spec §4: nome vazio = ok, flag omitida)', () => {
      expect(buildClaudeArgs({ sessionName: '' })).toEqual([]);
    });

    it('omits -n when sessionName is not provided', () => {
      expect(buildClaudeArgs({ model: 'sonnet' })).not.toContain('-n');
    });

    it('gotcha: does NOT wrap a session name with spaces in literal quote characters', () => {
      const args = buildClaudeArgs({ sessionName: 'minha sessão de teste' });
      expect(args).toEqual(['-n', 'minha sessão de teste']);
      // The value must be a single argv token with no embedded quote chars —
      // node-pty/ConPTY does its own low-level quoting from the array; a
      // manually-added quote would show up literally inside the CLI's -n value.
      expect(args[1]).not.toMatch(/["']/);
    });

    it('gotcha: passes special shell characters through untouched (no shell involved, argv array is safe by construction)', () => {
      const dangerous = 'nome; rm -rf / && echo $HOME `whoami`';
      const args = buildClaudeArgs({ sessionName: dangerous });
      expect(args).toEqual(['-n', dangerous]);
    });
  });

  describe('Retomar — -r <session-id>', () => {
    it('maps a resume continuation to -r <session-id>', () => {
      const opts: BuildClaudeArgsOptions = {
        continuation: { type: 'resume', sessionId: 'abc-123' },
      };
      expect(buildClaudeArgs(opts)).toEqual(['-r', 'abc-123']);
    });
  });

  describe('Fork — -r <session-id> --fork-session', () => {
    it('maps a fork continuation to -r <session-id> --fork-session', () => {
      const opts: BuildClaudeArgsOptions = {
        continuation: { type: 'fork', sessionId: 'abc-123' },
      };
      expect(buildClaudeArgs(opts)).toEqual(['-r', 'abc-123', '--fork-session']);
    });
  });

  describe('Continuar última — -c', () => {
    it('maps a continueLast continuation to -c', () => {
      const opts: BuildClaudeArgsOptions = { continuation: { type: 'continueLast' } };
      expect(buildClaudeArgs(opts)).toEqual(['-c']);
    });
  });

  it('omits every continuation flag when continuation is not provided', () => {
    const args = buildClaudeArgs({ model: 'sonnet' });
    expect(args).not.toContain('-r');
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--fork-session');
  });

  describe('cenários combinados (ordem estável, tabela FR-003)', () => {
    it('CA-1 (spec.md): modelo=sonnet, esforço=high, permissões=acceptEdits, nome=radar', () => {
      const args = buildClaudeArgs({
        model: 'sonnet',
        effort: 'high',
        permissionMode: 'acceptEdits',
        sessionName: 'radar',
      });
      expect(args).toEqual([
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--permission-mode',
        'acceptEdits',
        '-n',
        'radar',
      ]);
    });

    it('CA-2 (spec.md): retomar sessão por id → -r <id>', () => {
      const args = buildClaudeArgs({
        continuation: { type: 'resume', sessionId: 'a1b2c3' },
      });
      expect(args).toEqual(['-r', 'a1b2c3']);
    });

    it('combina todas as flags mantendo a ordem da tabela FR-003', () => {
      const args = buildClaudeArgs({
        model: 'opus',
        effort: 'xhigh',
        permissionMode: 'plan',
        sessionName: 'sessao completa',
        continuation: { type: 'fork', sessionId: 'zzz-999' },
      });
      expect(args).toEqual([
        '--model',
        'opus',
        '--effort',
        'xhigh',
        '--permission-mode',
        'plan',
        '-n',
        'sessao completa',
        '-r',
        'zzz-999',
        '--fork-session',
      ]);
    });
  });

  describe('parseModelEffortFromArgs (T011 — inverso de --model/--effort, pra semear o valor inicial da SessionDetails)', () => {
    it('extrai model e effort de um argv com os dois presentes', () => {
      expect(parseModelEffortFromArgs(['--model', 'sonnet', '--effort', 'high'])).toEqual({
        model: 'sonnet',
        effort: 'high',
      });
    });

    it('extrai só o model quando --effort não está no argv', () => {
      expect(parseModelEffortFromArgs(['--model', 'opus'])).toEqual({ model: 'opus' });
    });

    it('extrai só o effort quando --model não está no argv', () => {
      expect(parseModelEffortFromArgs(['--effort', 'xhigh'])).toEqual({ effort: 'xhigh' });
    });

    it('devolve objeto vazio pra argv undefined (aba aberta sem Launcher, ex. clique direto na sidebar)', () => {
      expect(parseModelEffortFromArgs(undefined)).toEqual({});
    });

    it('devolve objeto vazio pra argv vazio', () => {
      expect(parseModelEffortFromArgs([])).toEqual({});
    });

    it('ignora --model/--effort com valor desconhecido (argv corrompido/futuro) em vez de propagar lixo pro tipo', () => {
      expect(parseModelEffortFromArgs(['--model', 'gpt5', '--effort', 'ludicrous'])).toEqual({});
    });

    it('encontra as flags em qualquer posição do argv (ordem real: CA-1 tem --model antes de --effort, mas não é garantido)', () => {
      expect(parseModelEffortFromArgs(['-n', 'radar', '--effort', 'low', '--permission-mode', 'plan', '--model', 'haiku'])).toEqual({
        model: 'haiku',
        effort: 'low',
      });
    });

    it('ignora uma flag --model/--effort no fim do array sem valor seguinte (argv truncado)', () => {
      expect(parseModelEffortFromArgs(['--model'])).toEqual({});
    });
  });

  describe('pureza (sem I/O, sem mutação)', () => {
    it('não muta o objeto de opções recebido', () => {
      const opts: BuildClaudeArgsOptions = Object.freeze({
        model: 'sonnet',
        effort: 'low',
        sessionName: 'imutavel',
      });
      expect(() => buildClaudeArgs(opts)).not.toThrow();
    });

    it('é determinística: mesma entrada produz a mesma saída (novo array a cada chamada)', () => {
      const opts: BuildClaudeArgsOptions = { model: 'haiku', effort: 'medium' };
      const first = buildClaudeArgs(opts);
      const second = buildClaudeArgs(opts);
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    });
  });
});
