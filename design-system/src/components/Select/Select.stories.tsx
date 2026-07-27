import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Select } from './Select';

const meta: Meta<typeof Select> = {
  title: 'Base/Select',
  component: Select,
  parameters: {
    docs: {
      description: {
        component:
          'Campo "Permissões" do Launcher (Brief 3) — 6 opções, cada uma com uma descrição curta mostrada quando o dropdown está aberto.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Select>;

const PERMISSION_OPTIONS = [
  { value: 'manual', label: 'manual', description: 'Pede confirmação a cada ação sensível.' },
  { value: 'acceptEdits', label: 'acceptEdits', description: 'Aceita edições de arquivo automaticamente.' },
  { value: 'auto', label: 'auto', description: 'Aceita a maioria das ações sem perguntar.' },
  { value: 'plan', label: 'plan', description: 'Só planeja — nenhuma ação é executada.' },
  { value: 'dontAsk', label: 'dontAsk', description: 'Nunca pede confirmação, mesmo em ações destrutivas.' },
  { value: 'bypassPermissions', label: 'bypassPermissions', description: 'Ignora todo o sistema de permissões.' },
];

/** Campo "Permissões" do Launcher, selecionado em "acceptEdits" (Brief 3 — dados de exemplo). */
export const LauncherPermissionsField: Story = {
  render: () => {
    const [value, setValue] = useState('acceptEdits');
    return (
      <div style={{ width: 260 }}>
        <Select label="Permissões" value={value} onChange={setValue} options={PERMISSION_OPTIONS} />
      </div>
    );
  },
};

/** Sem seleção — mostra o placeholder. */
export const Empty: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <div style={{ width: 260 }}>
        <Select
          label="Permissões"
          value={value}
          onChange={setValue}
          options={PERMISSION_OPTIONS}
          placeholder="Selecionar permissão"
        />
      </div>
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <div style={{ width: 260 }}>
      <Select label="Permissões" value="manual" onChange={() => {}} options={PERMISSION_OPTIONS} disabled />
    </div>
  ),
};
