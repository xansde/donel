import { Button, SegmentedControl } from '@donel-dev/design-system';
import type { SegmentedControlOption } from '@donel-dev/design-system';
import type { SemaphoreState } from '../../shared';
import type { EffortLevel, ModelAlias } from '../../shared/commandBuilder';
import { computeContextPercent, formatContextTooltip, isOverSmartZone } from '../../shared/contextWindow';
import { canInjectLiveCommand } from '../../shared/liveSessionInjection';
import styles from './SessionDetails.module.css';

// T011 — Controle de Modelo/Esforço em sessão viva (FR-011). Vive na
// TOOLBAR da aba ativa (acima do terminal), não no painel direito: o painel
// direito (Launcher, ui-spec §4) já é exercitado por vários smokes
// existentes (T008 CA-1, T009 semáforo, T010 6-sessões) assumindo que ele
// SEMPRE mostra `[data-testid="launcher"]` — inclusive quando a aba ativa é
// uma sessão claude (a aba "Sessão" default, claude, já é a ativa no boot).
// A leitura literal do ui-spec §2 ("Launcher quando nada selecionado;
// detalhes da sessão quando houver") trocaria o Launcher pra este painel
// sempre que uma aba claude estivesse em foco — o que quebraria esses
// smokes já mergeados (não dá pra abrir uma 2ª/3ª sessão pelo Launcher com
// uma sessão claude focada). A própria task T011 permite a alternativa "na
// aba/toolbar" — usada aqui pra não regredir o trilho já validado.
//
// Só renderiza pra abas 'claude' (App.tsx decide isso) — terminal livre
// (FR-008) não tem modelo/esforço.

const MODEL_OPTIONS: SegmentedControlOption[] = [
  { value: 'fable', label: 'fable' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
];

const EFFORT_OPTIONS: SegmentedControlOption[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'med' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

export interface SessionDetailsProps {
  model: ModelAlias;
  effort: EffortLevel;
  /** Estado do semáforo da aba ativa (T009) — só `'waiting'` libera a injeção (FR-011: "só injeta quando o prompt está ocioso"). */
  semaphoreState: SemaphoreState | undefined;
  /** Processo vivo (T010 `aliveTabs`) — sem isso não há stdin pra injetar; é o caso que dispara a degradação FR-011. */
  alive: boolean;
  onSelectModel: (model: ModelAlias) => void;
  onSelectEffort: (effort: EffortLevel) => void;
  /** Degradação FR-011 ("reiniciar a sessão com a flag") — só relevante/visível quando `alive` é `false`. */
  onRestartWithConfig: () => void;
  /**
   * T013 (correção herdada) — 'model'/'effort' quando App.tsx já escreveu a
   * injeção no stdin mas AINDA não viu a confirmação real do CLI no ring
   * buffer (App.tsx `watchLiveInjection`); `undefined` = nenhuma injeção em
   * voo. Desabilita os dois controles enquanto pendente (nunca empilha uma
   * 2ª injeção sobre uma ainda não confirmada) e troca o hint — ver
   * shared/liveSessionInjection.ts pro porquê da correção.
   */
  pendingKind?: 'model' | 'effort';
  /**
   * FIX (feedback E2E rodada 5, condição corrigida na decisão A de
   * 2026-07-23) — `true` quando a aba está viva, nenhum evento de hook
   * chegou ainda depois de ~20s (App.tsx calcula a partir de
   * `aliveSinceRef`/`semaphoreStates`) E o diálogo de confiança de pasta
   * está DE FATO visível no buffer renderizado (`shared/trustDialog.ts`) —
   * troca o hint neutro de "sessão ociosa" (ver `default` do switch abaixo)
   * por um diagnóstico acionável. Default `false` (sem essa defesa, os
   * testes/consumidores existentes que não passam a prop continuam vendo o
   * comportamento de antes).
   */
  possiblyBlockedOnPrompt?: boolean;
  /**
   * T611 (006) — tokens de contexto do último turn desta sessão
   * (`App.tsx` → `contextTokens[sessionId]`, vindo do watcher de transcript).
   *
   * Recebe TOKENS, não o `%` já calculado: o denominador depende do `model`, que
   * é prop deste mesmo componente — calcular aqui é o que faz o CA-6 (trocar o
   * modelo recalcula o `%`) sair sem nenhum estado novo. `null`/ausente =
   * nenhuma leitura ainda, aba `shell`, ou transcript ilegível → `—` (CA-4).
   * Opcional para não quebrar os smokes/consumidores que já montam o componente.
   */
  contextTokens?: number | null;
}

/** Texto do aviso ao lado dos segmented — explica POR QUE o controle está desabilitado (ui-spec §4: "tooltip explica"), ou a dica de uso quando está liberado. */
function statusHint(
  state: SemaphoreState | undefined,
  alive: boolean,
  pendingKind: 'model' | 'effort' | undefined,
  possiblyBlockedOnPrompt: boolean
): string {
  if (pendingKind) return 'Aguardando o CLI confirmar a troca…';
  if (!alive) return 'Sessão sem processo vivo — troque e clique em "Reiniciar com essa config".';
  // FIX (decisão A, 2026-07-23) — App.tsx só liga `possiblyBlockedOnPrompt`
  // quando a sessão está viva há mais de ~20s sem NENHUM evento de hook
  // (nem um) E o diálogo de confiança de pasta está de fato visível no
  // buffer renderizado — nunca mais só por "nenhum hook ainda" (isso sozinho
  // é o caso NORMAL de uma sessão ociosa antes do primeiro prompt, ver
  // `default` do switch abaixo).
  if (possiblyBlockedOnPrompt) {
    return 'O CLI pode estar aguardando resposta no terminal (ex.: confiança de pasta) — clique no terminal e responda.';
  }
  switch (state) {
    case 'working':
      return 'Sessão trabalhando — aguarde o turno terminar pra trocar.';
    case 'permission':
      return 'Permissão pendente — resolva o prompt antes de trocar.';
    case 'waiting':
      return 'Aplica na sessão em andamento, sem perder o histórico.';
    default:
      // FIX (decisão A, 2026-07-23) — chegar aqui já provou `alive === true`
      // (o `!alive` acima retornou antes) e `!possiblyBlockedOnPrompt`
      // (nenhum diálogo bloqueando) — `state === undefined` neste ponto é o
      // caso NORMAL de uma sessão viva que ainda não teve nenhum turno
      // (hooks-settings.ts não cobre `SessionStart`), não "ainda
      // conectando" (isso já aconteceu — o PTY está de pé). O texto antigo
      // ("Conectando…") ficava preso nesse rótulo pra sempre numa aba
      // ociosa normal — nunca era substituído por nada, porque não havia
      // nenhum evento futuro que tirasse a aba desse estado antes do
      // primeiro prompt do usuário.
      //
      // FIX (auditoria rodada 6, achado baixa) — o contrato deste hint
      // (comentário de `statusHint` acima) é "explica POR QUE o controle
      // está desabilitado" (`canInjectLiveCommand` exige `state ===
      // 'waiting'`, que ainda não existe neste branch). O texto anterior
      // ("Sessão pronta — digite no terminal para começar.") não respondia
      // à pergunta original do Alexandre ("não consigo selecionar
      // modelo/esforço") — nomeia explicitamente a causa agora.
      return 'Sessão pronta — digite no terminal; modelo/esforço liberam após o primeiro turno.';
  }
}

export function SessionDetails({
  model,
  effort,
  semaphoreState,
  alive,
  onSelectModel,
  onSelectEffort,
  onRestartWithConfig,
  pendingKind,
  possiblyBlockedOnPrompt = false,
  contextTokens = null,
}: SessionDetailsProps): React.JSX.Element {
  const disabled = pendingKind !== undefined || !canInjectLiveCommand(semaphoreState, alive);
  const hint = statusHint(semaphoreState, alive, pendingKind, possiblyBlockedOnPrompt);
  // T611–T613 (006) — as três derivações vêm do módulo puro `contextWindow`
  // (testado sozinho): nada de aritmética de tokens dentro do componente.
  const contextPercent = computeContextPercent(contextTokens, model);
  const overZone = isOverSmartZone(contextPercent);

  return (
    <div className={styles.toolbar} data-testid="session-details" aria-label="Modelo e esforço da sessão">
      <span className={styles.label}>Modelo</span>
      <SegmentedControl options={MODEL_OPTIONS} value={model} onChange={(value) => onSelectModel(value as ModelAlias)} ariaLabel="Modelo (sessão viva)" disabled={disabled} />

      <span className={styles.label}>Esforço</span>
      <SegmentedControl
        options={EFFORT_OPTIONS}
        value={effort}
        onChange={(value) => onSelectEffort(value as EffortLevel)}
        ariaLabel="Esforço (sessão viva)"
        disabled={disabled}
      />

      <span className={styles.hint} data-testid="session-details-hint">
        {hint}
      </span>

      {/* T611 (006) — CA-1/CA-5: `%` da smart zone consumido, na toolbar POR
          ABA (contexto é por-sessão; o titlebar é global/por-perfil). O rótulo
          literal "contexto" é obrigatório: o app já mostra um `%` de COTA
          (rate-limit) e um número solto repetiria o "não entendi o que esse
          número significa" da rodada 6. Sem barra, sem ícone, sem gradiente por
          faixa — só o número e, acima de 100%, a cor (CA-9). */}
      <span
        className={overZone ? `${styles.context} ${styles.contextOverZone}` : styles.context}
        data-testid="session-context"
        // Atributo (e não a classe do CSS module) é o que o teste assevera —
        // classe hasheada pelo bundler não é contrato.
        data-over-zone={overZone ? 'true' : undefined}
        title={formatContextTooltip(contextTokens, model)}
      >
        contexto {contextPercent === null ? '—' : `${contextPercent}%`}
      </span>

      {!alive ? (
        <Button variant="secondary" onClick={onRestartWithConfig}>
          Reiniciar com essa config
        </Button>
      ) : null}
    </div>
  );
}
