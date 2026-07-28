import type { Meta, StoryObj } from '@storybook/react';
import { WorktreeCard, type WorktreeCardPhaseNode } from './WorktreeCard';

const meta: Meta<typeof WorktreeCard> = {
  title: 'Modo Dev/WorktreeCard',
  component: WorktreeCard,
  parameters: {
    docs: {
      description: {
        component:
          'Cartão do carrossel de marcos (CA-7): cabeçalho, resumo em linguagem simples, faixa de worktree (pasta + branch + etiquetas, D3) e os 5 nós de fase. Variante `orquestrador` para o card do discovery-pai, sem faixa de worktree e sem fases.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof WorktreeCard>;

const PHASES_M1: WorktreeCardPhaseNode[] = [
  { phase: 'discovery', state: 'done' },
  { phase: 'plano', state: 'done' },
  { phase: 'implementar', state: 'stuck', annotations: [{ text: 'trava desde ontem, 18:42', tone: 'lock' }] },
  { phase: 'validar', state: 'running', annotations: [{ text: 'não move o card', tone: 'muted' }] },
  { phase: 'concluir', state: 'not-started', annotations: [{ text: 'falta aprovação do PR #482', tone: 'warn' }] },
];

/** "[M1] · Cálculo das parcelas" (Brief 10, mockup) — fase Implementar travada. */
export const Marco: Story = {
  args: {
    variant: 'marco',
    id: '[M1]',
    title: 'Cálculo das parcelas',
    summary: 'Descobrir quanto o cliente paga por mês quando o CUB muda de valor.',
    status: 'Validar rodando',
    statusTone: 'accent',
    worktreePath: '../worktrees/142-m1',
    branch: 'feat/142-m1-calculo-parcelas',
    tags: [{ text: 'PR #482 · aprovação pendente', tone: 'warn' }],
    phases: PHASES_M1,
  },
};

/**
 * `ctx.md` anterior ao D3 — sem `worktree_path`/`branch` no frontmatter. A
 * fixture não pode quebrar (spec, decisões pós-design D3): a faixa omite os
 * campos ausentes em vez de mostrar vazio ou lançar erro.
 */
export const MarcoSemWorktreeInfo: Story = {
  args: {
    variant: 'marco',
    id: '[M3]',
    title: 'Relatório de repasse',
    summary: 'Gerar o relatório mensal de repasse para o proprietário.',
    phases: [
      { phase: 'discovery', state: 'not-started' },
      { phase: 'plano', state: 'not-started' },
      { phase: 'implementar', state: 'not-started' },
      { phase: 'validar', state: 'not-started' },
      { phase: 'concluir', state: 'not-started' },
    ],
  },
};

/** Card do discovery-pai — sem faixa de worktree, sem nós de fase (não roda etapas próprias). */
export const Orquestrador: Story = {
  args: {
    variant: 'orquestrador',
    id: 'SZI-142',
    title: 'Ajuste de parcelas por variação do CUB',
    summary: 'Discovery-pai: 3 marcos, um deles com a fase Implementar travada.',
  },
};
