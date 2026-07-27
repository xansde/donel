import { useId } from 'react';
import styles from './Toggle.module.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Texto de apoio, ex. "cria todo.md no vault" (Brief 12, campo "Tem todo?"). */
  description?: string;
  disabled?: boolean;
  className?: string;
}

/** Toggle simples — fundo `bg-raised`, anel `accent` no foco (design-system.md §6). */
export function Toggle({ checked, onChange, label, description, disabled = false, className }: ToggleProps) {
  const id = useId();

  return (
    <label
      htmlFor={id}
      className={[styles.row, disabled ? styles.disabled : '', className].filter(Boolean).join(' ')}
    >
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </span>
      <span className={styles.switch}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className={styles.input}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className={styles.track} aria-hidden="true">
          <span className={styles.thumb} />
        </span>
      </span>
    </label>
  );
}
