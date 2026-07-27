import { describe, expect, it } from 'vitest';
import { formatRingBufferPreview } from '../src/renderer/src/ringBufferPreview';

describe('formatRingBufferPreview', () => {
  it('sem linhas, devolve string vazia (nada a escrever)', () => {
    expect(formatRingBufferPreview([])).toBe('');
  });

  it('uma linha só termina em \\r\\n (xterm precisa do \\r pra voltar pra coluna 0)', () => {
    expect(formatRingBufferPreview(['Claude Code v2.1.3'])).toBe('Claude Code v2.1.3\r\n');
  });

  it('várias linhas ficam separadas por \\r\\n, cada uma na sua própria linha do terminal', () => {
    const lines = ['Claude Code v2.1.3', '', '> pronto para seu próximo comando'];
    expect(formatRingBufferPreview(lines)).toBe('Claude Code v2.1.3\r\n\r\n> pronto para seu próximo comando\r\n');
  });
});
