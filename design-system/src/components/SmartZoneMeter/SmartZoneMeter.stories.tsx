import type { Meta, StoryObj } from '@storybook/react';
import { SmartZoneMeter } from './SmartZoneMeter';

const meta: Meta<typeof SmartZoneMeter> = {
  title: 'Sessão/SmartZoneMeter',
  component: SmartZoneMeter,
  parameters: {
    docs: {
      description: {
        component:
          'Medidor de contexto consumido (design-system.md §6, Brief 6 do handoff). As três faixas de exemplo abaixo reproduzem exatamente os três casos do brief: "spec do donel" (180k, ok), "radar spotsys" (312k, warn) e "fix build_real.py" (410k, over).',
      },
    },
  },
  args: {
    usedTokens: 180_000,
  },
};

export default meta;
type Story = StoryObj<typeof SmartZoneMeter>;

/** "spec do donel": 180k/400k — zone-ok (verde). */
export const ZoneOk: Story = {
  args: { usedTokens: 180_000 },
};

/** "radar spotsys": 312k/400k — zone-warn (âmbar), tooltip "312k/400k · atenção". */
export const ZoneWarn: Story = {
  args: { usedTokens: 312_000 },
};

/** "fix build_real.py": 410k/400k — zone-over (vermelho), tooltip mostra "Handoff → nova sessão". */
export const ZoneOver: Story = {
  args: {
    usedTokens: 410_000,
    onHandoff: () => alert('Abre o Launcher pré-preenchido com "fix build_real.py (cont.)"'),
  },
};

/** Zona estourada sem `onHandoff` — o tooltip ainda mostra "handoff sugerido", mas sem botão de ação. */
export const ZoneOverWithoutHandler: Story = {
  args: { usedTokens: 410_000 },
};

/** Variante mini usada na statusbar (Brief 6, variante 2) — só barra + rótulo compacto. */
export const CompactVariant: Story = {
  args: { usedTokens: 312_000, variant: 'compact' },
};

/** As três faixas lado a lado, como no painel de detalhes de sessão (Brief 6). */
export const AllZones: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SmartZoneMeter usedTokens={180_000} />
      <SmartZoneMeter usedTokens={312_000} />
      <SmartZoneMeter usedTokens={410_000} onHandoff={() => {}} />
    </div>
  ),
};
