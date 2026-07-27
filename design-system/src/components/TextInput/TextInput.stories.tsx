import type { Meta, StoryObj } from '@storybook/react';
import { TextInput } from './TextInput';

const meta: Meta<typeof TextInput> = {
  title: 'Base/TextInput',
  component: TextInput,
  parameters: {
    docs: {
      description: {
        component: 'Input de texto livre (design-system.md §6). Fundo `bg-raised`, anel `accent` no foco.',
      },
    },
  },
  args: {
    label: 'Nome',
    placeholder: 'opcional',
  },
};

export default meta;
type Story = StoryObj<typeof TextInput>;

/** Campo "Nome" do Launcher — nome vazio é um estado válido (Brief 3). */
export const LauncherNameField: Story = {
  args: { label: 'Nome', placeholder: 'opcional' },
};

/** Campo "Nome do projeto" do formulário de Novo Projeto, com slug ao lado em mono (Brief 12). */
export const ProjectNameWithFilledValue: Story = {
  args: { label: 'Nome do projeto', defaultValue: 'Radar de PRs' },
};

/** Validação de nome duplicado — mensagem sob o campo (Brief 12). */
export const DuplicateNameValidation: Story = {
  args: {
    label: 'Nome do projeto',
    defaultValue: 'vega',
    hint: 'Esse projeto já existe em ~/dev',
    hintTone: 'danger',
  },
};

export const Disabled: Story = {
  args: { label: 'Nome', defaultValue: 'spec do donel', disabled: true },
};
