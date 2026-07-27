import type { Meta, StoryObj } from '@storybook/react';
import { StatusBar } from './StatusBar';

const meta: Meta<typeof StatusBar> = {
  title: 'Shell/StatusBar',
  component: StatusBar,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Statusbar do shell principal (Brief 1). Dados de exemplo exatos: "Tecnologia Claude 3 · fable/high · 6 sessões · [mini smart zone]".',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof StatusBar>;

/** Statusbar completa do Brief 1 — dados de exemplo exatos. */
export const ShellStatusBar: Story = {
  args: {
    accountLabel: 'Tecnologia Claude 3 · 62%',
    modelEffort: 'fable/high',
    sessionCount: 6,
    smartZone: { usedTokens: 312_000 },
  },
};

/** Sem sessões abertas — nº de sessões cai para singular, sem mini smart zone. */
export const NoSessions: Story = {
  args: {
    accountLabel: 'Tecnologia Claude 3 · 62%',
    sessionCount: 0,
  },
};

/** Uma única sessão — pluralização em pt-BR. */
export const SingleSession: Story = {
  args: {
    accountLabel: 'Tecnologia Claude 3 · 62%',
    modelEffort: 'sonnet/med',
    sessionCount: 1,
    smartZone: { usedTokens: 45_000 },
  },
};
