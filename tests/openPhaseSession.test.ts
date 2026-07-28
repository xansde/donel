import { describe, expect, it } from 'vitest';
import type { ArchivedPhaseSession } from '../src/shared/devMode';
import { DEFAULT_PHASE_DEFAULTS } from '../src/shared/devModeDefaults';
import {
  LIBERAR_COMMAND_TEMPLATE,
  buildConciliationPrompt,
  createPrimeSequencer,
  decidePhaseOpen,
  resolveCommandSequence,
} from '../src/renderer/src/DevMode/openPhaseSession';

// T312/T313/T318/T319 (003-modo-dev, Batch B) — NÚCLEO PURO do gesto central
// (CA-3/CA-4/CA-9/CA-16 + invariante 2). Nada aqui toca Electron, PTY ou
// React: decide `create` vs. "usar aba em foco" vs. `resume` vs. "abre
// artefato", e a SEQUÊNCIA de comandos a pré-digitar por estado de fase.
//
// O teste mais importante da feature está aqui e no smoke: NENHUM texto
// produzido por este módulo contém `\r`/`\n` — o Enter é sempre gesto humano.

const ARCHIVED: ArchivedPhaseSession = { sessionId: 'sess-1', profileSlug: 'principal', archivedAt: 1 };

const BASE = {
  repoPath: 'C:/repo',
  worktreePath: null,
  artifactPath: 'C:/repo/.esteira/plano/handoffs/CARD-1/plano-result.json',
  archivedSession: null,
} as const;

describe('decidePhaseOpen', () => {
  it('fase normal (opensOwnSession: true) decide create, com cwd no repo e argv da tabela CA-4', () => {
    const decision = decidePhaseOpen({
      ...BASE,
      phase: 'plano',
      defaults: DEFAULT_PHASE_DEFAULTS.plano,
      status: 'not-started',
    });

    expect(decision).toEqual({ kind: 'create', cwd: 'C:/repo', args: ['--model', 'opus', '--effort', 'high'] });
  });

  it('create usa a worktree da fase quando o ctx.md declarou uma (D3)', () => {
    const decision = decidePhaseOpen({
      ...BASE,
      worktreePath: 'C:/worktrees/card-1',
      phase: 'implementar',
      defaults: DEFAULT_PHASE_DEFAULTS.implementar,
      status: 'not-started',
    });

    expect(decision).toEqual({
      kind: 'create',
      cwd: 'C:/worktrees/card-1',
      args: ['--model', 'opus', '--effort', 'high'],
    });
  });

  it('fase concluir (opensOwnSession: false) decide "usar aba em foco" — nunca cria PTY (C6)', () => {
    const decision = decidePhaseOpen({
      ...BASE,
      phase: 'concluir',
      defaults: DEFAULT_PHASE_DEFAULTS.concluir,
      status: 'not-started',
    });

    expect(decision).toEqual({ kind: 'use-focused' });
  });

  it('concluir continua "usar aba em foco" mesmo com a fase já concluída (a exceção do C6 não depende do estado)', () => {
    const decision = decidePhaseOpen({
      ...BASE,
      phase: 'concluir',
      defaults: DEFAULT_PHASE_DEFAULTS.concluir,
      status: 'done',
      archivedSession: ARCHIVED,
    });

    expect(decision).toEqual({ kind: 'use-focused' });
  });

  it('fase concluída com session-id arquivado decide resume (CA-9), só com -r', () => {
    const decision = decidePhaseOpen({
      ...BASE,
      phase: 'plano',
      defaults: DEFAULT_PHASE_DEFAULTS.plano,
      status: 'done',
      archivedSession: ARCHIVED,
    });

    expect(decision).toEqual({ kind: 'resume', sessionId: 'sess-1', cwd: 'C:/repo', args: ['-r', 'sess-1'] });
  });

  it('fase concluída SEM session-id arquivado (discovery antigo, C4) abre o artefato — degradação, não erro', () => {
    const decision = decidePhaseOpen({
      ...BASE,
      phase: 'plano',
      defaults: DEFAULT_PHASE_DEFAULTS.plano,
      status: 'done',
      archivedSession: null,
    });

    expect(decision).toEqual({ kind: 'open-artifact', path: BASE.artifactPath });
  });

  it('fase falhou decide create (retomada pela mesma skill, CA-16), nunca resume', () => {
    const decision = decidePhaseOpen({
      ...BASE,
      phase: 'validar',
      defaults: DEFAULT_PHASE_DEFAULTS.validar,
      status: 'failed',
      archivedSession: ARCHIVED,
    });

    expect(decision).toEqual({ kind: 'create', cwd: 'C:/repo', args: ['--model', 'sonnet', '--effort', 'high'] });
  });
});

describe('resolveCommandSequence (CA-16)', () => {
  it('fase travada devolve DOIS passos: liberar primeiro, comando da fase depois', () => {
    const sequence = resolveCommandSequence({
      status: 'stuck',
      defaults: DEFAULT_PHASE_DEFAULTS.implementar,
      cardId: 'CARD-1',
    });

    expect(sequence).toEqual(['/esteira-liberar CARD-1', '/esteira-implementar CARD-1 ultracode']);
  });

  it('fase falhou devolve UM passo: a mesma skill da fase', () => {
    const sequence = resolveCommandSequence({
      status: 'failed',
      defaults: DEFAULT_PHASE_DEFAULTS.validar,
      cardId: 'CARD-2',
    });

    expect(sequence).toEqual(['/esteira-validar CARD-2']);
  });

  it('fase concluída não pré-digita nada — retomar é consulta (CA-9)', () => {
    const sequence = resolveCommandSequence({
      status: 'done',
      defaults: DEFAULT_PHASE_DEFAULTS.plano,
      cardId: 'CARD-3',
    });

    expect(sequence).toEqual([]);
  });

  it('o template de liberar é o da skill real, com o placeholder do card', () => {
    expect(LIBERAR_COMMAND_TEMPLATE).toBe('/esteira-liberar {card_id}');
  });

  it('NENHUM comando de NENHUM estado carrega \\r ou \\n (invariante 2, CA-3)', () => {
    const statuses = ['not-started', 'running', 'done', 'failed', 'stuck'] as const;
    for (const status of statuses) {
      for (const phase of ['discovery', 'plano', 'implementar', 'validar', 'concluir'] as const) {
        const sequence = resolveCommandSequence({ status, defaults: DEFAULT_PHASE_DEFAULTS[phase], cardId: 'CARD-9' });
        for (const command of sequence) {
          expect(command).not.toMatch(/[\r\n]/);
          expect(command).not.toContain('{card_id}');
        }
      }
    }
  });
});

describe('createPrimeSequencer (CA-16 — cada comando com seu próprio Enter)', () => {
  it('libera um comando por vez: o segundo só sai na chamada seguinte', () => {
    const sequencer = createPrimeSequencer(['/esteira-liberar CARD-1', '/esteira-implementar CARD-1 ultracode']);

    expect(sequencer.done).toBe(false);
    expect(sequencer.next()).toBe('/esteira-liberar CARD-1');
    expect(sequencer.done).toBe(false);
    expect(sequencer.next()).toBe('/esteira-implementar CARD-1 ultracode');
    expect(sequencer.done).toBe(true);
    expect(sequencer.next()).toBeNull();
  });

  it('sequência vazia nasce concluída (nada a pré-digitar)', () => {
    const sequencer = createPrimeSequencer([]);
    expect(sequencer.done).toBe(true);
    expect(sequencer.next()).toBeNull();
  });

  it('nunca concatena os dois comandos num só texto', () => {
    const sequencer = createPrimeSequencer(['a', 'b']);
    const first = sequencer.next();
    expect(first).toBe('a');
    expect(first).not.toContain('b');
  });
});

// ---------------------------------------------------------------------------
// T328 (003-modo-dev, Batch D) — prompt da sessão de CONCILIAÇÃO (CA-13).
//
// Duas regras que o mockup violava e a spec manda (mockup × spec: vence a
// spec): (a) não existe skill `/esteira-conciliar` — inventar uma seria o
// mesmo erro do `--subset` já barrado no D2, e a invariante 3 proíbe criar
// código novo na Esteira; então o prompt é TEXTO, descrevendo os dois fatos.
// (b) o app nunca corrige o board — o prompt diz isso explicitamente.
// ---------------------------------------------------------------------------

describe('buildConciliationPrompt', () => {
  const INPUT = {
    cardId: 'SZI-901',
    marcoId: 'M1',
    phase: 'implementar' as const,
    diskStatus: 'done' as const,
    boardColumn: 'plano',
  };

  it('cita os DOIS fatos divergentes (disco e board) e o card/marco/fase', () => {
    const prompt = buildConciliationPrompt(INPUT);

    expect(prompt).toContain('SZI-901');
    expect(prompt).toContain('M1');
    expect(prompt).toContain('implementar');
    expect(prompt).toContain('done'); // fato do DISCO
    expect(prompt).toContain('plano'); // fato do BOARD
  });

  it('invariante 2 — nenhum `\r`/`\n` no texto: o Enter é gesto humano', () => {
    const prompt = buildConciliationPrompt(INPUT);
    expect(prompt).not.toContain('\r');
    expect(prompt).not.toContain('\n');
  });

  it('não inventa skill da Esteira (nada de `/esteira-conciliar`) — invariante 3', () => {
    expect(buildConciliationPrompt(INPUT)).not.toContain('/esteira-');
  });

  it('diz explicitamente que o board não deve ser alterado (CA-13/invariante 5)', () => {
    expect(buildConciliationPrompt(INPUT).toLowerCase()).toContain('não altere o board');
  });
});
