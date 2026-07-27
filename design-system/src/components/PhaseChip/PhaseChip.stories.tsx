import type { Meta, StoryObj } from '@storybook/react';
import { PhaseChip } from './PhaseChip';

const meta: Meta<typeof PhaseChip> = {
  title: 'Modo Dev/PhaseChip',
  component: PhaseChip,
  parameters: {
    docs: {
      description: {
        component:
          'Chip de fase da Esteira, usado no modo Dev (Brief 10). Paleta das 5 fases é interpretação livre — não fixada pelo design-system.md.',
      },
    },
  },
  args: { phase: 'discovery' },
};

export default meta;
type Story = StoryObj<typeof PhaseChip>;

export const Discovery: Story = { args: { phase: 'discovery' } };
export const Plano: Story = { args: { phase: 'plano' } };

/** "SZI-142 · Ajuste parcelas CUB" está em Implementar (Brief 10). */
export const Implementar: Story = { args: { phase: 'implementar' } };
export const Validar: Story = { args: { phase: 'validar' } };
export const Concluir: Story = { args: { phase: 'concluir' } };

/** As 5 fases lado a lado — como aparecem espalhadas pelas linhas da sidebar de tasks (Brief 10). */
export const AllPhases: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <PhaseChip phase="discovery" />
      <PhaseChip phase="plano" />
      <PhaseChip phase="implementar" />
      <PhaseChip phase="validar" />
      <PhaseChip phase="concluir" />
    </div>
  ),
};

/** Sidebar de tasks do modo Dev (Brief 10): cada task com sua fase atual. */
export const TaskSidebarExample: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 260 }}>
      {[
        { id: 'SZI-142 · Ajuste parcelas CUB', phase: 'implementar' as const },
        { id: 'SZI-155 · Webhook medalhas', phase: 'plano' as const },
        { id: 'SZI-160 · Radar de PRs', phase: 'discovery' as const },
      ].map((task) => (
        <div
          key={task.id}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 12px',
            background: 'var(--bg-panel)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--text-body-size)',
            color: 'var(--text-primary)',
          }}
        >
          <span>{task.id}</span>
          <PhaseChip phase={task.phase} />
        </div>
      ))}
    </div>
  ),
};
