import { isTrustDialogVisible } from './trustDialog';

// FIX (auditoria rodada 6, achado media) — extraída de App.tsx (efeito que
// alimenta `possiblyBlockedOnPrompt`, ver comentário lá) pra virar testável
// em isolamento (mesmo espírito de `trustDialog.ts`, achado da auditoria
// rodada 5): antes dessa extração, a ÚNICA cobertura da decisão era o smoke
// `empty-state.spec.ts` (Playwright, caro) — e nenhum smoke do repo sequer
// asserta o texto do hint que essa decisão liga (`session-details-hint`),
// então nem o disparo nem o não-disparo tinham prova automatizada real.

export interface PossiblyBlockedOnPromptInputs {
  /** Processo da aba em foco está vivo (T010 `aliveTabs`). */
  alive: boolean;
  /** Nenhum evento de hook chegou ainda pra essa aba (`semaphoreStates[id] === undefined`). */
  semaphorePending: boolean;
  /** Epoch ms de quando a aba ficou viva pela última vez; `undefined` = nunca registrado. */
  aliveSince: number | undefined;
  /** Epoch ms "agora" (injetado pra determinismo em teste — produção passa `Date.now()`). */
  now: number;
  /** Limiar de tempo mínimo vivo-sem-evento antes de considerar "possivelmente bloqueado" (App.tsx `POSSIBLY_BLOCKED_THRESHOLD_MS`). */
  thresholdMs: number;
  /**
   * Leitura LAZY do buffer renderizado da aba (`TerminalPane.getRenderedLines`)
   * — só é chamada quando as checagens baratas acima já passaram, pra não
   * pagar o custo de ler o buffer do xterm em toda aba/tick à toa.
   */
  getRenderedLines: () => readonly string[];
}

/**
 * `true` só quando a aba em foco está viva, nenhum evento de hook chegou
 * ainda, isso já dura mais que `thresholdMs` E o diálogo de confiança de
 * pasta está DE FATO visível no buffer renderizado (`isTrustDialogVisible`)
 * — nunca só por "nenhum hook ainda" (caso normal de uma sessão ociosa antes
 * do primeiro prompt, ver `default` do switch em `SessionDetails.tsx`).
 */
export function computePossiblyBlockedOnPrompt(inputs: PossiblyBlockedOnPromptInputs): boolean {
  const { alive, semaphorePending, aliveSince, now, thresholdMs, getRenderedLines } = inputs;
  if (!alive || !semaphorePending) return false;
  if (aliveSince === undefined || now - aliveSince <= thresholdMs) return false;
  return isTrustDialogVisible(getRenderedLines());
}
