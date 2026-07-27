// FIX (feedback E2E rodada 5) — statusbar mostra a conta de NASCIMENTO da
// sessão em foco, não a conta ATIVA global (ver comentário de topo de
// src/shared/sessionAccountLabel.ts pra causa raiz completa).
// T204 (002-quota-headroom) — 3º parâmetro passou de `number|null` pro shape
// `ProfileQuota|null`. T208: o rótulo agora explicita "5h" antes do percentual
// (CA-4) — "—" continua "—" (nunca "5h —") quando não há leitura.
import { describe, expect, it } from 'vitest';
import type { ProfileQuota } from '../src/shared/profiles';
import { computeSessionAccountLabel } from '../src/shared/sessionAccountLabel';

const quotaWithFiveHour = (percentRemaining: number): ProfileQuota => ({
  status: 'ok',
  fiveHour: { percentRemaining, resetsAt: null },
  sevenDay: null,
  fable: null,
});

describe('computeSessionAccountLabel', () => {
  it('aba claude com perfil resolvido fora da convenção "Tecnologia Claude {n}" mostra o nome cru prefixado + cota', () => {
    const label = computeSessionAccountLabel(
      { sessionType: 'claude', profile: { slug: 'principal', name: 'Principal' } },
      'FALLBACK_NAO_USADO',
      quotaWithFiveHour(62),
    );
    expect(label).toBe('Sessão: Principal · 5h 62%');
  });

  it('aba claude com perfil no formato "Tecnologia Claude {n}" normaliza via parseAccountNumber + cota', () => {
    const label = computeSessionAccountLabel(
      { sessionType: 'claude', profile: { slug: 'tecnologia-claude-3', name: 'Tecnologia Claude 3' } },
      'FALLBACK_NAO_USADO',
      quotaWithFiveHour(45),
    );
    expect(label).toBe('Sessão: Tecnologia Claude 3 · 5h 45%');
  });

  it('aba claude com perfil de teste (nome arbitrário) e quota unavailable (sem fiveHour) mostra o nome cru prefixado + —', () => {
    const label = computeSessionAccountLabel(
      { sessionType: 'claude', profile: { slug: 'e2e-profile-test', name: 'e2e-profile-test' } },
      'FALLBACK_NAO_USADO',
      { status: 'unavailable', fiveHour: null, sevenDay: null, fable: null },
    );
    expect(label).toBe('Sessão: e2e-profile-test · —');
  });

  // FIX (auditoria rodada 5, achado alta "regressão de cota") — trava a
  // PRESENÇA da cota mesmo quando quem chama omite o 3º argumento (default
  // `null` -> '—'), pra nunca mais o slot sumir silenciosamente do rótulo.
  it('cota omitida (default) cai em "—" — nunca omite o slot inteiro', () => {
    const label = computeSessionAccountLabel(
      { sessionType: 'claude', profile: { slug: 'principal', name: 'Principal' } },
      'FALLBACK_NAO_USADO',
    );
    expect(label).toBe('Sessão: Principal · —');
  });

  it('quota ok mas sem fiveHour (só sevenDay) cai em "—" — o rótulo não faz fallback pra semanal', () => {
    const label = computeSessionAccountLabel(
      { sessionType: 'claude', profile: { slug: 'principal', name: 'Principal' } },
      'FALLBACK_NAO_USADO',
      { status: 'ok', fiveHour: null, sevenDay: { percentRemaining: 80, resetsAt: null }, fable: null },
    );
    expect(label).toBe('Sessão: Principal · —');
  });

  it('aba claude AINDA sem perfil resolvido (janela curta até pty:create responder) cai no fallback global, ignorando o parâmetro de cota', () => {
    const label = computeSessionAccountLabel(
      { sessionType: 'claude', profile: undefined },
      'Tecnologia Claude 3 · 62%',
      quotaWithFiveHour(99),
    );
    expect(label).toBe('Tecnologia Claude 3 · 62%');
  });

  it('aba shell (terminal livre) sempre mostra o rótulo neutro, mesmo com perfil e cota presentes', () => {
    const label = computeSessionAccountLabel(
      { sessionType: 'shell', profile: { slug: 'principal', name: 'Principal' } },
      'FALLBACK_NAO_USADO',
      quotaWithFiveHour(62),
    );
    expect(label).toBe('Terminal (sem conta)');
  });

  it('aba shell sem perfil também mostra o rótulo neutro', () => {
    const label = computeSessionAccountLabel({ sessionType: 'shell', profile: undefined }, 'FALLBACK_NAO_USADO');
    expect(label).toBe('Terminal (sem conta)');
  });
});
