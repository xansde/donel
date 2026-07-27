import type { Meta, StoryObj } from '@storybook/react';
import { PostItCard } from './PostItCard';

const meta: Meta<typeof PostItCard> = {
  title: 'Post-its/PostItCard',
  component: PostItCard,
  parameters: {
    docs: {
      description: {
        component:
          'Carta do Tomo do Donel (§10, §6, Brief 8 e 13). Dados de exemplo exatos do quadro de post-its (Brief 8).',
      },
    },
  },
  args: {
    onArchive: () => {},
    onSendToSession: () => {},
    onCopy: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof PostItCard>;

/** Item 1 do quadro de post-its (Brief 8). */
export const WithProject: Story = {
  args: {
    text: 'lembrar de revisar PR 214 amanhã',
    date: 'hoje, 14:32',
    project: 'ai-rats',
  },
};

/** Item 2 do quadro de post-its (Brief 8). */
export const IdeaCard: Story = {
  args: {
    text: 'ideia: badge de conta podia ter atalho de teclado',
    date: 'hoje, 10:05',
    project: 'donel-dev',
  },
};

/** Item 3 do quadro de post-its — sem projeto de origem, campo opcional (Brief 8). */
export const WithoutProject: Story = {
  args: {
    text: 'perguntar sobre smart zone em modo Dev',
    date: 'ontem, 17:50',
  },
};

/** Sem ações — usado quando a carta é só leitura (ex. captura relâmpago recém-criada). */
export const ReadOnly: Story = {
  args: {
    text: 'testar o modo lote da esteira num card real',
    date: 'ontem',
    project: 'atlas-app',
    onArchive: undefined,
    onSendToSession: undefined,
    onCopy: undefined,
  },
};

/** Grid do quadro de post-its, ordenado do mais recente ao mais antigo (Brief 8). */
export const Board: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 220px)', gap: 16 }}>
      <PostItCard
        text="lembrar de revisar PR 214 amanhã"
        date="hoje, 14:32"
        project="ai-rats"
        onArchive={() => {}}
        onSendToSession={() => {}}
        onCopy={() => {}}
      />
      <PostItCard
        text="ideia: badge de conta podia ter atalho de teclado"
        date="hoje, 10:05"
        project="donel-dev"
        onArchive={() => {}}
        onSendToSession={() => {}}
        onCopy={() => {}}
      />
      <PostItCard
        text="perguntar sobre smart zone em modo Dev"
        date="ontem, 17:50"
        onArchive={() => {}}
        onSendToSession={() => {}}
        onCopy={() => {}}
      />
    </div>
  ),
};
