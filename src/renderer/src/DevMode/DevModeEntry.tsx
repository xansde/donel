import { AnnotationTag, Button, SegmentedControl, Select, TextInput } from '@donel-dev/design-system';
import { useMemo, useState } from 'react';
import type { EntryColumn, EntryColumnCard, ProjectInfo } from '../../../shared';
import type { DiscoveryTree } from '../../../main/discovery-tree';
import type { DevModeDiscoveries } from '../../../shared/devMode';
import { isCardLinked } from './devModeSelection';
import styles from './DevModeEntry.module.css';

// T311 (003-modo-dev, Batch B) — Zona 1, porta de entrada (CA-1/CA-2).
//
// Só compõe peças do design system (CA-25): `TextInput` (filtro),
// `SegmentedControl` (coluna), `Select` (repo do discovery novo),
// `AnnotationTag` (card já vinculado) e `Button`. Nenhuma peça nova.
//
// A LISTA vem inteira do main (`devMode:listEntryCards` → `listEntryColumnCards`,
// que já garante as 3 colunas do CA-1) — este componente nunca inventa card,
// nunca consulta o board e nunca escreve nele.

const COLUMN_LABEL: Record<EntryColumn, string> = {
  backlog: 'Backlog',
  discovery: 'Discovery',
  plano: 'Plano',
};

type ColumnFilter = EntryColumn | 'todas';

export interface DevModeEntryProps {
  cards: readonly EntryColumnCard[];
  discoveries: DevModeDiscoveries;
  trees: readonly DiscoveryTree[];
  projects: readonly ProjectInfo[];
  /** Repo pré-selecionado para um discovery novo (herda a seleção da sidebar, mesmo espírito do Launcher). */
  defaultRepoPath?: string;
  /** Card já vinculado → foca o discovery; card sem vínculo → cria (com o repo escolhido). Quem decide é `resolveEntrySelection` (puro). */
  onSelectCard: (cardId: string, repoPath: string) => void;
  loading: boolean;
}

export function DevModeEntry({
  cards,
  discoveries,
  trees,
  projects,
  defaultRepoPath,
  onSelectCard,
  loading,
}: DevModeEntryProps): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const [column, setColumn] = useState<ColumnFilter>('todas');
  const [repoPath, setRepoPath] = useState(defaultRepoPath ?? projects[0]?.path ?? '');

  const visibleCards = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return cards.filter((card) => {
      if (column !== 'todas' && card.column !== column) return false;
      if (!needle) return true;
      return `${card.cardId} ${card.title}`.toLowerCase().includes(needle);
    });
  }, [cards, column, filter]);

  return (
    <section className={styles.entry} aria-label="Porta de entrada do Modo Dev" data-testid="devmode-entry">
      <header className={styles.header}>
        <h2 className={styles.title}>Abrir discovery</h2>
        <p className={styles.hint}>Cards do board nas colunas Backlog, Discovery e Plano.</p>
      </header>

      <TextInput
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filtrar card…"
        aria-label="Filtrar cards"
      />

      <SegmentedControl
        value={column}
        onChange={(next) => setColumn(next as ColumnFilter)}
        options={[
          { value: 'todas', label: 'Todas' },
          { value: 'backlog', label: COLUMN_LABEL.backlog },
          { value: 'discovery', label: COLUMN_LABEL.discovery },
          { value: 'plano', label: COLUMN_LABEL.plano },
        ]}
        ariaLabel="Filtrar por coluna"
      />

      <Select
        label="Repo do discovery novo"
        value={repoPath}
        onChange={setRepoPath}
        options={projects.map((project) => ({ value: project.path, label: project.name }))}
        placeholder="Selecione um projeto"
      />

      <ul className={styles.list} data-testid="devmode-entry-list">
        {loading ? <li className={styles.empty}>Carregando…</li> : null}
        {!loading && visibleCards.length === 0 ? (
          <li className={styles.empty} data-testid="devmode-entry-empty">
            Nenhum card nas colunas de entrada.
          </li>
        ) : null}
        {visibleCards.map((card) => {
          const linked = isCardLinked(card.cardId, discoveries, trees);
          return (
            <li key={card.cardId} className={styles.row} data-testid={`devmode-entry-card-${card.cardId}`}>
              <Button
                variant="secondary"
                onClick={() => onSelectCard(card.cardId, repoPath)}
                className={styles.rowButton}
                disabled={!linked && !repoPath}
                title={card.cardId}
              >
                <span className={styles.cardTitle}>{card.title}</span>
                <span className={styles.cardId}>{card.cardId}</span>
              </Button>
              <div className={styles.rowTags}>
                <AnnotationTag tone="muted">{COLUMN_LABEL[card.column]}</AnnotationTag>
                {/* CA-2 — "vinculado é foco, não criação": a marca é do card, o
                    comportamento do clique é decidido por `resolveEntrySelection`. */}
                {linked ? (
                  <AnnotationTag tone="accent">
                    <span data-testid={`devmode-entry-linked-${card.cardId}`}>discovery aberto</span>
                  </AnnotationTag>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
