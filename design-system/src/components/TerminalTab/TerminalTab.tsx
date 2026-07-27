import { Terminal, X } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { EditableLabel, type EditableLabelHandle } from '../EditableLabel';
import { SESSION_STATE_LABEL_PT, StateDot, type SessionState } from '../StateDot';
import styles from './TerminalTab.module.css';

export interface TerminalTabProps {
  /** Nome da sessão, em mono. */
  name: string;
  /** Modelo abreviado, ex. "sonnet", "fable". */
  model?: string;
  /**
   * Estado do semáforo. Omitido = "terminal comum" (sem sessão Claude) — a
   * aba troca o dot por um ícone de shell (design-system.md §6, Brief 1).
   */
  state?: SessionState;
  active?: boolean;
  onClick?: () => void;
  onClose?: () => void;
  /**
   * T407/T408 (004-nomear-sessoes) — renomear pela própria aba (CA-3):
   * duplo-clique no nome, ou F2 com a aba em foco. Omitido = aba não
   * renomeável (o gesto nem existe).
   */
  onRename?: (next: string) => void;
  /** Limite de caracteres do nome (decisão C5: 60). */
  nameMaxLength?: number;
  className?: string;
}

/**
 * Aba de terminal do shell principal: dot de estado + nome (mono) + modelo
 * abreviado; ativa = `bg-raised` com borda superior `accent` (§6, Brief 1).
 */
export function TerminalTab({
  name,
  model,
  state,
  active = false,
  onClick,
  onClose,
  onRename,
  nameMaxLength,
  className,
}: TerminalTabProps) {
  const stateLabel = state ? SESSION_STATE_LABEL_PT[state] : 'Terminal comum';
  const tooltip = model ? `${stateLabel} · ${model}` : stateLabel;
  const labelRef = useRef<EditableLabelHandle>(null);

  // F2 na aba EM FOCO abre a edição (decisão C5). Fica no botão do corpo
  // porque é ele quem recebe foco na navegação por teclado.
  function handleBodyKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!onRename || event.key !== 'F2') return;
    event.preventDefault();
    event.stopPropagation();
    labelRef.current?.startEditing();
  }

  return (
    <div
      className={[styles.tab, active ? styles.active : '', className].filter(Boolean).join(' ')}
      role="tab"
      aria-selected={active}
      // Nome inteiro no tooltip: com o limite de 60 chars a aba trunca por CSS,
      // e o texto completo passa a existir só aqui.
      title={`${name} — ${tooltip}`}
    >
      <button type="button" className={styles.body} onClick={onClick} onKeyDown={handleBodyKeyDown}>
        {state ? (
          <StateDot state={state} />
        ) : (
          <Terminal size={16} strokeWidth={1.5} className={styles.shellIcon} aria-hidden="true" />
        )}
        {onRename ? (
          <EditableLabel
            ref={labelRef}
            className={styles.name}
            value={name}
            onCommit={onRename}
            maxLength={nameMaxLength}
            inputAriaLabel={`Renomear sessão ${name}`}
          />
        ) : (
          <span className={styles.name}>{name}</span>
        )}
        {model ? <span className={styles.model}>{model}</span> : null}
      </button>
      {onClose ? (
        <button type="button" className={styles.close} onClick={onClose} aria-label={`Fechar aba ${name}`}>
          <X size={12} strokeWidth={1.5} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
