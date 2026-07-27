import { Button, Modal, Select, TextInput } from '@donel-dev/design-system';
import type { SelectOption } from '@donel-dev/design-system';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { NotificationPreference } from '../../shared/config';
import styles from './Preferences.module.css';

// T015 — UI de Preferências (FR-007, feedback E2E rodada 3 "roots de
// projetos precisam ser configuráveis pela UI" + rodada 4 "notificação
// configurável"). Tela mínima (ui-spec §2 já previa isso pro P1; puxado pro
// P0 pelo feedback humano) — sem instrumento de tema (P1, "Fora deste
// ciclo" em tasks.md) nem defaults do launcher (esses são semeados
// automaticamente a cada "▶ Iniciar", App.tsx `handleLaunch`, sem precisar
// de um campo editável aqui). Mudanças aplicam IMEDIATAMENTE (add/remove de
// root já dispara re-scan; troca de notificação já persiste) — sem botão
// "Salvar" separado, mesmo espírito instantâneo do resto do app (favoritar
// projeto, trocar perfil).

const NOTIFICATION_OPTIONS: SelectOption[] = [
  { value: 'all', label: 'Todas as transições', description: 'notifica sempre que uma sessão em background passa a aguardar ou pedir permissão' },
  { value: 'permission-only', label: 'Só permissão pendente', description: 'padrão — só quando uma sessão trava esperando sua aprovação' },
  { value: 'none', label: 'Nenhuma', description: 'desativa notificações do Windows' },
];

export interface PreferencesProps {
  open: boolean;
  onClose: () => void;
  projectRoots: readonly string[];
  notificationPreference: NotificationPreference;
  onAddRoot: (root: string) => void;
  onRemoveRoot: (root: string) => void;
  onChangeNotificationPreference: (preference: NotificationPreference) => void;
}

export function Preferences({
  open,
  onClose,
  projectRoots,
  notificationPreference,
  onAddRoot,
  onRemoveRoot,
  onChangeNotificationPreference,
}: PreferencesProps): React.JSX.Element {
  const [newRoot, setNewRoot] = useState('');

  const handleAdd = (): void => {
    const trimmed = newRoot.trim();
    if (!trimmed) return;
    onAddRoot(trimmed);
    setNewRoot('');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Preferências"
      actions={
        <Button variant="primary" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className={styles.section} data-testid="preferences-roots-section">
        <h3 className={styles.sectionTitle}>Pastas-raiz de projetos</h3>
        <p className={styles.sectionHint}>Onde a sidebar procura projetos (até 2 níveis, `.git/` ou `CLAUDE.md`).</p>
        <ul className={styles.rootList}>
          {projectRoots.length === 0 ? <li className={styles.hint}>Nenhuma pasta-raiz configurada.</li> : null}
          {projectRoots.map((root) => (
            <li key={root} className={styles.rootRow}>
              <span className={styles.rootPath} title={root}>
                {root}
              </span>
              <button
                type="button"
                className={styles.removeRootButton}
                onClick={() => onRemoveRoot(root)}
                aria-label={`Remover pasta ${root}`}
              >
                <Trash2 size={12} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div className={styles.addRootRow}>
          <TextInput
            className={styles.addRootInput}
            placeholder="C:\Users\voce\pasta"
            aria-label="Nova pasta-raiz"
            value={newRoot}
            onChange={(event) => setNewRoot(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAdd();
              }
            }}
          />
          <Button variant="secondary" onClick={handleAdd} disabled={!newRoot.trim()}>
            Adicionar
          </Button>
        </div>
      </div>

      <div className={styles.section} data-testid="preferences-notification-section">
        <h3 className={styles.sectionTitle}>Notificação do Windows</h3>
        <p className={styles.sectionHint}>Quando uma sessão em background precisa da sua atenção.</p>
        <div data-testid="notification-preference-select">
          <Select
            value={notificationPreference}
            options={NOTIFICATION_OPTIONS}
            onChange={(value) => onChangeNotificationPreference(value as NotificationPreference)}
          />
        </div>
      </div>
    </Modal>
  );
}
