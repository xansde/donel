import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import styles from './EditableLabel.module.css';

/** Handle imperativo — quem hospeda o label (a aba, a linha da sidebar) dispara a edição por F2 a partir do PRÓPRIO elemento focado. */
export interface EditableLabelHandle {
  startEditing(): void;
}

export interface EditableLabelProps {
  /** Texto exibido — já resolvido por quem chama (nome custom ou fallback). */
  value: string;
  /** Chamado com o texto novo ao confirmar (Enter/blur). NÃO é chamado quando o texto não mudou, nem no Esc. String vazia = "apaga o nome" (a decisão de o que fazer com ela é de quem chama). */
  onCommit(next: string): void;
  /** Limite de caracteres do input. Espelha a regra de dado de quem chama (60 para nomes de sessão, decisão C5). */
  maxLength?: number;
  /** `false` desliga o gesto e renderiza só o texto (ex.: linha que não representa uma sessão renomeável). */
  editable?: boolean;
  /** Rótulo acessível do input em modo edição. */
  inputAriaLabel?: string;
  className?: string;
}

/**
 * T407 (004-nomear-sessoes) — label que vira input inline no lugar, com o
 * MESMO gesto na aba de topo e na linha da sidebar (duplo-clique **ou** F2;
 * Enter e blur confirmam, Esc cancela). Escrever o gesto duas vezes era
 * garantir dois comportamentos ligeiramente diferentes nos dois lugares.
 *
 * **Cuidado de interação (lição do `ProfileSwitcher`, entrega 002):** o label
 * vive DENTRO de superfícies clicáveis — clicar na aba a ativa, clicar no `×`
 * fecha. Por isso todo evento do gesto de edição (duplo-clique, teclas, clique
 * no input) chama `stopPropagation`: nenhum deles pode borbulhar para o
 * handler de ativar/fechar.
 */
export const EditableLabel = forwardRef<EditableLabelHandle, EditableLabelProps>(function EditableLabel(
  { value, onCommit, maxLength = 60, editable = true, inputAriaLabel, className },
  ref,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Esc dispara blur logo depois; sem esta marca o blur confirmaria o que o
  // usuário acabou de cancelar.
  const cancelledRef = useRef(false);

  useImperativeHandle(ref, () => ({
    startEditing: () => {
      if (!editable) return;
      beginEditing();
    },
  }));

  function beginEditing(): void {
    cancelledRef.current = false;
    setDraft(value);
    setEditing(true);
  }

  function finishEditing(commit: boolean): void {
    setEditing(false);
    if (!commit) return;
    if (draft === value) return; // nada mudou — não gasta escrita nem sobrescreve fallback com fallback
    onCommit(draft);
  }

  function handleDoubleClick(event: MouseEvent<HTMLSpanElement>): void {
    if (!editable) return;
    event.preventDefault();
    event.stopPropagation();
    beginEditing();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finishEditing(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelledRef.current = true;
      finishEditing(false);
    }
  }

  if (!editing) {
    return (
      <span className={[styles.label, className].filter(Boolean).join(' ')} onDoubleClick={handleDoubleClick}>
        {value}
      </span>
    );
  }

  return (
    <input
      className={[styles.input, className].filter(Boolean).join(' ')}
      // `size` mantém a largura próxima da do label — sem isso a barra de abas
      // pula de layout ao entrar em edição.
      size={Math.max(8, Math.min(draft.length + 1, maxLength))}
      value={draft}
      maxLength={maxLength}
      aria-label={inputAriaLabel}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={handleInputKeyDown}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onBlur={() => finishEditing(!cancelledRef.current)}
    />
  );
});
