import type { Meta, StoryObj } from '@storybook/react';
import { SplitButton } from './SplitButton';

const meta: Meta<typeof SplitButton> = {
  title: 'Base/SplitButton',
  component: SplitButton,
  parameters: {
    docs: {
      description: {
        component:
          '"＋ Nova sessão" no titlebar do shell (Brief 1) — clique no corpo abre direto com a última config de sessão Claude; a seta abre um menu com "Sessão Claude" (Launcher) e "Terminal" (aba comum sem configuração).',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SplitButton>;

/** "＋ Nova sessão" — corpo inicia com a última config, seta abre Sessão Claude / Terminal (Brief 1). */
export const NewSessionSplitButton: Story = {
  args: {
    label: '＋ Nova sessão',
    onClick: () => alert('Inicia sessão Claude com a última configuração usada'),
    items: [
      { label: 'Sessão Claude', onSelect: () => alert('Abre o Launcher (Brief 3)') },
      { label: 'Terminal', onSelect: () => alert('Abre aba de terminal comum, sem configuração') },
    ],
  },
};

export const SecondaryVariant: Story = {
  args: {
    label: 'Nova rotina',
    variant: 'secondary',
    onClick: () => {},
    items: [
      { label: 'Do zero', onSelect: () => {} },
      { label: 'Duplicar "Setup do dia"', onSelect: () => {} },
    ],
  },
};

export const Disabled: Story = {
  args: {
    label: '＋ Nova sessão',
    disabled: true,
    onClick: () => {},
    items: [{ label: 'Sessão Claude', onSelect: () => {} }],
  },
};
