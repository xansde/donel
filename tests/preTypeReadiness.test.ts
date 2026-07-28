import { describe, expect, it } from 'vitest';
import { CLI_READY_MARKER, hasClaudeReadyMarker, hasIdlePromptFooter, isReadyToPreType } from '../src/shared/preTypeReadiness';
import { TRUST_DIALOG_CONFIRM_MARKER, TRUST_DIALOG_EXIT_MARKER } from '../src/shared/trustDialog';

// T312/T319 (003-modo-dev, Batch B) — quando é seguro pré-digitar (CA-3/CA-16).
// Ver o comentário de topo de `src/shared/preTypeReadiness.ts` para o achado
// que obrigou três sinais em vez do único previsto no plan.md — o terceiro
// (T329, Batch D) cobre uma SEGUNDA chamada de `armPhaseCommands` na mesma
// aba, depois que o banner de boot já saiu do viewport de tamanho fixo.

const BANNER = ['✻ Welcome to Claude Code!', '> '];
const TRUST = [...BANNER, TRUST_DIALOG_CONFIRM_MARKER, TRUST_DIALOG_EXIT_MARKER];
// Estado real capturado no smoke `dev-mode-espelho` (T329): sessão já passou
// do boot, um texto já foi pré-digitado e nunca enviado — o banner sumiu, só
// resta a barra de status do rodapé.
const IDLE_FOOTER_NO_BANNER = [
  '───────────────────────────────────────────────────────────────',
  '❯ algum texto pré-digitado, nunca enviado',
  '───────────────────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)              /rc · focus',
];

describe('hasClaudeReadyMarker', () => {
  it('reconhece o banner do REPL sem depender de caixa', () => {
    expect(hasClaudeReadyMarker(BANNER)).toBe(true);
    expect(hasClaudeReadyMarker(['CLAUDE CODE v2'])).toBe(true);
  });

  it('buffer vazio ou só ruído não é prontidão', () => {
    expect(hasClaudeReadyMarker([])).toBe(false);
    expect(hasClaudeReadyMarker(['conectando...'])).toBe(false);
  });

  it('o marcador é o mesmo do smoke permanente do Modo Dev', () => {
    expect(CLI_READY_MARKER).toBe('claude code');
  });
});

describe('hasIdlePromptFooter', () => {
  it('reconhece a barra de status do prompt ocioso, qualquer que seja o modo de permissão', () => {
    expect(hasIdlePromptFooter(['  ⏵⏵ bypass permissions on (shift+tab to cycle)              /rc'])).toBe(true);
    expect(hasIdlePromptFooter(['  ⏵⏵ accept edits on (shift+tab to cycle)                    /rc'])).toBe(true);
  });

  it('buffer vazio ou só ruído não é prontidão', () => {
    expect(hasIdlePromptFooter([])).toBe(false);
    expect(hasIdlePromptFooter(['conectando...'])).toBe(false);
  });

  it('sobrevive à ausência do banner de boot (achado do T329 — 2ª chamada na mesma aba)', () => {
    expect(hasClaudeReadyMarker(IDLE_FOOTER_NO_BANNER)).toBe(false);
    expect(hasIdlePromptFooter(IDLE_FOOTER_NO_BANNER)).toBe(true);
  });
});

describe('isReadyToPreType — primeiro passo', () => {
  it('banner desenhado libera a escrita mesmo sem nenhum evento de semáforo (sessão nova nunca chega a waiting)', () => {
    expect(isReadyToPreType({ isFirstStep: true, semaphore: undefined, armedAt: 0, renderedLines: BANNER })).toBe(true);
  });

  it('semáforo em waiting libera mesmo com o banner já fora do viewport (sessão antiga em foco)', () => {
    expect(
      isReadyToPreType({ isFirstStep: true, semaphore: { state: 'waiting', stateEnteredAt: 10 }, armedAt: 999, renderedLines: [] }),
    ).toBe(true);
  });

  it('sem banner e sem waiting, não escreve nada (CLI ainda subindo)', () => {
    expect(
      isReadyToPreType({ isFirstStep: true, semaphore: { state: 'working', stateEnteredAt: 1 }, armedAt: 0, renderedLines: ['...'] }),
    ).toBe(false);
  });

  it('diálogo de confiança de pasta na tela BLOQUEIA — pré-digitar cairia dentro da pergunta', () => {
    expect(isReadyToPreType({ isFirstStep: true, semaphore: { state: 'waiting', stateEnteredAt: 10 }, armedAt: 0, renderedLines: TRUST })).toBe(
      false,
    );
  });

  it('T329 — barra de status do rodapé libera uma SEGUNDA chamada de armPhaseCommands na mesma aba, sem banner e sem waiting (nenhum turno foi submetido)', () => {
    expect(
      isReadyToPreType({ isFirstStep: true, semaphore: undefined, armedAt: 0, renderedLines: IDLE_FOOTER_NO_BANNER }),
    ).toBe(true);
  });
});

describe('isReadyToPreType — segundo passo do CA-16 (dois Enters distintos)', () => {
  it('waiting ANTIGO (de antes do 1º comando ser escrito) não libera o 2º', () => {
    expect(
      isReadyToPreType({ isFirstStep: false, semaphore: { state: 'waiting', stateEnteredAt: 100 }, armedAt: 200, renderedLines: BANNER }),
    ).toBe(false);
  });

  it('waiting NOVO (turno do /esteira-liberar terminou) libera o 2º', () => {
    expect(
      isReadyToPreType({ isFirstStep: false, semaphore: { state: 'waiting', stateEnteredAt: 300 }, armedAt: 200, renderedLines: BANNER }),
    ).toBe(true);
  });

  it('banner sozinho NUNCA libera o 2º comando — senão os dois sairiam juntos', () => {
    expect(isReadyToPreType({ isFirstStep: false, semaphore: undefined, armedAt: 200, renderedLines: BANNER })).toBe(false);
  });

  it('sessão trabalhando (comando ainda rodando) não libera o 2º', () => {
    expect(
      isReadyToPreType({ isFirstStep: false, semaphore: { state: 'working', stateEnteredAt: 300 }, armedAt: 200, renderedLines: BANNER }),
    ).toBe(false);
  });
});
