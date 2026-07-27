// FIX (auditoria rodada 5, achado baixa — Fix 1 sem cobertura de unidade).
import { describe, expect, it } from 'vitest';
import { isTrustDialogVisible } from '../src/shared/trustDialog';

describe('isTrustDialogVisible', () => {
  it('detecta o diálogo quando as duas linhas do rodapé estão presentes (qualquer posição)', () => {
    const lines = [
      ' Quick safety check: Is this a project you created or one you trust?',
      ' ❯ 1. Yes, I trust this folder',
      '   2. No, exit',
      ' Enter to confirm · Esc to cancel ',
    ];
    expect(isTrustDialogVisible(lines)).toBe(true);
  });

  it('NÃO detecta com só a primeira linha pintada (achado alta original — diálogo ainda desenhando)', () => {
    const lines = [' Quick safety check: Is this a project you created or one you trust?', ' ❯ 1. Yes, I trust this folder'];
    expect(isTrustDialogVisible(lines)).toBe(false);
  });

  it('NÃO detecta texto digitado pelo usuário citando "trust this folder" sem o resto da assinatura (achado media — janela sem SessionStart)', () => {
    const lines = ['> por que aparece o trust this folder na aba boot?'];
    expect(isTrustDialogVisible(lines)).toBe(false);
  });

  it('NÃO detecta buffer vazio', () => {
    expect(isTrustDialogVisible([])).toBe(false);
  });

  it('detecta mesmo com as duas linhas fora de ordem entre si', () => {
    const lines = [' Enter to confirm · Esc to cancel ', '   2. No, exit'];
    expect(isTrustDialogVisible(lines)).toBe(true);
  });
});
