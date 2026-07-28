import type { SemaphoreState } from './index';
import { isTrustDialogVisible } from './trustDialog';

// T312/T319 (003-modo-dev, Batch B) — QUANDO é seguro pré-digitar (CA-3/CA-16).
// Decisão pura, sem I/O: quem lê o buffer do xterm e o semáforo é o App.tsx.
//
// ACHADO DA IMPLEMENTAÇÃO (medido no código, 27/07) — o `plan.md` previa um
// único sinal: "espera o semáforo entrar em 'waiting' pela primeira vez depois
// do `create`". Ele NÃO existe para uma sessão recém-criada: o semáforo só
// muda de estado por evento de hook, e `hooks-settings.ts`
// (`SEMAPHORE_HOOK_EVENTS`) não registra `SessionStart` — o único evento que
// leva a `'waiting'` é o `Stop`, que fecha um TURNO. Uma sessão nova nasce em
// `'working'` (`SessionSemaphoreManager.registerSession` emite o estado
// inicial) e só chega a `'waiting'` depois do PRIMEIRO turno. Esperar por ele
// deixaria o gesto central do CA-3 sem nunca disparar. O mesmo já está
// documentado em `App.tsx` ("hooks-settings.ts não cobre SessionStart").
//
// Correção adotada, sem delay fixo (que o plano descartou com razão): TRÊS
// sinais, todos orientados a evento e já usados neste repo —
//  1. semáforo em `'waiting'` (o sinal do plano; é o que vale para o SEGUNDO
//     passo do CA-16, onde de fato existe um turno terminando);
//  2. o REPL do CLI já desenhado no buffer JÁ RENDERIZADO do xterm — mesma
//     fonte (e mesmo motivo) de `hasLiveInjectionConfirmation`/
//     `isTrustDialogVisible`. O marcador é o banner do CLI, o mesmo que o
//     smoke permanente `tests/smoke-dev/dev-mode.spec.ts` usa como pré-
//     condição antes de digitar e obter eco: ele espera uma linha com
//     "claude code" e só então digita;
//  3. a barra de status do rodapé do prompt interativo (achado do T329,
//     003-modo-dev Batch D — ver `hasIdlePromptFooter` abaixo). O sinal 2 só
//     cobre a sessão RECÉM-criada: o banner de boas-vindas é uma tela ÚNICA
//     que desaparece do viewport de tamanho fixo do xterm (achado já
//     documentado em `liveSessionInjection.ts`) assim que QUALQUER texto é
//     digitado ou o CLI redesenha por outro motivo (ex.: aviso de MCP sem
//     autenticação, comum numa sessão RAIZ com boot pesado — commit
//     e75fd59). Uma SEGUNDA chamada independente de `armPhaseCommands` na
//     MESMA aba (ex.: "Liberar trava…" depois de uma conciliação já
//     pré-digitada e nunca enviada, CA-16/D1) também nasce com
//     `isFirstStep: true` (é o primeiro passo da SUA própria sequência), mas
//     roda contra uma sessão que já passou do boot — sem banner, e sem
//     `'waiting'` porque nenhum turno real jamais foi submetido. Faltava um
//     sinal que sobrevivesse a esse redraw: a barra de status do rodapé.
//
// E um sinal NEGATIVO em qualquer caso: com o diálogo de confiança de pasta
// na tela, o CLI ainda não armou o leitor de stdin — pré-digitar ali cairia
// DENTRO da pergunta. Nunca escrever nesse estado.

/** Banner do REPL do CLI — ver comentário de topo (mesma pré-condição do smoke permanente do Modo Dev). */
export const CLI_READY_MARKER = 'claude code';

export interface PreTypeReadinessInput {
  /** Primeiro passo da sequência (CA-16 pode ter dois). */
  readonly isFirstStep: boolean;
  readonly semaphore: { readonly state: SemaphoreState; readonly stateEnteredAt: number } | undefined;
  /** Epoch ms em que o passo ANTERIOR foi escrito no PTY (0 no primeiro passo). */
  readonly armedAt: number;
  /** Cauda do buffer já renderizado do xterm (`TerminalPaneHandle.getRenderedLines`). */
  readonly renderedLines: readonly string[];
}

/** `true` quando o REPL já desenhou o banner do CLI — sinal de "subiu e aceita input". */
export function hasClaudeReadyMarker(lines: readonly string[]): boolean {
  return lines.some((line) => line.toLowerCase().includes(CLI_READY_MARKER));
}

/**
 * Barra de status do rodapé do prompt interativo — "⏵⏵ <modo> on (shift+tab
 * to cycle)" ("accept edits"/"bypass permissions"/etc., o modo varia, o
 * parêntese não). Achado em `liveSessionInjection.ts` (comentário (3)): esse
 * CLI redesenha um viewport de TAMANHO FIXO, e essa barra "se repete em
 * quase todo frame" enquanto o prompt está OCIOSO aceitando input — um turno
 * em andamento troca essa barra por um indicador de progresso ("esc to
 * interrupt"), nunca os dois juntos. Ao contrário do banner de boas-vindas
 * (`CLI_READY_MARKER`, tela ÚNICA que só existe antes do primeiro redraw),
 * esta barra sobrevive a qualquer redraw seguinte — inclusive depois que um
 * texto já foi pré-digitado nessa mesma sessão sem nunca ter sido enviado.
 */
const IDLE_PROMPT_FOOTER_PATTERN = /shift\+tab to cycle/i;

/** `true` quando a barra de status do rodapé do prompt ocioso está no viewport atual — ver comentário acima. */
export function hasIdlePromptFooter(lines: readonly string[]): boolean {
  return lines.some((line) => IDLE_PROMPT_FOOTER_PATTERN.test(line));
}

/**
 * CA-3/CA-16 — decide se o próximo comando da sequência pode ser ESCRITO
 * (nunca enviado) agora.
 *
 * - Diálogo de confiança visível: **nunca** (o stdin ainda não é o prompt).
 * - Primeiro passo: semáforo em `'waiting'` **ou** banner do CLI presente
 *   **ou** barra de status do prompt ocioso presente (essa última cobre a
 *   sessão que já passou do boot — ver comentário de topo do arquivo).
 * - Passos seguintes (CA-16): só um `'waiting'` NOVO — entrado depois do
 *   passo anterior ter sido escrito — libera o próximo. É isso que garante
 *   "dois Enters humanos distintos, nunca um só para os dois comandos".
 */
export function isReadyToPreType(input: PreTypeReadinessInput): boolean {
  if (isTrustDialogVisible(input.renderedLines)) return false;

  const waiting = input.semaphore?.state === 'waiting';

  if (!input.isFirstStep) {
    return waiting && (input.semaphore?.stateEnteredAt ?? 0) > input.armedAt;
  }

  return waiting || hasClaudeReadyMarker(input.renderedLines) || hasIdlePromptFooter(input.renderedLines);
}
