import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
  /** Descrição curta mostrada abaixo do nome quando o dropdown está aberto (Brief 3, campo Permissões). */
  description?: string;
}

export interface SelectProps {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Select customizado (não o `<select>` nativo) porque o campo "Permissões"
 * do Launcher precisa mostrar uma descrição curta por opção quando aberto
 * (Brief 3) — HTML nativo não suporta isso. Fundo `bg-raised`, anel `accent`
 * no foco (design-system.md §6).
 */
export function Select({
  label,
  value,
  options,
  onChange,
  placeholder = 'Selecionar',
  disabled = false,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const selected = options.find((option) => option.value === value);

  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')} ref={rootRef}>
      {label ? <span className={styles.label}>{label}</span> : null}
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
      >
        <span className={selected ? styles.triggerValue : styles.triggerPlaceholder}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open ? (
        <ul id={listId} role="listbox" className={styles.listbox}>
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <li key={option.value} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={[styles.option, isSelected ? styles.optionSelected : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <span className={styles.optionLabel}>{option.label}</span>
                  {option.description ? (
                    <span className={styles.optionDescription}>{option.description}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
