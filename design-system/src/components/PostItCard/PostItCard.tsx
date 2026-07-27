import { Archive, Copy, Send } from 'lucide-react';
import styles from './PostItCard.module.css';

export interface PostItCardProps {
  /** Texto da anotação. */
  text: string;
  /** Data, já formatada (ex. "hoje, 14:32", "ontem"). */
  date: string;
  /** Projeto de origem — campo opcional (Brief 8). */
  project?: string;
  onArchive?: () => void;
  /** "Transformar em prompt" — tooltip/label "enviar para sessão…" (Brief 8). */
  onSendToSession?: () => void;
  onCopy?: () => void;
  className?: string;
}

/**
 * Carta do Tomo do Donel (§10, §6 "Cartas") — cartão `#3A3526` com texto
 * claro, data e projeto em caption. Usado no quadro de post-its (Brief 8) e
 * no Tomo do Donel (Brief 13).
 */
export function PostItCard({ text, date, project, onArchive, onSendToSession, onCopy, className }: PostItCardProps) {
  const hasActions = Boolean(onArchive || onSendToSession || onCopy);

  return (
    <article className={[styles.card, className].filter(Boolean).join(' ')}>
      <p className={styles.text}>{text}</p>
      <div className={styles.meta}>
        <span>{date}</span>
        {project ? <span>{project}</span> : null}
      </div>
      {hasActions ? (
        <div className={styles.actions}>
          {onSendToSession ? (
            <button
              type="button"
              className={styles.action}
              onClick={onSendToSession}
              title="Enviar para sessão…"
            >
              <Send size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className={styles.actionLabel}>Enviar para sessão…</span>
            </button>
          ) : null}
          {onCopy ? (
            <button type="button" className={styles.action} onClick={onCopy} title="Copiar">
              <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className={styles.actionLabel}>Copiar</span>
            </button>
          ) : null}
          {onArchive ? (
            <button type="button" className={styles.action} onClick={onArchive} title="Arquivar">
              <Archive size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className={styles.actionLabel}>Arquivar</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
