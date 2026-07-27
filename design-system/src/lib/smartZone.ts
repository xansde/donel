/**
 * Smart zone — regras compartilhadas do medidor de contexto (~400k tokens).
 * Fonte: design-system.md §2 "Smart zone" e §6 "Medidor smart zone".
 * Centralizado aqui porque três componentes consomem a mesma faixa de
 * cor: SmartZoneMeter, o anel do StateDot e o mini medidor do StatusBar.
 */

export type SmartZone = 'ok' | 'warn' | 'over';

export const DEFAULT_MAX_TOKENS = 400_000;

/** 0–70% = ok · 70–100% = warn · >100% = over. */
export function getSmartZone(usedTokens: number, maxTokens: number = DEFAULT_MAX_TOKENS): SmartZone {
  const percent = maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0;
  if (percent > 100) return 'over';
  if (percent >= 70) return 'warn';
  return 'ok';
}

/** Formata tokens no formato compacto usado em toda a UI: "312k/400k". */
export function formatTokenCount(tokens: number): string {
  const rounded = Math.round(tokens / 1000);
  return `${rounded}k`;
}

export function formatSmartZoneLabel(usedTokens: number, maxTokens: number = DEFAULT_MAX_TOKENS): string {
  return `${formatTokenCount(usedTokens)}/${formatTokenCount(maxTokens)}`;
}

/** Mapa de zona -> custom property de cor, para uso direto em CSS inline. */
export const SMART_ZONE_COLOR_VAR: Record<SmartZone, string> = {
  ok: 'var(--zone-ok)',
  warn: 'var(--zone-warn)',
  over: 'var(--zone-over)',
};
