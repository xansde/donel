import type { DiscoveryTree } from '../../../main/discovery-tree';
import type { DevModeDiscoveries } from '../../../shared/devMode';

// T311/T321 (003-modo-dev, Batch B) — decisões PURAS da porta de entrada
// (CA-2) e do encerramento automático (CA-23). Sem React e sem IPC: só o
// cruzamento entre os cards do board, os discoveries abertos (estado próprio,
// CA-21) e as árvores lidas do disco.
//
// CA-14 respeitado: o vínculo card-de-marco → discovery vem do `fanout_cards`
// (disco), NUNCA do prefixo `[Mx]` do título do card no board.

export type EntrySelection =
  | { readonly kind: 'focus'; readonly discoveryCardId: string }
  | { readonly kind: 'create'; readonly cardId: string };

export interface EntrySelectionInput {
  readonly cardId: string;
  readonly discoveries: DevModeDiscoveries;
  readonly trees: readonly DiscoveryTree[];
}

/** Um discovery só conta como "aberto" enquanto não encerrou (CA-23). */
function isOpen(discoveries: DevModeDiscoveries, cardId: string): boolean {
  const discovery = discoveries[cardId];
  return !!discovery && discovery.closedAt === null;
}

/** Discovery-pai de um card de MARCO (card de Plano), pelo `fanout_cards` do disco — `null` se o card não é marco de nenhum discovery aberto. */
function parentDiscoveryOf(cardId: string, discoveries: DevModeDiscoveries, trees: readonly DiscoveryTree[]): string | null {
  for (const tree of trees) {
    if (!isOpen(discoveries, tree.discoveryCardId)) continue;
    if (tree.marcos.some((marco) => marco.cardId === cardId)) return tree.discoveryCardId;
  }
  return null;
}

/**
 * CA-2 — "vinculado é foco, não criação": card com discovery aberto traz
 * aquele discovery ao foco; card de **Plano** abre o discovery **pai**; card
 * sem vínculo nenhum vira criação (que dispara o fluxo do CA-3).
 */
export function resolveEntrySelection(input: EntrySelectionInput): EntrySelection {
  if (isOpen(input.discoveries, input.cardId)) return { kind: 'focus', discoveryCardId: input.cardId };

  const parent = parentDiscoveryOf(input.cardId, input.discoveries, input.trees);
  if (parent) return { kind: 'focus', discoveryCardId: parent };

  return { kind: 'create', cardId: input.cardId };
}

/** CA-2 — o card vinculado aparece MARCADO na lista de candidatos (card de entrada ou card de marco). */
export function isCardLinked(cardId: string, discoveries: DevModeDiscoveries, trees: readonly DiscoveryTree[]): boolean {
  if (isOpen(discoveries, cardId)) return true;
  return parentDiscoveryOf(cardId, discoveries, trees) !== null;
}

/**
 * CA-23 — discoveries que devem encerrar sozinhos: `allMarcosComplete` é
 * fato verificável do disco (gate de `esteira-concluir` de cada marco), não
 * opinião do app. Já encerrado nunca reaparece aqui (evita IPC repetido).
 */
export function discoveriesToClose(trees: readonly DiscoveryTree[], discoveries: DevModeDiscoveries): readonly string[] {
  return trees
    .filter((tree) => tree.allMarcosComplete && isOpen(discoveries, tree.discoveryCardId))
    .map((tree) => tree.discoveryCardId);
}
