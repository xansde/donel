import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Modal } from './Modal';
import { Button } from '../Button';

const meta: Meta<typeof Modal> = {
  title: 'Base/Modal',
  component: Modal,
  parameters: {
    docs: {
      description: {
        component:
          'Modal central, máx. 480px — usado só para confirmação destrutiva (Brief 1) e formulário de novo projeto (Brief 12), conforme design-system.md §6.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Modal>;

/** "Fechar sessão?" — confirmação destrutiva ao fechar uma aba com sessão ativa (Brief 1). */
export const CloseSessionConfirmation: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Reabrir modal
        </Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Fechar sessão?"
          actions={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button variant="danger" onClick={() => setOpen(false)}>
                Fechar sessão
              </Button>
            </>
          }
        >
          O processo será encerrado. Você pode reabrir esta sessão depois pela lista de sessões anteriores.
        </Modal>
      </>
    );
  },
};

/** Passo final do formulário de Novo Projeto (Brief 12): resumo + fecho de voz do Donel. */
export const NewProjectSummaryStep: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Reabrir modal
        </Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Criar projeto"
          actions={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Criar projeto
              </Button>
            </>
          }
        >
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <li>Diretório: ~/dev/radar-de-prs</li>
            <li>Vault: Projects/radar-de-prs</li>
            <li>Pointer L1 registrado</li>
            <li>TaskDex vinculado</li>
          </ul>
          <p style={{ marginTop: 12, marginBottom: 0, fontSize: 'var(--text-caption-size)', color: 'var(--text-muted)' }}>
            Caminho novo — o nômade aprova.
          </p>
        </Modal>
      </>
    );
  },
};

/** Modal fechado — nada é renderizado (comportamento base do componente). */
export const Closed: Story = {
  render: () => <Modal open={false} onClose={() => {}} title="Fechar sessão?">Conteúdo oculto.</Modal>,
};
