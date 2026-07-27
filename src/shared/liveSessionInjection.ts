// T011 — Injeção de modelo/esforço em sessão viva (FR-011, plan.md ponto 7)
//
// Funções puras (sem I/O) que decidem SE e O QUE escrever no stdin de uma
// sessão claude já rodando pra trocar modelo/esforço sem reiniciar. Mesmo
// espírito do CommandBuilder (T006): quem de fato escreve no PTY é
// TerminalPane.injectCommand (via window.donel.pty.input), chamado pelo
// App.tsx/SessionDetails só depois de checar `canInjectLiveCommand`.
//
// Achado da implementação (verificado nas strings do binário instalado,
// `claude --version` = 2.1.218, `~/.local/share/claude/versions/2.1.218`):
// TANTO `/model <name>` QUANTO `/effort <level>` existem como slash commands
// interativos reais — não só `/model` (evidência: "Usage: /model <name>.
// Available: ..." e "Set model to X (session-scoped, not persisted)" pro
// primeiro; "Usage: /effort <low|medium|high|xhigh|...|auto>" e "Set effort
// level to X" pro segundo). Por isso a "degradação" prevista no FR-011
// ("se não houver comando nativo... a UI oferece reiniciar com a flag") NÃO
// se aplica por falta de comando — ela entra só quando não há PROCESSO VIVO
// pra receber stdin (sessão 'done'/'error'/ainda conectando): aí sim a UI
// (App.tsx `handleRestartWithConfig`) fecha a aba e abre uma sessão nova com
// `--model`/`--effort` via CommandBuilder, aceitando perder o contexto (o
// próprio texto do FR-011 já prevê isso pro caminho degradado — a DoD de
// "sem perder contexto" vale pro caminho principal de injeção, não pra
// degradação).

import type { SemaphoreState } from './index';
import type { EffortLevel, ModelAlias } from './commandBuilder';

/**
 * FR-011: "o app só injeta quando o prompt está ocioso (nunca no meio de
 * digitação do usuário)". `'waiting'` é o único estado do semáforo
 * (semaphore-state-machine.ts) que corresponde a "turno concluído, prompt
 * ocioso" — `'working'` tem o CLI processando, `'permission'` tem um prompt
 * de confirmação bloqueando o stdin (escrever `/model` ali cairia dentro da
 * pergunta y/n, não no prompt de comando), `'error'`/`'done'`/`undefined`
 * não têm processo vivo. `alive` (T010 `aliveTabs`, sinal independente via
 * `onAliveChange`) é uma segunda checagem pro mesmo caso "sem processo" —
 * defesa em profundidade contra a corrida rara em que o semáforo ainda não
 * refletiu o `processExit` no instante do clique.
 */
export function canInjectLiveCommand(state: SemaphoreState | undefined, alive: boolean): boolean {
  return alive && state === 'waiting';
}

/**
 * `/model <alias>\r` — o `\r` (Enter) precisa ir junto: o texto é aplicado
 * no PTY pelo mesmo canal (`pty:input`) que o teclado real usa (TerminalPane
 * `term.onData`), então sem o Enter o comando só fica digitado, nunca
 * submetido.
 */
export function buildModelInjection(model: ModelAlias): string {
  return `/model ${model}\r`;
}

/** `/effort <level>\r` — idem `buildModelInjection` acima. */
export function buildEffortInjection(effort: EffortLevel): string {
  return `/effort ${effort}\r`;
}

// T013 (correção herdada, auditoria batch 3) — App.tsx `handleSelectModel`/
// `handleSelectEffort` atualizavam `sessionModelEffort` (o valor mostrado na
// toolbar) assim que `injectCommand` devolvia `true`. Mas `injectCommand` só
// garante que o texto foi ESCRITO no stdin do PTY — não que o CLI aplicou a
// troca. O smoke da T011 (tests/smoke/model-injection.spec.ts) provou que,
// com histórico de conversa já em cache, `/model`/`/effort` abrem um diálogo
// interativo de confirmação ("Switch model? ... ❯ 1. Yes") ANTES de aplicar;
// se o usuário responder que não (ou nunca responder), a toolbar mentia
// mostrando o valor novo mesmo sem a troca ter acontecido.
//
// Correção: App.tsx passa a tratar a injeção como PENDENTE até ver a
// confirmação de VERDADE — só então grava o valor novo em
// `sessionModelEffort`. As duas funções abaixo são a parte PURA dessa
// decisão (sem I/O, mesmo espírito do resto deste arquivo); a leitura do
// terminal em si (I/O) fica em App.tsx/TerminalPane.tsx.
//
// Três tentativas anteriores falharam rodando contra o CLI REAL (não
// fixture — só apareceu no smoke real do T011, `tests/smoke/
// model-injection.spec.ts`):
// (1) Snapshot de LINHAS do ring buffer do main process
//     (`window.donel.pty.getPreview`, pty-manager.ts + ring-buffer.ts): esse
//     buffer só fecha uma linha em `\n`/`\r\n` real e trata um `\r` isolado
//     como "redraw, descarta sem fechar linha nenhuma" — exatamente o
//     padrão que a UI interativa do CLI (tipo Ink) usa pra desenhar o
//     diálogo "Switch model?", então a confirmação nunca virava uma linha
//     "completa" nesse buffer.
// (2) Acumular o BYTE STREAM bruto (ANSI stripado) conforme ele passa pelo
//     `pty:data`: parecia resolver o problema (1) mas ainda falhou —
//     achado real: um redraw incremental pode compor o texto final
//     combinando um write NOVO com conteúdo que já estava na GRADE do
//     terminal (célula por célula, via cursor positioning), então "Set
//     model to Sonnet 5" nunca aparece como substring contígua no stream
//     bruto — só existe depois de aplicado o parser/emulação de terminal.
// (3) Buffer JÁ RENDERIZADO do xterm (`term.buffer.active`, `getRenderedLines`
//     em TerminalPane.tsx) LIDO POR EVENTO (`onRenderedUpdate`, no callback
//     de conclusão do `term.write` — nunca `setInterval`) resolveu (1) e (2):
//     o texto de confirmação passou a aparecer, de verdade, no snapshot
//     `current`. Mas a comparação "só linhas NOVAS desde um `baseline`"
//     (achar a última linha de `baseline` em `current` e olhar só o que vem
//     depois) ainda falhou — achado real: este CLI redesenha um VIEWPORT DE
//     TAMANHO FIXO (a `buffer.length` fica travada no nº de linhas do
//     terminal, ~32, durante um turno inteiro — não é um log que cresce por
//     append) e a ÚLTIMA linha do viewport é uma barra de status que SE
//     REPETE em quase todo frame (ex.: "⏵⏵ accept edits on..."). Como
//     `baseline` e `current` costumam terminar com essa MESMA barra, achar
//     "a última ocorrência da última linha do baseline" em `current` batia
//     bem perto do FIM de `current` — e a linha de confirmação, que aparece
//     ACIMA da barra de status dentro do MESMO frame, ficava excluída do
//     recorte "só o que é novo". Não existe, pra este CLI, uma noção válida
//     de "linhas novas desde o baseline" (não é um log sequencial).
//
// A forma que FUNCIONA (validada pelo smoke real): abandonar o diffing
// contra um `baseline` e checar o snapshot ATUAL inteiro, a cada evento de
// `onRenderedUpdate` — sem baseline, o risco vira só "confirmar uma troca
// ANTIGA que ainda esteja visível no viewport", mas isso é raro na prática
// (o watcher só começa a ouvir DEPOIS da injeção, e o CLI redesenha o
// viewport constantemente durante um turno) e, mesmo se acontecer, o
// resultado ainda seria uma confirmação REAL de ALGUMA troca — nunca um
// valor que nunca foi de fato aplicado (o requisito central desta correção:
// nunca mentir mostrando algo que não aconteceu).

/**
 * Texto real de confirmação do CLI depois de `/model`/`/effort` (verificado
 * nas strings do binário 2.1.218 e no smoke da T011 — "Set model to Sonnet
 * 5", nome de EXIBIÇÃO, não o alias digitado). Padrão genérico de propósito:
 * o alias ("sonnet") nunca aparece 1:1 no texto de confirmação pros 4
 * aliases (mapeamento alias->nome de exibição não documentado pro CLI), e
 * mapear errado seria pior que não mapear.
 */
export const MODEL_CONFIRMATION_PATTERN = /Set model to/i;
export const EFFORT_CONFIRMATION_PATTERN = /Set effort level to/i;

/** Decisão pura: a confirmação de `kind` está presente no snapshot ATUAL do terminal (`current`)? */
export function hasLiveInjectionConfirmation(current: readonly string[], kind: 'model' | 'effort'): boolean {
  const pattern = kind === 'model' ? MODEL_CONFIRMATION_PATTERN : EFFORT_CONFIRMATION_PATTERN;
  return current.some((line) => pattern.test(line));
}
