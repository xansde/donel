import { SmartZoneMeter } from '../SmartZoneMeter';
import styles from './StatusBar.module.css';

export interface StatusBarSmartZone {
  usedTokens: number;
  maxTokens?: number;
}

export interface StatusBarProps {
  /** Ex. "Tecnologia Claude 3 · 62%" (Brief 1). */
  accountLabel: string;
  /** Ex. "fable/high" — modelo/esforço da aba em foco. */
  modelEffort?: string;
  sessionCount: number;
  /** Mini smart zone da aba em foco (§6, P1). Omitido = não renderiza o medidor. */
  smartZone?: StatusBarSmartZone;
  className?: string;
  /**
   * FIX (auditoria rodada 5, achado baixa "testid hardcoded na lib") —
   * `data-testid` do span da conta é decisão de QUEM CONSOME o
   * design-system (o app, que sabe o que seus próprios smokes procuram),
   * não da lib compartilhada — antes `"statusbar-account"` vinha fixo aqui
   * dentro, um precedente de app-em-lib (era o único `data-testid` de todo
   * o pacote). Opcional: sem isto, o span não ganha `data-testid` nenhum.
   */
  accountTestId?: string;
}

/**
 * Rodapé do shell: conta ativa · modelo/esforço da aba em foco · nº de
 * sessões · mini smart zone (design-system.md §4, §6). Altura 28px.
 */
export function StatusBar({ accountLabel, modelEffort, sessionCount, smartZone, className, accountTestId }: StatusBarProps) {
  const sessionLabel = sessionCount === 1 ? '1 sessão' : `${sessionCount} sessões`;

  return (
    <div className={[styles.bar, className].filter(Boolean).join(' ')}>
      <span data-testid={accountTestId}>{accountLabel}</span>
      {modelEffort ? (
        <>
          <span className={styles.separator} aria-hidden="true">
            ·
          </span>
          <span className={styles.mono}>{modelEffort}</span>
        </>
      ) : null}
      <span className={styles.separator} aria-hidden="true">
        ·
      </span>
      <span>{sessionLabel}</span>
      {smartZone ? (
        <>
          <span className={styles.separator} aria-hidden="true">
            ·
          </span>
          <SmartZoneMeter
            variant="compact"
            usedTokens={smartZone.usedTokens}
            maxTokens={smartZone.maxTokens}
          />
        </>
      ) : null}
    </div>
  );
}
