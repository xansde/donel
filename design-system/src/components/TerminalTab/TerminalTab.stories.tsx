import type { Meta, StoryObj } from '@storybook/react';
import { TerminalTab } from './TerminalTab';

const meta: Meta<typeof TerminalTab> = {
  title: 'Sessão/TerminalTab',
  component: TerminalTab,
  parameters: {
    docs: {
      description: {
        component:
          'Abas do centro do shell principal (Brief 1) — uma por sessão aberta. Dados de exemplo: "spec do donel" (trabalhando, fable), "radar spotsys" (aguardando, sonnet), "fix build_real.py" (encerrada, sonnet).',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof TerminalTab>;

/** Aba ativa da sessão "spec do donel" — trabalhando, modelo fable (Brief 1). */
export const ActiveWorkingTab: Story = {
  args: { name: 'spec do donel', model: 'fable', state: 'working', active: true, onClose: () => {} },
};

/** Aba inativa "radar spotsys" — aguardando resposta, modelo sonnet (Brief 1). */
export const WaitingTab: Story = {
  args: { name: 'radar spotsys', model: 'sonnet', state: 'waiting', onClose: () => {} },
};

/** Aba "fix build_real.py" — encerrada (Brief 1). */
export const DoneTab: Story = {
  args: { name: 'fix build_real.py', model: 'sonnet', state: 'done', onClose: () => {} },
};

/** Terminal comum, sem sessão Claude — troca o dot pelo ícone de shell (Brief 1). */
export const CommonTerminalTab: Story = {
  args: { name: 'shell', onClose: () => {} },
};

/** Barra de abas completa, como no topo do centro do shell (Brief 1). */
export const TabBar: Story = {
  render: () => (
    <div style={{ display: 'flex', background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)' }}>
      <TerminalTab name="spec do donel" model="fable" state="working" active onClose={() => {}} />
      <TerminalTab name="radar spotsys" model="sonnet" state="waiting" onClose={() => {}} />
      <TerminalTab name="fix build_real.py" model="sonnet" state="done" onClose={() => {}} />
      <TerminalTab name="shell" onClose={() => {}} />
    </div>
  ),
};
