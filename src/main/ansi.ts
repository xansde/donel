// Remoção de sequências de escape ANSI para o ring buffer de preview
// (plan.md ponto 8). Implementação própria em vez de um pacote npm: os
// pacotes populares (`strip-ansi`/`ansi-regex`) são ESM-only e o main process
// é buildado como CJS com deps externalizadas (electron.vite.config.ts) —
// `require()` de um pacote ESM-only quebraria em runtime.
//
// Cobre as três formas emitidas por PowerShell/ConPTY: CSI (`ESC [ params
// letra`, ex. cores/cursor), OSC (`ESC ] ... BEL`, ex. título da janela) e
// escapes de um caractere só (`ESC letra`, ex. reset). `\x1B`/`\x07` são os
// bytes ESC/BEL — escritos como escape de string para não depender de
// caracteres de controle literais no arquivo-fonte.
const CSI_PATTERN = /\x1B\[[0-9;?]*[A-Za-z]/g;
const OSC_PATTERN = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const SINGLE_CHAR_ESCAPE_PATTERN = /\x1B[@-Z\\\]^_=>]/g;

export function stripAnsi(input: string): string {
  return input.replace(OSC_PATTERN, '').replace(CSI_PATTERN, '').replace(SINGLE_CHAR_ESCAPE_PATTERN, '');
}
