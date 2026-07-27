import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/main/ansi';

// Ciclo de correção 1 (auditoria batch 2) — stripAnsi é lógica pura nova
// deste batch (ring buffer de preview, plan.md ponto 8) que tinha ficado sem
// vitest. Cobre as três famílias de escape que ela remove (CSI, OSC com os
// dois terminadores válidos, escape de 1 char) mais os casos-base.

describe('stripAnsi', () => {
  it('removes a CSI color sequence', () => {
    expect(stripAnsi('\x1B[31mred\x1B[0m plain')).toBe('red plain');
  });

  it('removes a CSI cursor-movement sequence with numeric params', () => {
    expect(stripAnsi('before\x1B[2Kafter')).toBe('beforeafter');
  });

  it('removes an OSC title sequence terminated by BEL', () => {
    expect(stripAnsi('\x1B]0;window title\x07rest')).toBe('rest');
  });

  it('removes an OSC title sequence terminated by ST (ESC \\)', () => {
    expect(stripAnsi('\x1B]0;window title\x1B\\rest')).toBe('rest');
  });

  it('removes a single-character escape', () => {
    // ESC M (reverse index) — dentro do range [@-Z] coberto por
    // SINGLE_CHAR_ESCAPE_PATTERN.
    expect(stripAnsi('before\x1BMafter')).toBe('beforeafter');
  });

  it('leaves a string without any ANSI escape untouched', () => {
    const plain = 'plain text, no escapes here';
    expect(stripAnsi(plain)).toBe(plain);
  });

  it('removes multiple sequences of different families in the same string', () => {
    expect(stripAnsi('\x1B[1m\x1B]0;title\x07bold \x1B[32mgreen\x1B[0m \x1BMtext')).toBe('bold green text');
  });
});
