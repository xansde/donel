import type { Meta, StoryObj } from '@storybook/react';
import { StateDot } from './StateDot';

const meta: Meta<typeof StateDot> = {
  title: 'Sessão/StateDot',
  component: StateDot,
  parameters: {
    docs: {
      description: {
        component:
          'O vocabulário visual central do produto (design-system.md §1, §2, §6) — cada linha de sessão na sidebar e cada TerminalTab começam com este dot. Dados de exemplo vêm do Brief 2 (design-handoff.md).',
      },
    },
  },
  args: {
    state: 'working',
  },
};

export default meta;
type Story = StoryObj<typeof StateDot>;

/** "spec do donel" — trabalhando, projeto donel-dev, modelo fable (Brief 1/2). */
export const Working: Story = {
  args: { state: 'working', label: 'Trabalhando' },
};

/** "radar spotsys" — aguardando resposta, sobe no ranking, mostra "há 4min" ao lado (Brief 2). */
export const Waiting: Story = {
  args: { state: 'waiting', label: 'Aguardando resposta' },
};

/** "revisão PR 214" — permissão pendente, vai para o topo absoluto da lista, pulso rápido + halo (Brief 2). */
export const PermissionPending: Story = {
  args: { state: 'permission', label: 'Permissão pendente' },
};

/** "fix build_real.py" — encerrada, mostra ações inline "reabrir · fechar" (Brief 2). */
export const Done: Story = {
  args: { state: 'done', label: 'Encerrada' },
};

/** Sessão morta por erro ou quota esgotada — distinta de "encerrada", ação inline "trocar de conta e retomar" (Brief 2). */
export const Error: Story = {
  args: { state: 'error', label: 'Falha ou quota esgotada' },
};

/** Sem `label`: o dot ainda expõe o estado via aria-label (design-system.md §9 — nunca só cor). */
export const NoVisibleLabel: Story = {
  args: { state: 'permission', label: undefined },
};

/**
 * "radar spotsys" a 312k/400k (Brief 6) — passou de 70% da smart zone, ganha
 * o anel fino âmbar ao redor do dot, independente do próprio estado.
 */
export const WithSmartZoneRingWarn: Story = {
  args: { state: 'waiting', label: 'Aguardando resposta', ring: 'warn' },
};

/** "fix build_real.py" a 410k/400k (Brief 6) — smart zone estourada, anel vermelho-coral. */
export const WithSmartZoneRingOver: Story = {
  args: { state: 'working', label: 'Trabalhando', ring: 'over' },
};

/** Todos os 5 estados lado a lado, como aparecem empilhados na lista de sessões (Brief 2). */
export const AllStates: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StateDot state="permission" label="Permissão pendente" />
      <StateDot state="waiting" label="Aguardando resposta" />
      <StateDot state="working" label="Trabalhando" />
      <StateDot state="done" label="Encerrada" />
      <StateDot state="error" label="Falha ou quota esgotada" />
    </div>
  ),
};
