// T501 (005-terminal-copy-paste) — decisor puro tecla -> ação, ramificado por
// `sessionType` (spec.md CA-1..CA-9, plan.md Fatia 1). Um caso por linha da
// tabela do plan.md x 2 tipos de aba, mais os casos de borda do DoD do
// tasks.md. Sem xterm/Electron/DOM: só o objeto plano que o
// `attachCustomKeyEventHandler` do xterm recebe (`KeyboardEvent`-like).
import { describe, expect, it } from 'vitest';
import { IMAGE_PASTE_SEQUENCE, resolveTerminalKeyAction } from '../src/shared/terminalKeymap';
import type { TerminalKeyContext, TerminalKeyDescriptor } from '../src/shared/terminalKeymap';

function key(overrides: Partial<TerminalKeyDescriptor>): TerminalKeyDescriptor {
  return {
    key: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    type: 'keydown',
    ...overrides,
  };
}

function ctx(overrides: Partial<TerminalKeyContext>): TerminalKeyContext {
  return {
    sessionType: 'claude',
    hasSelection: false,
    clipboardHasImage: false,
    ...overrides,
  };
}

describe('resolveTerminalKeyAction', () => {
  describe('Ctrl+C com seleção — copia em AMBOS os tipos de aba (CA-1, plan.md "não restringe por tipo")', () => {
    it('aba claude', () => {
      const action = resolveTerminalKeyAction(
        key({ key: 'c', ctrlKey: true }),
        ctx({ sessionType: 'claude', hasSelection: true }),
      );
      expect(action).toEqual({ kind: 'copySelection' });
    });

    it('aba shell', () => {
      const action = resolveTerminalKeyAction(
        key({ key: 'c', ctrlKey: true }),
        ctx({ sessionType: 'shell', hasSelection: true }),
      );
      expect(action).toEqual({ kind: 'copySelection' });
    });
  });

  it('CA-2 — Ctrl+C SEM seleção em aba claude é noop — nunca passthrough (o coração da dor)', () => {
    const action = resolveTerminalKeyAction(
      key({ key: 'c', ctrlKey: true }),
      ctx({ sessionType: 'claude', hasSelection: false }),
    );
    expect(action).toEqual({ kind: 'noop' });
    expect(action.kind).not.toBe('passthrough');
  });

  it('CA-6 — Ctrl+C SEM seleção em aba shell é passthrough (mantém SIGINT, mata o processo)', () => {
    const action = resolveTerminalKeyAction(
      key({ key: 'c', ctrlKey: true }),
      ctx({ sessionType: 'shell', hasSelection: false }),
    );
    expect(action).toEqual({ kind: 'passthrough' });
  });

  it('CA-4 — Ctrl+V com imagem no clipboard em aba claude vira pasteImage', () => {
    const action = resolveTerminalKeyAction(
      key({ key: 'v', ctrlKey: true }),
      ctx({ sessionType: 'claude', clipboardHasImage: true }),
    );
    expect(action).toEqual({ kind: 'pasteImage' });
  });

  it('fora de escopo (US-C só claude) — Ctrl+V com imagem em aba shell é passthrough, não pasteImage', () => {
    const action = resolveTerminalKeyAction(
      key({ key: 'v', ctrlKey: true }),
      ctx({ sessionType: 'shell', clipboardHasImage: true }),
    );
    expect(action).toEqual({ kind: 'passthrough' });
  });

  it('CA-3 — Ctrl+V sem imagem em aba claude vira pasteText', () => {
    const action = resolveTerminalKeyAction(
      key({ key: 'v', ctrlKey: true }),
      ctx({ sessionType: 'claude', clipboardHasImage: false }),
    );
    expect(action).toEqual({ kind: 'pasteText' });
  });

  it('aba shell — Ctrl+V sem imagem também vira pasteText (colar comando)', () => {
    const action = resolveTerminalKeyAction(
      key({ key: 'v', ctrlKey: true }),
      ctx({ sessionType: 'shell', clipboardHasImage: false }),
    );
    expect(action).toEqual({ kind: 'pasteText' });
  });

  describe('CA-7 — Ctrl+Shift+C / Ctrl+Shift+V continuam no default do Electron (passthrough), nos dois tipos de aba', () => {
    it.each(['claude', 'shell'] as const)('Ctrl+Shift+C em aba %s', (sessionType) => {
      const action = resolveTerminalKeyAction(
        key({ key: 'c', ctrlKey: true, shiftKey: true }),
        ctx({ sessionType, hasSelection: true }),
      );
      expect(action).toEqual({ kind: 'passthrough' });
    });

    it.each(['claude', 'shell'] as const)('Ctrl+Shift+V em aba %s', (sessionType) => {
      const action = resolveTerminalKeyAction(
        key({ key: 'v', ctrlKey: true, shiftKey: true }),
        ctx({ sessionType, clipboardHasImage: true }),
      );
      expect(action).toEqual({ kind: 'passthrough' });
    });
  });

  describe('CA-8 — Alt+V não regride (segue passthrough), nos dois tipos de aba', () => {
    it.each(['claude', 'shell'] as const)('aba %s', (sessionType) => {
      const action = resolveTerminalKeyAction(key({ key: 'v', altKey: true }), ctx({ sessionType, clipboardHasImage: true }));
      expect(action).toEqual({ kind: 'passthrough' });
    });
  });

  it('Ctrl+Alt+V não vira colagem (guard rail de alt/shift/meta corre ANTES de olhar Ctrl+V)', () => {
    const action = resolveTerminalKeyAction(
      key({ key: 'v', ctrlKey: true, altKey: true }),
      ctx({ sessionType: 'claude', clipboardHasImage: true }),
    );
    expect(action).toEqual({ kind: 'passthrough' });
  });

  describe('CA-9/C3 — teclas especiais continuam passthrough, sem código específico, nos dois tipos de aba', () => {
    const specialKeys = ['Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Tab'];

    it.each(specialKeys)('%s em aba claude', (specialKey) => {
      const action = resolveTerminalKeyAction(key({ key: specialKey }), ctx({ sessionType: 'claude' }));
      expect(action).toEqual({ kind: 'passthrough' });
    });

    it.each(specialKeys)('%s em aba shell', (specialKey) => {
      const action = resolveTerminalKeyAction(key({ key: specialKey }), ctx({ sessionType: 'shell' }));
      expect(action).toEqual({ kind: 'passthrough' });
    });
  });

  it('Shift+Tab continua passthrough (regressão CA-9 citada no tasks.md)', () => {
    const action = resolveTerminalKeyAction(key({ key: 'Tab', shiftKey: true }), ctx({ sessionType: 'claude' }));
    expect(action).toEqual({ kind: 'passthrough' });
  });

  describe('keyup/keypress nunca ramificam — só keydown decide (dispararia a ação 2-3x por toque)', () => {
    it('keyup de Ctrl+C com seleção não vira copySelection', () => {
      const action = resolveTerminalKeyAction(
        key({ key: 'c', ctrlKey: true, type: 'keyup' }),
        ctx({ sessionType: 'claude', hasSelection: true }),
      );
      expect(action).toEqual({ kind: 'passthrough' });
    });

    it('keypress de Ctrl+V não vira pasteText', () => {
      const action = resolveTerminalKeyAction(key({ key: 'v', ctrlKey: true, type: 'keypress' }), ctx({ sessionType: 'claude' }));
      expect(action).toEqual({ kind: 'passthrough' });
    });
  });

  it('teclas sem ctrl nem combinação especial descem passthrough (digitação normal)', () => {
    const action = resolveTerminalKeyAction(key({ key: 'a' }), ctx({ sessionType: 'claude' }));
    expect(action).toEqual({ kind: 'passthrough' });
  });

  it('IMAGE_PASTE_SEQUENCE é a sequência provada no SPIKE-1 (ESC v = alt+v, chat:imagePaste no Windows)', () => {
    expect(IMAGE_PASTE_SEQUENCE).toBe('\x1b\x76');
  });
});
