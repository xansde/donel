import { useId } from 'react';
import { DEFAULT_MAX_TOKENS, formatSmartZoneLabel, getSmartZone } from '../../lib/smartZone';
import styles from './SmartZoneMeter.module.css';

export interface SmartZoneMeterProps {
  /** Tokens já consumidos pela sessão. */
  usedTokens: number;
  /** Limite da smart zone. Default 400 000 (design-system.md §2). */
  maxTokens?: number;
  /**
   * `default` = versão completa (detalhes de sessão, painel direito).
   * `compact` = mini medidor (statusbar, Brief 6 variante 2).
   */
  variant?: 'default' | 'compact';
  /**
   * Ação "Handoff → nova sessão", oferecida no tooltip só quando a zona é
   * `over` (design-system.md §6). Sem esta prop, a zona `over` ainda é
   * sinalizada visualmente, só não ganha o botão de ação.
   */
  onHandoff?: () => void;
  className?: string;
}

const ZONE_DESCRIPTION_PT: Record<'ok' | 'warn' | 'over', string> = {
  ok: 'dentro da zona',
  warn: 'atenção',
  over: 'handoff sugerido',
};

/**
 * Medidor de contexto consumido (§2 "Smart zone", §6 "Medidor smart zone").
 * Barra horizontal de 4px, rótulo mono "312k/400k", tooltip com detalhe
 * exato e, quando a zona estoura (`over`), ação "Handoff → nova sessão".
 */
export function SmartZoneMeter({
  usedTokens,
  maxTokens = DEFAULT_MAX_TOKENS,
  variant = 'default',
  onHandoff,
  className,
}: SmartZoneMeterProps) {
  const zone = getSmartZone(usedTokens, maxTokens);
  const fillPercent = Math.min((usedTokens / maxTokens) * 100, 100);
  const label = formatSmartZoneLabel(usedTokens, maxTokens);
  const tooltipId = useId();

  return (
    <div
      className={[styles.root, styles[variant], className].filter(Boolean).join(' ')}
      tabIndex={0}
      aria-describedby={tooltipId}
    >
      <div
        className={styles.barTrack}
        role="progressbar"
        aria-valuenow={Math.round(fillPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Smart zone: ${label} tokens usados, ${ZONE_DESCRIPTION_PT[zone]}`}
      >
        <div
          className={[styles.barFill, styles[`fill-${zone}`]].join(' ')}
          style={{ width: `${fillPercent}%` }}
        />
      </div>
      <span className={styles.label}>{label}</span>

      <div id={tooltipId} role="tooltip" className={styles.tooltip}>
        <span>
          {label} · {ZONE_DESCRIPTION_PT[zone]}
        </span>
        {zone === 'over' && onHandoff ? (
          <button type="button" className={styles.handoffButton} onClick={onHandoff}>
            Handoff → nova sessão
          </button>
        ) : null}
      </div>
    </div>
  );
}
