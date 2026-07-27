import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Base/Button',
  component: Button,
  parameters: {
    docs: {
      description: {
        component:
          'Botão base do sistema (design-system.md §6): primário, secundário, ghost e perigo. Altura fixa 30px.',
      },
    },
  },
  args: {
    variant: 'secondary',
    children: 'Botão',
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: { variant: 'primary', children: 'Salvar' },
};

export const Secondary: Story = {
  args: { variant: 'secondary', children: 'Cancelar' },
};

export const Ghost: Story = {
  args: { variant: 'ghost', children: 'Copiar' },
};

export const Danger: Story = {
  args: { variant: 'danger', children: 'Fechar sessão' },
};

export const Disabled: Story = {
  args: { variant: 'primary', children: 'Iniciar', disabled: true },
};

/** "▶ Iniciar", botão primário de largura total do Launcher (Brief 3). */
export const LauncherStartFullWidth: Story = {
  args: { variant: 'primary', children: '▶ Iniciar', fullWidth: true },
  decorators: [(Story) => <div style={{ width: 260 }}><Story /></div>],
};

/** Modal "Fechar sessão?" (Brief 1): botão de perigo + botão secundário lado a lado. */
export const CloseSessionModalActions: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <Button variant="secondary">Cancelar</Button>
      <Button variant="danger">Fechar sessão</Button>
    </div>
  ),
};

/** Linha de sessão anterior (Brief 4): "Retomar" primário + "Fork" secundário. */
export const ResumeAndForkActions: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button variant="primary">Retomar</Button>
      <Button variant="secondary">Fork</Button>
    </div>
  ),
};
