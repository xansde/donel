import { Check, ChevronDown } from 'lucide-react';
import styles from './AccountBadge.module.css';

export type HeadroomTier = 'high' | 'mid' | 'low' | 'none';

/** Verde >40% · dourado 15–40% · vermelho <15% · cinza sem leitura (design-system.md §2). */
export function getHeadroomTier(percent: number | null): HeadroomTier {
  if (percent === null) return 'none';
  if (percent > 40) return 'high';
  if (percent >= 15) return 'mid';
  return 'low';
}

export interface AccountBadgeProps {
  /** Número da conta — "Tecnologia Claude {n}" (1 a 15). */
  accountNumber: number;
  /** % de headroom da quota. `null` quando não há leitura disponível. */
  headroomPercent: number | null;
  /**
   * Conta ainda sem login feito (Brief 5, Parte B) — substitui o percentual
   * por "login pendente". O login sempre acontece dentro do terminal; o app
   * nunca manuseia credenciais.
   */
  loginPending?: boolean;
  /**
   * Leitura de headroom em andamento (dropdown acabou de abrir, ainda sem
   * resposta de `profiles:headroom` pra este slug) — substitui o percentual
   * por "carregando…", tier `none` (cinza). Precedência: `loginPending` >
   * `loading` > percent/—. Batch A (002-quota-headroom).
   */
  loading?: boolean;
  /** Marca esta conta como a ativa no momento (check no dropdown, Brief 5A). */
  active?: boolean;
  /** Mostra a seta de dropdown — uso no badge do titlebar (Brief 1). */
  expandable?: boolean;
  onClick?: () => void;
  className?: string;
}

/** Pílula "Tecnologia Claude {n}" + % de headroom colorido (design-system.md §6). */
export function AccountBadge({
  accountNumber,
  headroomPercent,
  loginPending = false,
  loading = false,
  active = false,
  expandable = false,
  onClick,
  className,
}: AccountBadgeProps) {
  const tier = getHeadroomTier(headroomPercent);
  const interactive = Boolean(onClick);
  const Tag = interactive ? 'button' : 'span';

  return (
    <Tag
      type={interactive ? 'button' : undefined}
      className={[styles.badge, interactive ? styles.interactive : '', className]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
    >
      <span className={styles.name}>Tecnologia Claude {accountNumber}</span>
      <span className={styles.separator} aria-hidden="true">
        ·
      </span>
      {loginPending ? (
        <span className={[styles.headroom, styles['tier-none']].join(' ')}>login pendente</span>
      ) : loading ? (
        <span className={[styles.headroom, styles['tier-none']].join(' ')}>carregando…</span>
      ) : (
        <span className={[styles.headroom, styles[`tier-${tier}`]].join(' ')}>
          {headroomPercent === null ? '—' : `${headroomPercent}%`}
        </span>
      )}
      {active ? <Check size={14} strokeWidth={1.5} className={styles.icon} aria-hidden="true" /> : null}
      {expandable ? <ChevronDown size={14} strokeWidth={1.5} className={styles.icon} aria-hidden="true" /> : null}
    </Tag>
  );
}
