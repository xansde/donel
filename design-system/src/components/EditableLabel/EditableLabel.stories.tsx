import type { Meta, StoryObj } from '@storybook/react';
import { EditableLabel } from './EditableLabel';

const meta: Meta<typeof EditableLabel> = {
  title: 'Sessão/EditableLabel',
  component: EditableLabel,
  parameters: {
    docs: {
      description: {
        component:
          'Label que vira input inline no lugar (004-nomear-sessoes, decisão C5): duplo-clique **ou** F2 abre a edição, Enter e blur confirmam, Esc cancela. Usado pela aba de topo e pela linha de sessão da sidebar — o mesmo gesto nos dois, de propósito.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof EditableLabel>;

/** Nome curto — dê duplo-clique para editar. */
export const Default: Story = {
  args: { value: 'spec do donel', onCommit: () => {} },
};

/** Nome no limite dos 60 caracteres do C5 — o corte fica com quem hospeda o label. */
export const AtMaxLength: Story = {
  args: { value: 'renomear sessoes para achar o que fiz semanas atras aqui!!', maxLength: 60, onCommit: () => {} },
};

/** Não editável — renderiza só o texto, sem gesto nenhum. */
export const NotEditable: Story = {
  args: { value: 'sessão do sistema', editable: false, onCommit: () => {} },
};
