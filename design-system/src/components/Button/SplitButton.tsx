import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './SplitButton.module.css';
import type { ButtonVariant } from './Button';

export interface SplitButtonMenuItem {
  label: string;
  onSelect: () => void;
}

export interface SplitButtonProps {
  /** Rótulo do corpo do botão, ex. "＋ Nova sessão" (Brief 1). */
  label: string;
  /** Ação do corpo do botão — inicia direto com a última configuração usada. */
  onClick: () => void;
  /** Itens do menu aberto pela seta lateral, ex. "Sessão Claude" / "Terminal". */
  items: SplitButtonMenuItem[];
  variant?: Extract<ButtonVariant, 'primary' | 'secondary'>;
  disabled?: boolean;
  className?: string;
}

/**
 * Botão split: clique no corpo dispara a última configuração usada; a seta
 * lateral abre um menu com as opções completas (design-system.md §6, Brief 1
 * — "＋ Nova sessão": corpo = última config, seta = abrir launcher/terminal).
 */
export function SplitButton({
  label,
  onClick,
  items,
  variant = 'primary',
  disabled = false,
  className,
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);

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
        caretRef.current?.focus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')} ref={rootRef}>
      <button
        type="button"
        className={[styles.main, styles[variant]].join(' ')}
        onClick={onClick}
        disabled={disabled}
      >
        {label}
      </button>
      <button
        type="button"
        ref={caretRef}
        className={[styles.caret, styles[variant]].join(' ')}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Mais opções de ${label}`}
      >
        <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open ? (
        <ul className={styles.menu} role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  item.onSelect();
                  setOpen(false);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
