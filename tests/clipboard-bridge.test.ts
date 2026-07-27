// T503 (005-terminal-copy-paste) — três funções finas sobre `electron.clipboard`
// (plan.md Fatia 2, decisão 6: "clipboard vive no main, não no renderer").
// Regra dura: qualquer exceção do clipboard é engolida e degrada —
// clipboard indisponível NUNCA pode derrubar a digitação ou quebrar a aba
// (spec.md). `electron.clipboard` é mockado (vi.mock) porque este módulo é
// o único lugar do app que o toca de verdade.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readImageMock = vi.fn();
const readTextMock = vi.fn();
const writeTextMock = vi.fn();

vi.mock('electron', () => ({
  clipboard: {
    readImage: (...args: unknown[]) => readImageMock(...args),
    readText: (...args: unknown[]) => readTextMock(...args),
    writeText: (...args: unknown[]) => writeTextMock(...args),
  },
}));

const { hasImage, readText, writeText } = await import('../src/main/clipboard-bridge');

describe('clipboard-bridge', () => {
  beforeEach(() => {
    readImageMock.mockReset();
    readTextMock.mockReset();
    writeTextMock.mockReset();
  });

  describe('hasImage', () => {
    it('imagem vazia no clipboard -> false', () => {
      readImageMock.mockReturnValue({ isEmpty: () => true });
      expect(hasImage()).toBe(false);
    });

    it('imagem NÃO vazia no clipboard -> true', () => {
      readImageMock.mockReturnValue({ isEmpty: () => false });
      expect(hasImage()).toBe(true);
    });

    it('clipboard.readImage lançando exceção -> false (degrada, não propaga)', () => {
      readImageMock.mockImplementation(() => {
        throw new Error('clipboard indisponível');
      });
      expect(hasImage()).toBe(false);
    });
  });

  describe('readText', () => {
    it('repassa o texto de clipboard.readText', () => {
      readTextMock.mockReturnValue('texto copiado');
      expect(readText()).toBe('texto copiado');
    });

    it('clipboard.readText lançando exceção -> string vazia (degrada, não propaga)', () => {
      readTextMock.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(readText()).toBe('');
    });
  });

  describe('writeText', () => {
    it('repassa o texto para clipboard.writeText', () => {
      writeText('para copiar');
      expect(writeTextMock).toHaveBeenCalledWith('para copiar');
    });

    it('clipboard.writeText lançando exceção não propaga (não derruba a digitação)', () => {
      writeTextMock.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(() => writeText('x')).not.toThrow();
    });
  });
});
