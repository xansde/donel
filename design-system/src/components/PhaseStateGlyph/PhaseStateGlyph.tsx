import styles from './PhaseStateGlyph.module.css';

/**
 * Os 5 estados de fase da Esteira (spec 003-modo-dev, CA-15) — eixo
 * diferente do semáforo de sessão (`StateDot`, 4 estados). Fase é do
 * trabalho, sessão é do processo do CLI; os dois coexistem lado a lado no
 * mesmo nó do mapa (CA-25).
 */
export type PhaseState = 'not-started' | 'running' | 'done' | 'failed' | 'stuck';

export const PHASE_STATE_LABEL_PT: Record<PhaseState, string> = {
  'not-started': 'Não iniciada',
  running: 'Em execução',
  done: 'Concluída',
  failed: 'Falhou',
  stuck: 'Travada',
};

const PHASE_STATE_CHAR: Record<PhaseState, string> = {
  'not-started': '○',
  running: '▶',
  done: '✓',
  failed: '✕',
  stuck: '⊘',
};

export interface PhaseStateGlyphProps {
  /** Um dos 5 estados de fase do CA-15 — nenhum outro valor compila. */
  status: PhaseState;
  /**
   * Rótulo visível ao lado do glifo. Sem `label`, o estado ainda é exposto
   * via `aria-label` — nunca só cor (design-system.md §9).
   */
  label?: string;
  className?: string;
}

/**
 * Glifo de 16px para os 5 estados de fase (CA-15) — dupla codificação
 * (caractere + cor), nunca só cor. `failed`/`stuck` usam preenchimento
 * sólido porque a falha tem de ser "a coisa mais clara da tela" (requisito
 * literal); os outros 3 estados usam contorno. Dono do token `--state-error`
 * (roxo) nesta peça — antes reservado, sem uso.
 */
export function PhaseStateGlyph({ status, label, className }: PhaseStateGlyphProps) {
  return (
    <span className={[styles.wrapper, className].filter(Boolean).join(' ')}>
      <span
        className={[styles.glyph, styles[status]].join(' ')}
        role={label ? undefined : 'img'}
        aria-label={label ? undefined : PHASE_STATE_LABEL_PT[status]}
        aria-hidden={label ? true : undefined}
      >
        {PHASE_STATE_CHAR[status]}
      </span>
      {label ? <span className={styles.label}>{label}</span> : null}
    </span>
  );
}
