import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SegmentedControl } from './SegmentedControl';

const meta: Meta<typeof SegmentedControl> = {
  title: 'Base/SegmentedControl',
  component: SegmentedControl,
  parameters: {
    docs: {
      description: {
        component:
          'Segmented control (design-system.md §6) — usado nos campos Modelo/Esforço do Launcher (Brief 3), no switch de modo do titlebar (Brief 1) e no Tipo do formulário de Novo Projeto (Brief 12).',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SegmentedControl>;

const MODEL_OPTIONS = [
  { value: 'fable', label: 'fable' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
];

const EFFORT_OPTIONS = [
  { value: 'low', label: 'low' },
  { value: 'med', label: 'med' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

/** Campo "Modelo" do Launcher, selecionado em "fable" (Brief 3 — dados de exemplo). */
export const LauncherModelField: Story = {
  render: () => {
    const [value, setValue] = useState('fable');
    return <SegmentedControl ariaLabel="Modelo" options={MODEL_OPTIONS} value={value} onChange={setValue} />;
  },
};

/** Campo "Esforço" do Launcher, selecionado em "high" (Brief 3 — dados de exemplo). */
export const LauncherEffortField: Story = {
  render: () => {
    const [value, setValue] = useState('high');
    return <SegmentedControl ariaLabel="Esforço" options={EFFORT_OPTIONS} value={value} onChange={setValue} />;
  },
};

/** Switch de modo do titlebar: "Uso geral" | "Dev" (Brief 1). */
export const ShellModeSwitch: Story = {
  render: () => {
    const [value, setValue] = useState('geral');
    return (
      <SegmentedControl
        ariaLabel="Modo"
        options={[
          { value: 'geral', label: 'Uso geral' },
          { value: 'dev', label: 'Dev' },
        ]}
        value={value}
        onChange={setValue}
      />
    );
  },
};

/** Campo "Tipo" do formulário de Novo Projeto: "Pessoal" | "Profissional" (Brief 12). */
export const NewProjectTypeField: Story = {
  render: () => {
    const [value, setValue] = useState('profissional');
    return (
      <SegmentedControl
        ariaLabel="Tipo"
        options={[
          { value: 'pessoal', label: 'Pessoal' },
          { value: 'profissional', label: 'Profissional' },
        ]}
        value={value}
        onChange={setValue}
      />
    );
  },
};
