// T501 (005-terminal-copy-paste) — decisor puro tecla -> ação de
// copiar/colar/interromper, ramificado por `sessionType` (spec.md CA-1..CA-9,
// plan.md Fatia 1, "forma da solução"). Sem xterm/Electron/DOM: recebe um
// descritor achatado (o mesmo shape que `term.attachCustomKeyEventHandler`
// do xterm entrega) + o contexto da aba, e devolve UMA ação. É o que
// permite TDD de verdade (a matriz CA-1..CA-9 vira tabela de teste, mesma
// estratégia que `sessionAccountLabel.ts`/`computeSessionAccountLabel` já
// usa) e o que impede o `\x03` de nascer em aba claude (fato herdado do
// tasks.md: `TerminalPane.tsx` repassa TODO byte cru ao PTY via
// `term.onData` — este módulo não toca nisso, só decide se o `onData`
// chega a rodar, cancelando via `attachCustomKeyEventHandler` retornando
// `false`).

/** Contexto da aba no momento do toque — tudo resolvido pelo CHAMADOR (TerminalPane), nunca por este módulo. */
export type TerminalKeyContext = {
  /** 'claude' = sessão claude direta no PTY; 'shell' = terminal livre (FR-008). */
  sessionType: 'claude' | 'shell';
  /** `term.hasSelection()` — síncrono, sem assincronia envolvida (ao contrário de `clipboardHasImage`, ver plan.md Fatia 2). */
  hasSelection: boolean;
  /**
   * Resultado (já resolvido) de `clipboard-bridge.hasImage()` — IPC
   * assíncrono. Quem chama este módulo faz a dança async ANTES de invocar
   * `resolveTerminalKeyAction` para `Ctrl+V` (plan.md Fatia 2 "padrão
   * adotado"): este módulo em si é 100% síncrono.
   */
  clipboardHasImage: boolean;
};

/** Mesmo shape achatado que `term.attachCustomKeyEventHandler` do xterm entrega (subset de `KeyboardEvent`). */
export interface TerminalKeyDescriptor {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Só `'keydown'` ramifica — `'keyup'`/`'keypress'` sempre `passthrough` (senão a ação dispara 2-3x por toque). */
  type: string;
}

export type TerminalKeyAction =
  | { kind: 'passthrough' } // devolve true: xterm segue o fluxo normal (term.onData intacto)
  | { kind: 'copySelection' } // Ctrl+C com seleção
  | { kind: 'pasteText' } // Ctrl+V sem imagem
  | { kind: 'pasteImage' } // Ctrl+V com imagem -> escrever IMAGE_PASTE_SEQUENCE no PTY
  | { kind: 'noop' }; // C1: Ctrl+C sem seleção em aba claude — nunca `\x03`

/**
 * Sequência que o claude CLI associa ao binding `chat:imagePaste` no Windows
 * (`alt+v` = `ESC v`). Provada empiricamente em ConPTY real (node-pty 1.1.0,
 * mesma versão empacotada pelo app instalado) — ver
 * `specs/005-terminal-copy-paste/spike-1-imagem-no-conpty.md`. Fica num só
 * lugar: se uma versão futura do CLI mudar o binding, é uma linha (plan.md
 * "Riscos").
 */
export const IMAGE_PASTE_SEQUENCE = '\x1b\x76';

/**
 * Implementa EXATAMENTE a tabela do `plan.md` (Fatia 1). Guard rails na
 * ordem certa (tasks.md T501): (1) só `keydown` ramifica; (2) `shiftKey` /
 * `altKey` / `metaKey` saem por `passthrough` ANTES de olhar `Ctrl+C`/
 * `Ctrl+V` — é o que protege `Ctrl+Shift+C/V` (CA-7), `Alt+V` (CA-8) e evita
 * `Ctrl+Alt+V` virar colagem; (3) só então `Ctrl+C`/`Ctrl+V`. Qualquer outra
 * combinação (setas, Home/End, PgUp/PgDn, Del, Tab, Esc, digitação normal)
 * cai no `passthrough` final — não há código específico para elas (CA-9/C3).
 */
export function resolveTerminalKeyAction(key: TerminalKeyDescriptor, ctx: TerminalKeyContext): TerminalKeyAction {
  if (key.type !== 'keydown') return { kind: 'passthrough' };
  if (key.shiftKey || key.altKey || key.metaKey) return { kind: 'passthrough' };

  const lowerKey = key.key.toLowerCase();

  if (key.ctrlKey && lowerKey === 'c') {
    // CA-1: Ctrl+C COM seleção copia em AMBOS os tipos de aba — não é
    // restrito a 'claude' (é o comportamento do Windows Terminal, a
    // referência declarada na spec).
    if (ctx.hasSelection) return { kind: 'copySelection' };
    // CA-2 (C1): sem seleção, aba claude NUNCA manda `\x03` — no-op
    // silencioso, interromper é responsabilidade exclusiva do Esc.
    if (ctx.sessionType === 'claude') return { kind: 'noop' };
    // CA-6: aba shell sem seleção mantém SIGINT (única forma de matar processo lá).
    return { kind: 'passthrough' };
  }

  if (key.ctrlKey && lowerKey === 'v') {
    // Colar imagem é só para aba claude (fora de escopo em shell, spec.md
    // "Fora de escopo" + tasks.md) — em shell, imagem no clipboard desce
    // passthrough (comportamento default, não é responsabilidade nossa).
    if (ctx.sessionType === 'claude' && ctx.clipboardHasImage) return { kind: 'pasteImage' };
    if (ctx.sessionType === 'shell' && ctx.clipboardHasImage) return { kind: 'passthrough' };
    return { kind: 'pasteText' };
  }

  return { kind: 'passthrough' };
}
