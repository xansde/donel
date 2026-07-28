import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { ArmedPrompt } from './ArmedPrompt';

const meta: Meta<typeof ArmedPrompt> = {
  title: 'Modo Dev/ArmedPrompt',
  component: ArmedPrompt,
  parameters: {
    docs: {
      description: {
        component:
          'O gesto central do CA-3: comando escrito e não enviado, tecla Enter desenhada explicitamente, aviso opcional e descartar — a única ação exposta pelo tipo é `onDismiss` (sem `onEnter`/`onSubmit`, invariante 2).',
      },
    },
  },
  args: {
    command: '/esteira-validar SZI-142-M2',
    hint: 'escreve no prompt e para — o Enter é seu',
  },
};

export default meta;
type Story = StoryObj<typeof ArmedPrompt>;

export const SemAviso: Story = {
  args: { onDismiss: () => {} },
};

/** Fase travada — o botão da próxima fase continua clicável (CA-5); o aviso é só informativo. */
export const ComAviso: Story = {
  args: {
    warning: { text: 'fase em andamento desde ontem, 18:42 — o disparo pode ser recusado', tone: 'lock' },
    onDismiss: () => {},
  },
};

/**
 * Estado "descartado" (T334, teste primeiro) — clicar "descartar" some com o
 * comando armado; nenhum comando foi disparado no processo.
 */
export const Descartado: Story = {
  args: { command: '/esteira-implementar SZI-142-M1' },
  render: (args) => {
    function Demo() {
      const [visible, setVisible] = useState(true);
      if (!visible) {
        return <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>descartado — nenhum comando armado</p>;
      }
      return <ArmedPrompt {...args} onDismiss={() => setVisible(false)} />;
    }
    return <Demo />;
  },
};
