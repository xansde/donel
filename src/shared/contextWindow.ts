// T601–T604 (006-contexto-consumido, Fatia 0) — núcleo puro do indicador de
// contexto consumido: tabela de janelas por modelo, soma da `usage` e o `%`
// exibido na toolbar da sessão.
//
// Módulo isolado de propósito: sem Electron, sem fs, sem React. É o ÚNICO
// arquivo a revisitar quando a Anthropic mudar tamanhos de janela — daí a
// tabela viver aqui e não espalhada por quem exibe o número.

import type { ModelAlias } from './commandBuilder';

/**
 * Janela de contexto (`max_input_tokens`) de cada `ModelAlias`.
 *
 * ⚠️ CONFERIDA na skill `claude-api` em **2026-07-24** — não editar de memória.
 * Proveniência e os model IDs correspondentes em
 * `specs/006-contexto-consumido/spec.md` §"[S1/C2] Tabela … FIXADA".
 *
 * `Record<ModelAlias, number>` (não `Partial`) de propósito: o typecheck é o
 * que garante que um alias novo em `commandBuilder.ts` não passe sem janela.
 */
export const MODEL_CONTEXT_WINDOWS: Record<ModelAlias, number> = {
  fable: 1_000_000, // claude-fable-5
  opus: 1_000_000, // claude-opus-5
  sonnet: 1_000_000, // claude-sonnet-5
  haiku: 200_000, // claude-haiku-4-5
};

/**
 * Zona de trabalho efetiva — decisão do Alexandre em 2026-07-24, e o
 * DENOMINADOR do `%` exibido.
 *
 * NÃO é limite de API e NÃO é o gatilho de auto-compact do Claude Code: é a
 * régua dele de "até aqui a sessão rende bem". Com a janela bruta de 1M, 135k
 * apareceriam como 13% — tecnicamente certo e praticamente inútil; com a zona,
 * 45%, e a faixa 0–100% cobre o intervalo em que ele decide "continuo ou abro
 * sessão nova". Se ele recalibrar, é esta linha (constante no código, não
 * configuração — decisão de 24/07 para não inflar o escopo).
 */
export const SMART_ZONE_TOKENS = 300_000;

const KNOWN_ALIASES = Object.keys(MODEL_CONTEXT_WINDOWS) as ModelAlias[];

/**
 * `min(smart zone, janela do modelo)`.
 *
 * O `min` não é decoração: uma zona de 300k num modelo de janela 200k seria
 * mentira — a sessão morre na janela antes de chegar ao fim da zona. Em `haiku`
 * a régua é a janela real (200k).
 */
export function effectiveContextZone(model: ModelAlias): number {
  return Math.min(SMART_ZONE_TOKENS, MODEL_CONTEXT_WINDOWS[model]);
}

/**
 * Normaliza um alias vindo de argv/config (que pode ter sido editado à mão)
 * para um `ModelAlias`, ou `null` se não for reconhecível.
 *
 * Faz strip de sufixo de deployment entre colchetes (`opus[1m]` → `opus`):
 * `[1m]` nunca foi model ID público — era o marcador de "contexto de 1M" de
 * quando o default era 200k, e hoje é redundante porque em opus/sonnet/fable 1M
 * já é default *e* máximo. Alias desconhecido devolve `null` em vez de um
 * palpite: quem chama exibe `—`, nunca uma janela chutada.
 */
export function normalizeModelAlias(raw: string): ModelAlias | null {
  if (typeof raw !== 'string') return null;

  const candidate = raw
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .trim();

  return (KNOWN_ALIASES as readonly string[]).includes(candidate) ? (candidate as ModelAlias) : null;
}

/** Os três campos da `usage` que compõem o contexto de ENTRADA do turn (C1). */
const CONTEXT_USAGE_FIELDS = [
  'input_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/**
 * Tamanho do contexto no turn (CA-2 / decisão C1): `input_tokens +
 * cache_read_input_tokens + cache_creation_input_tokens` da `usage`.
 *
 * `output_tokens` **não entra** — é geração, não contexto de entrada.
 *
 * Campo ausente conta 0, mas uma `usage` sem NENHUM dos três devolve `null`, e
 * não `0`: é a diferença entre "o contexto está vazio" e "não há leitura", e o
 * CA-4 exige que o segundo caso apareça como `—` na tela. A entrada é `unknown`
 * porque vem de `JSON.parse` — valida sem nunca lançar.
 */
export function contextTokensFromUsage(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return null;

  const record = usage as Record<string, unknown>;
  let total = 0;
  let sawAnyField = false;

  for (const field of CONTEXT_USAGE_FIELDS) {
    const value = record[field];
    // Tipo errado (string, null, objeto) é IGNORADO em vez de virar NaN e
    // contaminar a soma inteira — um campo corrompido não deve apagar os outros.
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    total += value;
    sawAnyField = true;
  }

  return sawAnyField ? total : null;
}

/**
 * Uma linha do `.jsonl` → tokens de contexto daquele turn, ou `null` se a linha
 * não é um turno de assistant com `usage` utilizável.
 *
 * Existe separada de `contextTokensFromUsage` pela mesma razão que
 * `extractCustomTitleFromLine` existe em `sessionName.ts`: a varredura reversa
 * da cauda (`transcript-watcher.ts`) percorre linha a linha e não pode ter uma
 * segunda cópia da regra de parsing. É aqui que os nomes dos campos da `usage`
 * ficam confinados (antisséptico do T609).
 *
 * **A `usage` fica em `message.usage`**, não no topo da linha — conferido num
 * transcript real em 26/07 (`specs/006-contexto-consumido/medicao-t606.md`); o
 * fragmento `"usage":{…}` da spec é um recorte.
 *
 * `isSidechain: true` é descartado: turno de subagente tem contexto PRÓPRIO e
 * mostrá-lo como se fosse o da sessão faria o `%` despencar sem motivo. Zero
 * ocorrências em 319 transcripts desta máquina — o filtro é seguro contra uma
 * mudança futura do CLI, não conserto de um problema observado.
 *
 * Nunca lança: a cauda começa no meio de uma linha, então JSON inválido é o
 * caso NORMAL da primeira linha lida, não uma exceção.
 */
export function contextTokensFromLine(line: string): number | null {
  const raw = typeof line === 'string' ? line.trim() : '';
  if (!raw || raw[0] !== '{') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { type?: unknown; isSidechain?: unknown; message?: unknown };
  if (record.type !== 'assistant') return null;
  if (record.isSidechain === true) return null;
  if (typeof record.message !== 'object' || record.message === null) return null;

  return contextTokensFromUsage((record.message as { usage?: unknown }).usage);
}

/**
 * `%` da smart zone consumido, arredondado para inteiro.
 *
 * ⚠️ **SEM TETO, por decisão explícita (CA-8, revisada em 24/07).** Não
 * transformar em `Math.min(100, …)`: travar em 100% tornaria 305k e 700k
 * indistinguíveis, que é exatamente a visibilidade que esta feature existe para
 * dar. Passar da zona é legítimo e informativo — 380k em opus mostra `127%`.
 * Há piso em 0 (nunca negativo).
 *
 * `tokens === null` → `null` (CA-4: `—`, nunca `0%`). Alias desconhecido →
 * `null` pela mesma razão de `normalizeModelAlias`.
 */
export function computeContextPercent(tokens: number | null, model: string): number | null {
  if (tokens === null || typeof tokens !== 'number' || !Number.isFinite(tokens)) return null;

  const alias = normalizeModelAlias(model);
  if (alias === null) return null;

  return Math.max(0, Math.round((tokens / effectiveContextZone(alias)) * 100));
}

/**
 * CA-9: o número muda para o tom de alerta quando passa da smart zone.
 *
 * O gatilho é **`> 100`**, não `>= 100`: exatamente 100% é o limite da zona
 * ainda cumprido, não um estouro. Sem leitura (`null`) não há alerta — `—` é
 * ausência de informação, não problema.
 */
export function isOverSmartZone(percent: number | null): boolean {
  return percent !== null && percent > 100;
}

/**
 * Tooltip do indicador (CA-7): mostra a zona usada como denominador **e** a
 * janela real do modelo ao lado — o número da zona nunca deve esconder a
 * verdade técnica ("300k" é régua dele, "1M" é o fato da API).
 *
 * Sem leitura (ou alias desconhecido) → string vazia, coerente com o `—`
 * exibido: melhor nenhum tooltip que um tooltip com números inventados.
 */
export function formatContextTooltip(tokens: number | null, model: string): string {
  if (tokens === null || typeof tokens !== 'number' || !Number.isFinite(tokens)) return '';

  const alias = normalizeModelAlias(model);
  if (alias === null) return '';

  const zone = effectiveContextZone(alias);
  const window = MODEL_CONTEXT_WINDOWS[alias];
  return `${ptBr(tokens)} / ${ptBr(zone)} tokens da smart zone · janela ${alias} ${ptBr(window)}`;
}

function ptBr(value: number): string {
  return value.toLocaleString('pt-BR');
}
