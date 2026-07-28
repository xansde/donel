import type { ReactNode } from 'react';
import styles from './AnnotationTag.module.css';

/**
 * Tons semânticos da etiqueta (CA-12, CA-25). `lock` (trava) e `error`
 * (falha/divergência) são deliberadamente tons distintos — não podem se
 * confundir num espelho que existe para avisar exatamente essas duas coisas.
 */
export type AnnotationTone = 'muted' | 'ok' | 'warn' | 'error' | 'lock' | 'accent';

export interface AnnotationTagProps {
  /** Um dos 6 tons do enum — nenhuma string livre compila. */
  tone: AnnotationTone;
  children: ReactNode;
  className?: string;
}

/**
 * Etiqueta curta com tom semântico — veste as anotações que o espelho do
 * board sobrepõe à árvore (CA-12: coluna real, trava ativa, etiquetas de
 * atenção `esteira:escalado`/`esteira:precisa-atencao`, PR+aprovação) e o
 * conteúdo do slot de aviso de trava da Zona 2. Só tokens já existentes em
 * `tokens.css` — nenhum hex novo.
 */
export function AnnotationTag({ tone, children, className }: AnnotationTagProps) {
  return <span className={[styles.tag, styles[tone], className].filter(Boolean).join(' ')}>{children}</span>;
}
