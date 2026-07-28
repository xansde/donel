import type { Meta, StoryObj } from '@storybook/react';
import { PhaseStateGlyph } from './PhaseStateGlyph';

const meta: Meta<typeof PhaseStateGlyph> = {
  title: 'Modo Dev/PhaseStateGlyph',
  component: PhaseStateGlyph,
  parameters: {
    docs: {
      description: {
        component:
          'Os 5 estados de fase da Esteira (CA-15, spec 003-modo-dev) — eixo diferente do semáforo de sessão (StateDot); os dois coexistem lado a lado no mesmo nó do mapa (CA-25). Dupla codificação: caractere + cor, nunca só cor.',
      },
    },
  },
  args: { status: 'not-started' },
};

export default meta;
type Story = StoryObj<typeof PhaseStateGlyph>;

export const NotStarted: Story = { args: { status: 'not-started', label: 'Não iniciada' } };
export const Running: Story = { args: { status: 'running', label: 'Em execução' } };
export const Done: Story = { args: { status: 'done', label: 'Concluída' } };

/** Preenchimento sólido — "a coisa mais clara da tela" (CA-15, requisito literal). */
export const Failed: Story = { args: { status: 'failed', label: 'Falhou' } };

/** Preenchimento sólido; dono do token `--state-error` (roxo), até aqui reservado e sem uso. */
export const Stuck: Story = { args: { status: 'stuck', label: 'Travada' } };

/**
 * Os 5 estados lado a lado — confirma a dupla codificação por inspeção: cada
 * caractere é distinto e só `failed`/`stuck` têm preenchimento sólido (T331,
 * teste primeiro deste pacote sem test runner).
 */
export const AllStates: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16 }}>
      <PhaseStateGlyph status="not-started" label="Não iniciada" />
      <PhaseStateGlyph status="running" label="Em execução" />
      <PhaseStateGlyph status="done" label="Concluída" />
      <PhaseStateGlyph status="failed" label="Falhou" />
      <PhaseStateGlyph status="stuck" label="Travada" />
    </div>
  ),
};

/** Sem `label`: o glifo ainda expõe o estado via `aria-label` (nunca só cor). */
export const NoVisibleLabel: Story = {
  args: { status: 'stuck', label: undefined },
};
