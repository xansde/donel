import { Button, Modal, TextInput } from '@donel-dev/design-system';
import { useMemo, useState } from 'react';
import type { SessionNamesMap, SessionSummaryDto } from '../../shared';
import { resolveSessionName } from '../../shared/sessionName';
import { filterSessionsByQuery, formatFileSize, formatRelativeTime } from '../../shared/sessions';
import styles from './PreviousSessions.module.css';

// T013 — PARTE PRINCIPAL: painel "Sessões anteriores" (FR-004, CA-2,
// ui-spec §5, brief B4 do design reference). Lista por projeto, alimentada
// pelo SessionIndexer (T012, via `window.donel.sessions.list` — App.tsx faz
// o fetch, este componente só renderiza). Aberto por um ícone dedicado na
// sidebar (ProjectSidebar `onShowPreviousSessions`) — ver comentário lá pro
// porquê de não ser o clique no nome do projeto.
//
// Reaproveita o `Modal` do design-system (mesmo padrão do "Fechar sessão?"
// em App.tsx) em vez de um popover posicionado à mão: acessibilidade
// (role=dialog, foco preso, Escape) de graça, sem inventar um sistema de
// posicionamento novo pro card flutuante do brief B4.
//
// Campo "modelo" do brief B4 ("{{ p.date }} · {{ p.size }} · {{ p.model }}")
// fica DE FORA — ver comentário no topo de shared/sessions.ts pro porquê
// (SessionIndexer, T012, congelado, não extrai modelo por sessão).

export interface PreviousSessionsProps {
  open: boolean;
  projectName: string;
  sessions: SessionSummaryDto[];
  loading: boolean;
  onClose: () => void;
  onResume: (session: SessionSummaryDto) => void;
  onFork: (session: SessionSummaryDto) => void;
  /**
   * T408 (004-nomear-sessoes) — mapa de nomes do ConfigStore, para esta lista
   * exibir o MESMO nome resolvido que a aba e a sidebar (CA-1/CA-5). É aqui
   * que o caso de uso principal acontece: reachar pelo nome uma sessão de
   * semanas atrás (US-A). Sem isso, a lista mostraria só a 1ª mensagem.
   */
  sessionNames: SessionNamesMap;
}

export function PreviousSessions({
  open,
  projectName,
  sessions,
  loading,
  onClose,
  onResume,
  onFork,
  sessionNames,
}: PreviousSessionsProps): React.JSX.Element {
  // Query de busca reseta implicitamente a cada abertura (o componente some
  // do DOM quando `open` é false — Modal.tsx `if (!open) return null` — o
  // React descarta o state local junto).
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterSessionsByQuery(sessions, query), [sessions, query]);

  return (
    <Modal open={open} onClose={onClose} title={`Sessões anteriores · ${projectName}`}>
      <div data-testid="previous-sessions" className={styles.body}>
        <TextInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filtrar por nome…"
          aria-label="Filtrar sessões anteriores por nome"
        />

        {loading ? <p className={styles.hint}>Carregando sessões…</p> : null}

        {/* ui-spec §5, edge case "empty state": projeto sem NENHUMA sessão anterior. */}
        {!loading && sessions.length === 0 ? (
          <p className={styles.hint} data-testid="previous-sessions-empty">
            Nenhuma sessão anterior neste projeto — comece uma nova.
          </p>
        ) : null}

        {/* Busca sem resultado é um estado DIFERENTE do índice vazio (ui-spec §5: "Busca simples por nome"). */}
        {!loading && sessions.length > 0 && filtered.length === 0 ? (
          <p className={styles.hint}>Nenhuma sessão bate com “{query}”.</p>
        ) : null}

        {filtered.length > 0 ? (
          <ul className={styles.list}>
            {filtered.map((session) => (
              <li key={session.id} className={styles.row} data-testid="previous-session-row">
                <div className={styles.info}>
                  {/* ui-spec §5: transcript corrompido/truncado entra na lista com preview "(ilegível)", sem derrubar o índice — o SessionIndexer já garante isso; aqui só um tom visual diferente. */}
                  <span className={[styles.preview, session.corrupted ? styles.corrupted : ''].join(' ')}>
                    {resolveSessionName({
                      fallback: session.preview,
                      customTitle: session.customTitle,
                      stored: sessionNames[session.id] ?? null,
                    })}
                  </span>
                  <span className={styles.meta}>
                    {formatRelativeTime(session.lastActivityAt ?? session.mtimeMs)} · {formatFileSize(session.size)}
                  </span>
                </div>
                <div className={styles.actions}>
                  <Button variant="primary" onClick={() => onResume(session)}>
                    Retomar
                  </Button>
                  <Button variant="secondary" onClick={() => onFork(session)}>
                    Fork
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}
