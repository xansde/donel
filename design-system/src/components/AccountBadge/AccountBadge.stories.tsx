import type { Meta, StoryObj } from '@storybook/react';
import { AccountBadge } from './AccountBadge';

const meta: Meta<typeof AccountBadge> = {
  title: 'Contas/AccountBadge',
  component: AccountBadge,
  parameters: {
    docs: {
      description: {
        component:
          'Pílula de conta usada no titlebar (Brief 1), no dropdown de contas (Brief 5A) e no painel de gestão (Brief 5B). Dados de exemplo exatos do Brief 5.',
      },
    },
  },
  args: {
    accountNumber: 3,
    headroomPercent: 62,
  },
};

export default meta;
type Story = StoryObj<typeof AccountBadge>;

/** Titlebar do shell principal: "Tecnologia Claude 3 · 62%" com seta de dropdown (Brief 1). */
export const TitlebarTrigger: Story = {
  args: { accountNumber: 3, headroomPercent: 62, expandable: true, onClick: () => {} },
};

/** Tecnologia Claude 1 · 38% — âmbar, faixa 15–40% (Brief 5). */
export const HeadroomMid: Story = {
  args: { accountNumber: 1, headroomPercent: 38 },
};

/** Tecnologia Claude 2 · 91% — verde, >40% (Brief 5). */
export const HeadroomHigh: Story = {
  args: { accountNumber: 2, headroomPercent: 91 },
};

/** Tecnologia Claude 3 · 62% — verde, marcada como ativa no dropdown (Brief 5). */
export const ActiveInDropdown: Story = {
  args: { accountNumber: 3, headroomPercent: 62, active: true },
};

/** Tecnologia Claude 4 · 12% — vermelho, <15% (Brief 5). */
export const HeadroomLow: Story = {
  args: { accountNumber: 4, headroomPercent: 12 },
};

/** Tecnologia Claude 5 · "—" — sem leitura disponível (Brief 5). */
export const NoReading: Story = {
  args: { accountNumber: 5, headroomPercent: null },
};

/** Conta sem login feito — o app nunca manuseia credenciais, login é sempre no terminal (Brief 5B). */
export const LoginPending: Story = {
  args: { accountNumber: 6, headroomPercent: null, loginPending: true },
};

/** Leitura de headroom em andamento (dropdown acabou de abrir, batch A 002-quota-headroom). */
export const Loading: Story = {
  args: { accountNumber: 7, headroomPercent: null, loading: true },
};

/** As 15 contas do dropdown (Brief 5A), com a conta 3 marcada ativa. */
export const AccountDropdownList: Story = {
  render: () => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: 'var(--bg-raised)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: 8,
        width: 220,
      }}
    >
      {[38, 91, 62, 12, null].map((headroom, index) => (
        <AccountBadge
          key={index}
          accountNumber={index + 1}
          headroomPercent={headroom}
          active={index === 2}
        />
      ))}
    </div>
  ),
};
