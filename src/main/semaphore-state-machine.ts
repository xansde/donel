// T009 — Semáforo de sessões (FR-010): máquina de estados PURA (sem I/O),
// mapeando os eventos validados no spike (specs/001-mvp/spike-t002-resultado.md
// "Decisão de arquitetura para T009") para os 4 estados vindos dos hooks:
// trabalhando / aguardando resposta / permissão pendente / encerrada.
//
// "Falha/quota esgotada" (5º estado do FR-010/ui-spec) NÃO nasce aqui — é
// derivado fora deste módulo, a partir do exit code do processo PTY
// (PtyManager.onExit), pela camada de integração (session-semaphore-manager.ts).
// Este módulo só conhece o que os hooks contam.
//
// Addendum T009 (specs/001-mvp/spike-t002-resultado.md, seção "Addendum T009
// — Notification em TTY real") confirmou que `Notification` DISPARA de
// verdade dentro de um PTY real (node-pty/ConPTY) com `notification_type:
// "permission_prompt"` — por isso `onNotification` é o sinal PRIMÁRIO de
// `permission` aqui. `applyPermissionHeuristic` continua existindo como
// fallback defensivo (o próprio spike recomenda registrar `Notification`
// "por segurança — custo zero se nunca disparar", e a heurística cobre o
// caso hipotético de uma versão do CLI ou um hook drop em que ela não
// dispare).

export type SemaphoreState = 'working' | 'waiting' | 'permission' | 'done';

export interface SemaphoreMachineState {
  readonly state: SemaphoreState;
  /**
   * Epoch ms do `PreToolUse` mais recente ainda sem `PostToolUse`/`Stop`
   * correspondente — input da heurística de fallback (spike:
   * `markPending`/`clearPending`). `null` = nada pendente.
   */
  readonly pendingToolSince: number | null;
  /**
   * Epoch ms de quando o `state` atual começou a valer — usado pro contador
   * "há Xmin" (ui-spec §3) e pro desempate de FR-010/CA-6 ("entre 2+ sessões
   * com permissão pendente simultaneamente, a mais antiga aparece primeiro").
   * Só é atualizado quando `state` MUDA de valor, não a cada evento.
   */
  readonly stateEnteredAt: number;
}

export const INITIAL_SEMAPHORE_STATE: SemaphoreMachineState = {
  state: 'working',
  pendingToolSince: null,
  stateEnteredAt: 0,
};

export type SemaphoreEvent =
  | { readonly type: 'userPromptSubmit'; readonly at: number }
  | { readonly type: 'preToolUse'; readonly at: number }
  | { readonly type: 'postToolUse'; readonly at: number }
  | { readonly type: 'stop'; readonly at: number }
  | { readonly type: 'notification'; readonly at: number }
  | { readonly type: 'sessionEnd'; readonly at: number }
  /** Evento do SO via `PtyManager.onExit` — nunca vem de um hook. Tem
   * PRIORIDADE sobre `sessionEnd` (spike: kill forçado não dispara
   * `SessionEnd`, então este é o único sinal confiável pra "encerrada" em
   * qualquer cenário). */
  | { readonly type: 'processExit'; readonly at: number };

function transition(state: SemaphoreState, at: number, current: SemaphoreMachineState): SemaphoreMachineState {
  if (state === current.state) return current;
  return { state, pendingToolSince: null, stateEnteredAt: at };
}

/** Reducer puro: `(estado atual, evento) => novo estado`. Terminal em `done` — nenhum evento tira uma sessão encerrada desse estado (uma sessão "reaberta" nasce como uma máquina nova). */
export function reduceSemaphoreState(current: SemaphoreMachineState, event: SemaphoreEvent): SemaphoreMachineState {
  if (current.state === 'done') return current;

  switch (event.type) {
    case 'processExit':
    case 'sessionEnd':
      return transition('done', event.at, current);

    case 'userPromptSubmit':
      return transition('working', event.at, current);

    case 'preToolUse': {
      const base = transition('working', event.at, current);
      // Refresca a marca de "chamada de ferramenta pendente" a cada
      // PreToolUse (spike: `markPending` roda em toda chamada), mesmo quando
      // o estado em si já era 'working' e `transition` não mudou nada.
      return { ...base, state: 'working', pendingToolSince: event.at };
    }

    case 'postToolUse':
      // `clearPending` do spike — a ferramenta respondeu, não há mais nada
      // pendente pra heurística observar (fica em 'working' até o próximo
      // `Stop`).
      return current.pendingToolSince === null ? current : { ...current, pendingToolSince: null };

    case 'stop':
      // Turno concluído — sempre volta pra 'waiting', mesmo vindo de
      // 'permission' (ex.: o usuário respondeu a aprovação e o turno fechou).
      return transition('waiting', event.at, current);

    case 'notification':
      // Sinal primário e confiável (addendum T009) de permissão pendente.
      return transition('permission', event.at, current);

    default:
      return current;
  }
}

/**
 * Fallback heurístico (spike §"Fallback heurístico para permissão pendente"):
 * só promove pra `permission` quando os DOIS sinais concordam — `PreToolUse`
 * pendente há mais que `timeoutMs` E o ring buffer da sessão bate com um
 * padrão conhecido de prompt de permissão. Não-op fora do estado `working`
 * ou sem chamada pendente (evita reagir a uma ferramenta genuinamente lenta,
 * ex. download/build, quando o outro sinal não a confirma como bloqueio de
 * permissão).
 */
export function applyPermissionHeuristic(
  current: SemaphoreMachineState,
  now: number,
  timeoutMs: number,
  recentLines: readonly string[],
  matchesPermissionPrompt: (recentLines: readonly string[]) => boolean = defaultMatchesPermissionPrompt
): SemaphoreMachineState {
  if (current.state !== 'working' || current.pendingToolSince === null) return current;
  if (now - current.pendingToolSince <= timeoutMs) return current;
  if (!matchesPermissionPrompt(recentLines)) return current;
  return { state: 'permission', pendingToolSince: null, stateEnteredAt: now };
}

/**
 * Padrões observados no addendum T009 (real PTY, texto em inglês do prompt
 * interativo: "Bash requires confirmation for this command. ... Do you want
 * to proceed? ❯ 1. Yes 2. No") + variações pt-BR caso o CLI localize, mais o
 * texto de auto-negação do modo headless documentado no spike original
 * ("Preciso de sua permissão..."). Últimas ~10 linhas ANSI-stripadas é a
 * janela recomendada pelo spike — quem monta `recentLines` é o chamador
 * (via `PtyManager.getPreview`).
 */
const PERMISSION_PROMPT_PATTERNS: readonly RegExp[] = [
  /do you want to proceed/i,
  /requires confirmation/i,
  /permission to use/i,
  /precis[oa] de (sua )?permiss[ãa]o/i,
  /\b1\.\s*yes\b/i,
];

export function defaultMatchesPermissionPrompt(recentLines: readonly string[]): boolean {
  const joined = recentLines.join('\n');
  return PERMISSION_PROMPT_PATTERNS.some((pattern) => pattern.test(joined));
}
