import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Toggle } from './Toggle';

const meta: Meta<typeof Toggle> = {
  title: 'Base/Toggle',
  component: Toggle,
  parameters: {
    docs: {
      description: {
        component: 'Toggle simples (design-system.md §6). Usado no formulário de Novo Projeto (Brief 12).',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Toggle>;

/** Campo "Tem todo?" do formulário de Novo Projeto, ativado (Brief 12 — dados de exemplo). */
export const HasTodoToggle: Story = {
  render: () => {
    const [checked, setChecked] = useState(true);
    return (
      <div style={{ width: 280 }}>
        <Toggle checked={checked} onChange={setChecked} label="Tem todo?" description="cria todo.md no vault" />
      </div>
    );
  },
};

/** Vínculo TaskDex — só aparece quando Tipo = Profissional (Brief 12). */
export const TaskDexLinkToggle: Story = {
  render: () => {
    const [checked, setChecked] = useState(true);
    return (
      <div style={{ width: 280 }}>
        <Toggle checked={checked} onChange={setChecked} label="Vincular TaskDex" description="disponível para projetos Profissional" />
      </div>
    );
  },
};

export const Unchecked: Story = {
  render: () => {
    const [checked, setChecked] = useState(false);
    return (
      <div style={{ width: 280 }}>
        <Toggle checked={checked} onChange={setChecked} label="Tem todo?" description="cria todo.md no vault" />
      </div>
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <div style={{ width: 280 }}>
      <Toggle checked={false} onChange={() => {}} label="Tem todo?" disabled />
    </div>
  ),
};
