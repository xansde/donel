import type { CSSProperties } from 'react';
import styles from './PhaseChip.module.css';

/** As 5 fases fixas da Esteira (design-system.md §6, Brief 10 do handoff). */
export type EsteiraPhase = 'discovery' | 'plano' | 'implementar' | 'validar' | 'concluir';

export const ESTEIRA_PHASE_LABEL_PT: Record<EsteiraPhase, string> = {
  discovery: 'Discovery',
  plano: 'Plano',
  implementar: 'Implementar',
  validar: 'Validar',
  concluir: 'Concluir',
};

export interface PhaseChipProps {
  phase: EsteiraPhase;
  className?: string;
}

/**
 * Chip de fase da Esteira, usado no modo Dev (Brief 10): retângulo pequeno
 * de 11px com o nome da fase, cor fixa e dessaturada por fase. A paleta das
 * 5 fases é interpretação — o design-system.md não fixa os hex (§6). Ver
 * tokens.css para o racional das cores escolhidas.
 */
export function PhaseChip({ phase, className }: PhaseChipProps) {
  const style: CSSProperties & Record<'--phase-color', string> = {
    '--phase-color': `var(--phase-${phase})`,
  };

  return (
    <span className={[styles.chip, className].filter(Boolean).join(' ')} style={style}>
      {ESTEIRA_PHASE_LABEL_PT[phase]}
    </span>
  );
}
