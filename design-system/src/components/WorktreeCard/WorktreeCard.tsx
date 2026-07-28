import { PhaseStateGlyph, PHASE_STATE_LABEL_PT, type PhaseState } from '../PhaseStateGlyph';
import { AnnotationTag, type AnnotationTone } from '../AnnotationTag';
import { ESTEIRA_PHASE_LABEL_PT, type EsteiraPhase } from '../PhaseChip';
import styles from './WorktreeCard.module.css';

export interface WorktreeCardAnnotation {
  text: string;
  tone: AnnotationTone;
}

export interface WorktreeCardPhaseNode {
  phase: EsteiraPhase;
  state: PhaseState;
  /** Anotações do espelho do board para esta fase (CA-12), ex.: "trava desde ontem, 18:42". */
  annotations?: WorktreeCardAnnotation[];
  /** Retomar a etapa (CA-9) — abre a sessão arquivada, nunca dispara comando por aqui. */
  onSelect?: () => void;
}

interface WorktreeCardCommonProps {
  /** Ex.: "[M1]" — prefixo de marco lido do disco (CA-14), aqui só exibição. */
  id: string;
  title: string;
  /** Resumo em linguagem simples, sem jargão — quem chega frio no card entende. */
  summary: string;
  /** Status agregado do cabeçalho (ex.: "Validar rodando"). */
  status?: string;
  statusTone?: AnnotationTone;
  /** Traz este marco/discovery ao foco (CA-2). */
  onFocus?: () => void;
  className?: string;
}

export interface WorktreeCardMarcoProps extends WorktreeCardCommonProps {
  variant: 'marco';
  /**
   * Pasta da worktree (D3 — `esteira-reader.ts` passa a expor `worktree_path`
   * do frontmatter do `ctx.md`). Opcional: `ctx.md` anterior ao D3 não tem o
   * campo — a faixa omite o que faltar, sem quebrar a fixture antiga.
   */
  worktreePath?: string;
  /** Branch da worktree (D3), mesma ressalva de `ctx.md` anterior. */
  branch?: string;
  /** Etiquetas do espelho do board na faixa de worktree (CA-12), ex.: PR + aprovação. */
  tags?: WorktreeCardAnnotation[];
  /** Os 5 nós de fase, um por fase da Esteira. */
  phases: WorktreeCardPhaseNode[];
}

export interface WorktreeCardOrquestradorProps extends WorktreeCardCommonProps {
  /**
   * Card do discovery-pai: sem faixa de worktree e sem nós de fase — ele não
   * roda etapas próprias. As props de marco não existem neste tipo, não só
   * ficam escondidas via CSS (T333, teste primeiro).
   */
  variant: 'orquestrador';
}

export type WorktreeCardProps = WorktreeCardMarcoProps | WorktreeCardOrquestradorProps;

/**
 * Cartão do carrossel de marcos (CA-7): cabeçalho, resumo em linguagem
 * simples, faixa de worktree e os 5 nós de fase (compõe `PhaseStateGlyph`,
 * um por fase). Variante `orquestrador` para o card do discovery-pai.
 */
export function WorktreeCard(props: WorktreeCardProps) {
  const { id, title, summary, status, statusTone = 'accent', onFocus, className } = props;
  const hasWorktreeStrip =
    props.variant === 'marco' && (props.worktreePath || props.branch || (props.tags && props.tags.length > 0));

  return (
    <div className={[styles.card, className].filter(Boolean).join(' ')} onClick={onFocus}>
      <div className={styles.header}>
        <span className={styles.marker} aria-hidden="true">
          ▷
        </span>
        <span className={styles.id}>{id}</span>
        <span className={styles.title}>{title}</span>
        {status ? <AnnotationTag tone={statusTone}>{status}</AnnotationTag> : null}
      </div>
      <p className={styles.summary}>{summary}</p>
      {props.variant === 'marco' && hasWorktreeStrip ? (
        <div className={styles.worktreeStrip}>
          {props.worktreePath || props.branch ? <span className={styles.worktreeLabel}>worktree</span> : null}
          {props.worktreePath ? <span className={styles.worktreePath}>{props.worktreePath}</span> : null}
          {props.branch ? <span className={styles.branch}>⑂ {props.branch}</span> : null}
          {props.tags?.map((tag) => (
            <AnnotationTag key={`${tag.tone}-${tag.text}`} tone={tag.tone}>
              {tag.text}
            </AnnotationTag>
          ))}
        </div>
      ) : null}
      {props.variant === 'marco' ? (
        <div className={styles.phases}>
          {props.phases.map((node) => (
            <button
              key={node.phase}
              type="button"
              className={styles.phaseNode}
              onClick={node.onSelect}
              disabled={!node.onSelect}
            >
              <div className={styles.phaseRow}>
                <PhaseStateGlyph status={node.state} />
                <span className={styles.phaseLabel}>{ESTEIRA_PHASE_LABEL_PT[node.phase]}</span>
                <span className={styles.phaseState}>{PHASE_STATE_LABEL_PT[node.state]}</span>
              </div>
              {node.annotations?.length ? (
                <div className={styles.phaseAnnotations}>
                  {node.annotations.map((ann) => (
                    <AnnotationTag key={`${ann.tone}-${ann.text}`} tone={ann.tone}>
                      {ann.text}
                    </AnnotationTag>
                  ))}
                </div>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
