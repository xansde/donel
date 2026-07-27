import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Toast } from './Toast';
import { Button } from '../Button';

const meta: Meta<typeof Toast> = {
  title: 'Base/Toast',
  component: Toast,
  parameters: {
    docs: {
      description: {
        component: 'Toast de canto inferior direito (design-system.md §6), auto-dismiss em ~6s.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Toast>;

/** "Guardado no tomo." — confirmação depois de Enter na captura relâmpago (Brief 13, Tela C). */
export const PostItSaved: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Mostrar toast
        </Button>
        <Toast open={open} message="Guardado no tomo." onDismiss={() => setOpen(false)} />
      </>
    );
  },
};

/** Notificação opcional de permissão pendente, com ação (Brief 2). */
export const PermissionPendingWithAction: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Mostrar toast
        </Button>
        <Toast
          open={open}
          message='"revisão PR 214" precisa de permissão'
          actionLabel="Ver sessão"
          onAction={() => setOpen(false)}
          onDismiss={() => setOpen(false)}
        />
      </>
    );
  },
};

/** Duração customizada — auto-dismiss mais curto para o exemplo interativo. */
export const CustomDuration: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Mostrar toast (2s)
        </Button>
        <Toast open={open} message="Post-it arquivado." duration={2000} onDismiss={() => setOpen(false)} />
      </>
    );
  },
};
