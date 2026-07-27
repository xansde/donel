import styles from './SegmentedControl.module.css';

export interface SegmentedControlOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  options: SegmentedControlOption[];
  value: string;
  onChange: (value: string) => void;
  /** Nome acessível do grupo, ex. "Modelo", "Esforço" (Brief 3). */
  ariaLabel: string;
  className?: string;
  /**
   * T011 (FR-011, sessão viva) — desabilita o grupo inteiro (ex.: sessão
   * trabalhando/permissão pendente, o app só injeta comando com o prompt
   * ocioso). Default `false` — nenhum consumidor existente (Launcher) passa
   * essa prop, então o comportamento deles não muda.
   */
  disabled?: boolean;
}

/**
 * Segmented control — usado para Modelo, Esforço, Tipo (Brief 3, 12).
 * Opção ativa = `bg-raised` + `text-primary` (design-system.md §6).
 */
export function SegmentedControl({ options, value, onChange, ariaLabel, className, disabled = false }: SegmentedControlProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={[styles.root, disabled ? styles.disabled : '', className].filter(Boolean).join(' ')}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={[styles.segment, active ? styles.active : ''].filter(Boolean).join(' ')}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
