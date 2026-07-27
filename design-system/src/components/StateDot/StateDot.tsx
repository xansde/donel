import type { CSSProperties } from 'react';
import styles from './StateDot.module.css';

/** Estados do semáforo de sessão (design-system.md §2 e §6). */
export type SessionState = 'working' | 'waiting' | 'permission' | 'done' | 'error';

/** Rótulo pt-BR de cada estado — usado como texto visível (`label`) por
 * padrão pelos componentes que compõem uma sessão (TerminalTab, listas) e
 * como `aria-label` de fallback do próprio dot. */
export const SESSION_STATE_LABEL_PT: Record<SessionState, string> = {
  working: 'Trabalhando',
  waiting: 'Aguardando resposta',
  permission: 'Permissão pendente',
  done: 'Encerrada',
  error: 'Falha ou quota esgotada',
};

export interface StateDotProps {
  /** Estado do semáforo de sessão. */
  state: SessionState;
  /**
   * Rótulo textual mostrado ao lado do dot quando há espaço. Acessibilidade
   * (design-system.md §9): o estado nunca é comunicado só por cor — mesmo
   * sem `label` visível, o dot expõe o nome do estado via `aria-label`.
   */
  label?: string;
  /**
   * Anel fino em torno do dot quando a sessão passa de 70% de uso da smart
   * zone (§6, P1). Independente do halo próprio do estado `permission`.
   */
  ring?: 'warn' | 'over';
  /** Diâmetro do dot em px. Default 8 (spec). */
  size?: number;
  className?: string;
}

/**
 * Círculo de 8px preenchido na cor do estado da sessão — o vocabulário
 * visual central do Donel Dev (design-system.md §1, §2, §6).
 *
 * Animações: `working` pulsa opacidade 100→40% em ciclo de 2s; `permission`
 * pulsa em ciclo de 1s e ganha um halo constante ao redor. Ambas respeitam
 * `prefers-reduced-motion` (§9, §7 — "nada pisca sem motivo").
 */
export function StateDot({ state, label, ring, size = 8, className }: StateDotProps) {
  const dotStyle: CSSProperties & Record<'--ring-color', string | undefined> = {
    width: size,
    height: size,
    '--ring-color': ring ? `var(--zone-${ring})` : undefined,
  };

  return (
    <span className={[styles.wrapper, className].filter(Boolean).join(' ')}>
      <span
        className={[styles.dot, styles[state], ring ? styles.ringed : ''].filter(Boolean).join(' ')}
        style={dotStyle}
        role={label ? undefined : 'img'}
        aria-label={label ? undefined : SESSION_STATE_LABEL_PT[state]}
        aria-hidden={label ? true : undefined}
      />
      {label ? <span className={styles.label}>{label}</span> : null}
    </span>
  );
}
