import { removeSession, type SessionRegistry } from './sessionRegistry';

// T710 (007-favoritos-sessoes, CA-11 2º momento) / 008-fechar-pendencias
// T805–T806 — "esquecer a entrada órfã quando a retomada falha".
//
// Por que este módulo existe separado: a decisão é lógica pura e precisa de TDD
// sem subir o Electron — o renderer só liga os fios (mesmo motivo de
// `session-seed.ts`/`sessionRegistry.ts` existirem fora de `main/index.ts`).
//
// O SINAL, medido contra o binário real (`specs/008-fechar-pendencias/
// medicao-t710.md`, CLI 2.1.220): dentro de um PTY, `claude -r <uuid
// inexistente>` imprime `No conversation found with session ID: <id>` e SAI COM
// exitCode 1, em 8.611/10.449/8.517 ms (3/3, sem flake); no mesmo PTY, `-r
// <uuid válido>` e sessão nova (`--session-id`) seguem VIVOS aos 40 s. Ou seja:
// exit code != 0 pouco depois do spawn separa a retomada inválida do
// funcionamento normal.
//
// O que este módulo deliberadamente NÃO faz: parsear o texto do CLI. Texto de
// CLI muda sem aviso — exit code é contrato. (Fora do PTY o exit code NÃO
// serviria: sem TTY o CLI cai no modo `--print` e até a sessão válida sai com 1
// — por isso a medição foi feita com node-pty, igual ao app.)

/**
 * Janela em que um `onExit` com código != 0 ainda é lido como "a retomada nunca
 * subiu", e não como "o usuário usou a sessão e fechou".
 *
 * Folgada de propósito (≈9× o pior tempo medido): a suíte de smokes roda várias
 * instâncias de Electron concorrentes e o spawn fica bem mais lento que na
 * medição isolada. Quem decide de verdade é o disco (`forgetIfOrphan`) — esta
 * janela só evita gastar a checagem no encerramento normal de uma sessão longa.
 */
export const RESUME_FAILURE_WINDOW_MS = 90_000;

/**
 * Id da sessão que o argv pede para RETOMAR (`-r <id>`), ou `null` quando a aba
 * nasceu como sessão nova. Cobre também o fork (`-r <id> --fork-session`): se o
 * fork falha, a sessão de ORIGEM é a que não existe mais — a mesma prova.
 *
 * Duplicidade proposital com `resolveClaudeCorrelation` (src/main/
 * session-correlation.ts): aquele roda no main, no momento do spawn, para
 * correlação de hooks; este roda no renderer, no momento do exit. O renderer
 * não importa de `src/main`.
 */
export function resumedSessionIdFromArgs(args: readonly string[] | undefined): string | null {
  if (!args) return null;
  const index = args.indexOf('-r');
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('-')) return null;
  return value;
}

export interface ResumeFailureSignal {
  /** Id pedido no `-r` desta aba (`resumedSessionIdFromArgs`), ou `null` para sessão nova. */
  readonly resumedSessionId: string | null;
  /** `PtyExitInfo.exitCode` — `undefined` quando o PTY não reportou código. */
  readonly exitCode: number | undefined;
  /** Quanto tempo passou entre o spawn do PTY e o `onExit`. */
  readonly msSinceSpawn: number;
}

/**
 * `true` quando vale CHECAR o disco para esquecer a entrada — nunca é a decisão
 * final de apagar (essa é `forgetIfOrphan`). Falso para saída limpa, para aba
 * que nasceu como sessão nova, para exit code desconhecido e para sessão que
 * viveu além da janela.
 */
export function shouldForgetOnResumeFailure(signal: ResumeFailureSignal): boolean {
  if (!signal.resumedSessionId) return false;
  if (signal.exitCode === undefined || signal.exitCode === 0) return false;
  return signal.msSinceSpawn <= RESUME_FAILURE_WINDOW_MS;
}

/**
 * A PROVA antes de apagar: remove a entrada só quando o `.jsonl` daquela sessão
 * **não existe** — que é a definição literal do CA-11 ("entrada do registro
 * cujo `.jsonl` não existe mais é removida sem aviso, inclusive se estiver
 * fixada"). É o que impede o falso positivo: cota estourada, `claude` não
 * encontrado, diálogo de workspace recusado ou Ctrl+C precoce também saem com
 * código != 0, e em todos esses o transcript EXISTE.
 *
 * Puro (o `existsSync` fica no main, que é quem conhece o caminho real).
 */
export function forgetIfOrphan(registry: SessionRegistry, sessionId: string, transcriptExists: boolean): SessionRegistry {
  if (transcriptExists) return registry;
  return removeSession(registry, sessionId);
}
