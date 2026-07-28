import type { Meta, StoryObj } from '@storybook/react';
import { AnnotationTag } from './AnnotationTag';

const meta: Meta<typeof AnnotationTag> = {
  title: 'Modo Dev/AnnotationTag',
  component: AnnotationTag,
  parameters: {
    docs: {
      description: {
        component:
          'Etiqueta curta com tom semântico — veste as anotações do espelho do board sobre os nós do mapa (CA-12: coluna real, trava ativa, etiquetas de atenção, PR+aprovação).',
      },
    },
  },
  args: { tone: 'muted', children: 'sem PR' },
};

export default meta;
type Story = StoryObj<typeof AnnotationTag>;

export const Muted: Story = { args: { tone: 'muted', children: 'sem PR' } };
export const Ok: Story = { args: { tone: 'ok', children: 'PR aprovado' } };
export const Warn: Story = { args: { tone: 'warn', children: 'PR #482 · aprovação pendente' } };
export const ErrorTone: Story = { args: { tone: 'error', children: 'precisa atenção' } };

/** Trava ativa (CA-5) — tom exclusivo, visualmente distinto de `error` (falha/divergência). */
export const Lock: Story = { args: { tone: 'lock', children: 'trava desde ontem, 18:42' } };
export const Accent: Story = { args: { tone: 'accent', children: 'não move o card' } };

/**
 * As 6 combinações lado a lado — confirma que `lock` e `error` são
 * visualmente distintos entre si (T332, teste primeiro deste pacote sem test
 * runner: a story é a fixture).
 */
export const AllTones: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <AnnotationTag tone="muted">sem PR</AnnotationTag>
      <AnnotationTag tone="ok">PR aprovado</AnnotationTag>
      <AnnotationTag tone="warn">aprovação pendente</AnnotationTag>
      <AnnotationTag tone="error">precisa atenção</AnnotationTag>
      <AnnotationTag tone="lock">trava ativa</AnnotationTag>
      <AnnotationTag tone="accent">não move o card</AnnotationTag>
    </div>
  ),
};
