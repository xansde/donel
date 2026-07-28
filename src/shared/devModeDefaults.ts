// T302 (003-modo-dev, Batch A) — tabela inicial de defaults por fase (C6),
// editável em runtime via `devMode:setDefaults` (T307) e persistida em
// `AppConfig.devMode.phaseDefaults` (T306). É o que permite trocar o `fable`
// de discovery por outro modelo num dia de cota apertada sem tocar em código.
//
// D2 (verificação de design, 27/07): o subconjunto do Validar é contexto
// humano, não dado do app — `plano-result.json` não tem campo de subconjunto
// (`esteira-plano/SKILL.md:452-487`). O comando pré-digitado é sempre o real,
// `/esteira-validar {card_id}`, **sem** `--subset` ou qualquer outra flag
// inventada.

import type { EsteiraPhase, PhaseDefault, PhaseDefaultsTable } from './devMode';

export const DEFAULT_PHASE_DEFAULTS: PhaseDefaultsTable = {
  discovery: { model: 'fable', effort: 'high', commandTemplate: '/esteira-discovery {card_id}', opensOwnSession: true },
  plano: { model: 'opus', effort: 'high', commandTemplate: '/esteira-plano {card_id}', opensOwnSession: true },
  implementar: {
    model: 'opus',
    effort: 'high',
    commandTemplate: '/esteira-implementar {card_id} ultracode',
    opensOwnSession: true,
  },
  // D2: sem `--subset` — o texto exato da skill, nada inventado.
  validar: { model: 'sonnet', effort: 'high', commandTemplate: '/esteira-validar {card_id}', opensOwnSession: true },
  // C6: gate determinístico, roda inline na sessão em foco (não abre sessão própria).
  concluir: { model: 'haiku', effort: 'low', commandTemplate: '/esteira-concluir {card_id}', opensOwnSession: false },
};

/** Substitui o único placeholder (`{card_id}`) pelo id real — puro, sem I/O. */
export function resolveCommandText(entry: PhaseDefault, cardId: string): string {
  return entry.commandTemplate.replace('{card_id}', cardId);
}

/** Reexport de conveniência para quem só precisa do tipo (evita importar de devMode.ts em dois lugares). */
export type { EsteiraPhase, PhaseDefault, PhaseDefaultsTable };
