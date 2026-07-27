import { useId, type InputHTMLAttributes } from 'react';
import styles from './TextInput.module.css';

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Texto de apoio abaixo do campo — usado para validações, ex. nome duplicado (Brief 12). */
  hint?: string;
  /** `danger` = mensagem de validação bloqueante (tom neutro, nunca a voz do Donel — §8). */
  hintTone?: 'muted' | 'danger';
}

/** Input de texto livre — fundo `bg-raised`, borda `border`, anel `accent` no foco (design-system.md §6). */
export function TextInput({ label, hint, hintTone = 'muted', id, className, ...rest }: TextInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      {label ? (
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      ) : null}
      <input id={inputId} className={styles.input} {...rest} />
      {hint ? (
        <span className={[styles.hint, hintTone === 'danger' ? styles.hintDanger : ''].filter(Boolean).join(' ')}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
