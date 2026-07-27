// FIX (feedback E2E rodada 1, agravante do bug StrictMode) — replay do ring
// buffer ao montar o TerminalPane. `ptyManager.create()` (main process)
// spawna o processo SINCRONAMENTE e começa a alimentar o ring buffer
// (últimas ~50 linhas, ANSI stripado — `src/main/pty-manager.ts`,
// `RING_BUFFER_LINES`) imediatamente; o roundtrip do IPC até o renderer
// registrar seu listener de `onData` (invoke `pty:create` -> resolve da
// promise -> `window.donel.pty.onData(...)`) não é instantâneo, e o flush
// do PtyManager pro renderer é batelado (~16ms, `BATCH_INTERVAL_MS`). Nessa
// janela — mais provável de doer em dev com StrictMode (double-mount: cada
// mount spawna seu PRÓPRIO pty novo, não reaproveita o do mount anterior),
// mas presente em qualquer spawn — texto que o processo já emitiu pode
// nunca chegar no `onData` desta aba, e o terminal nasce vazio até o
// próximo redraw real do CLI. `TerminalPane.tsx` busca o preview via
// `pty:preview` (mesmo canal do hover-preview futuro, plan.md ponto 8) e
// escreve ANTES de assinar `onData` — este módulo é só a transformação pura
// (testável sem Electron/xterm) de "linhas do ring buffer" pra "blob
// escrevível no xterm via `term.write`".

/**
 * Junta as linhas do ring buffer (já sem ANSI, uma por elemento) num único
 * blob pronto pra `term.write()`: cada linha termina em `\r\n` — xterm trata
 * `\n` puro como "desce uma linha sem voltar pra coluna 0" (comportamento de
 * terminal real), então só `\n` sozinho deixaria o texto em escada. `[]`
 * vira string vazia — nada a escrever, sem `\r\n` solto no início da tela.
 */
export function formatRingBufferPreview(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return `${lines.join('\r\n')}\r\n`;
}
