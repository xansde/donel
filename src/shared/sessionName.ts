// T401 (004-nomear-sessoes, Fatia 0) — resolução do nome exibido de uma
// sessão. É o coração da feature: duas fontes podem nomear a mesma sessão e
// elas não podem competir (CA-5, US-D).
//
//   1. o `/rename` do CLI, que grava no próprio `.jsonl` do transcript
//      {"type":"custom-title","customTitle":"…","sessionId":"…"} — pode
//      aparecer VÁRIAS vezes no arquivo, e o ÚLTIMO vence;
//   2. o nome digitado na UI do Donel, persistido no ConfigStore
//      (`sessionNames`, T402). O app NUNCA escreve no `.jsonl` (decisão C1) —
//      o transcript é somente leitura para o Donel.
//
// A precedência é por *dirty-check* (decisão C2), não por timestamp: o
// registro `custom-title` não carrega hora, e comparar `mtime` do `.jsonl`
// faria qualquer mensagem nova reverter um rename recém-feito pela UI.
//
// Módulo puro de propósito: sem Electron, sem disco, sem PTY.

/** Entrada do mapa `sessionNames` do ConfigStore (T402): o nome que a UI gravou e o `custom-title` que existia naquele momento. */
export interface StoredSessionName {
  readonly name: string;
  /** `custom-title` do `.jsonl` no instante em que a UI gravou o nome (pode ser `null` — sessão nunca renomeada pelo CLI). */
  readonly seenTitle: string | null;
  /** ISO-8601. Só para diagnóstico/ordenação futura — a precedência NÃO usa tempo. */
  readonly updatedAt: string;
}

export interface ResolveSessionNameInput {
  /** Comportamento de hoje: nome do projeto (sessão nova) ou `sessionTabName(preview)` (sessão reaberta). */
  readonly fallback: string;
  /** Último `custom-title` lido do `.jsonl`, ou `null` se não há (ou se não deu para ler). */
  readonly customTitle: string | null;
  /** Entrada do ConfigStore para esta sessão, ou `null`. */
  readonly stored: StoredSessionName | null;
}

const CUSTOM_TITLE_TYPE = 'custom-title';

/** Decisão C5 do clarify. A aba é estreita; o dado é cortado aqui e a UI ainda trunca com ellipsis. */
export const SESSION_NAME_MAX_LENGTH = 60;

/**
 * T406 — normaliza um nome digitado na UI segundo o C5: `trim`, quebras de
 * linha (e tabs) viram um espaço, corte em 60 caracteres. Devolve `null`
 * quando não sobra nada — e `null` significa **apagar o nome**, a válvula de
 * escape do C5 para voltar ao fallback (nome do projeto / 1ª mensagem).
 *
 * Vive no `shared` porque as duas pontas precisam da MESMA regra: a UI valida
 * para dar feedback imediato, o `main` valida porque é ele quem persiste
 * (nunca confiar só na validação do renderer). Tolera valor não-string —
 * um IPC malformado não deve derrubar o handler.
 */
export function normalizeSessionName(raw: string): string | null {
  if (typeof raw !== 'string') return null;

  const singleLine = raw.replace(/[\r\n\t]+/g, ' ').trim();
  if (!singleLine) return null;

  const cut = singleLine.length > SESSION_NAME_MAX_LENGTH ? singleLine.slice(0, SESSION_NAME_MAX_LENGTH) : singleLine;
  const trimmed = cut.trim();
  return trimmed || null;
}

/**
 * Último `custom-title` de um trecho de JSONL, ou `null`.
 *
 * Recebe a CAUDA do arquivo (o indexer lê só os últimos 8 KB — T403), então a
 * primeira linha costuma estar cortada ao meio: linhas que não parseiam são
 * simplesmente ignoradas, o que cobre tanto o corte quanto lixo/JSON inválido.
 * Varre de trás para frente porque o último registro é o que vale.
 *
 * Um registro sem `customTitle`, com `customTitle` não-string ou vazio depois
 * do trim é tratado como inválido e a varredura CONTINUA para trás — um
 * registro malformado no fim do arquivo não apaga um nome legítimo anterior.
 */
export function extractCustomTitle(tailText: string): string | null {
  if (!tailText) return null;

  const lines = tailText.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const title = extractCustomTitleFromLine(lines[index]);
    if (title !== null) return title;
  }

  return null;
}

/**
 * Uma linha JSONL → título, ou `null` se a linha não é um `custom-title`
 * válido. Existe separada para a varredura por streaming do indexer (T403),
 * que percorre o arquivo linha a linha e não pode ter uma segunda cópia da
 * regra de parsing.
 */
export function extractCustomTitleFromLine(line: string): string | null {
  const raw = line.trim();
  if (!raw || raw[0] !== '{') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // linha cortada pela leitura de cauda, ou linha corrompida
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { type?: unknown; customTitle?: unknown };
  if (record.type !== CUSTOM_TITLE_TYPE) return null;
  if (typeof record.customTitle !== 'string') return null;

  const title = record.customTitle.trim();
  return title || null;
}

/**
 * Nome exibido na aba e na sidebar — função ÚNICA de resolução (CA-5), para
 * os dois lugares mostrarem sempre o mesmo valor.
 *
 * Regra (C2):
 * - sem entrada no store → `customTitle ?? fallback` (CA-1 / CA-2);
 * - com entrada e `seenTitle === customTitle` → nada novo veio do CLI, vence a UI;
 * - com entrada e `customTitle` DIFERENTE e não-nulo → houve `/rename` depois, vence o CLI.
 *
 * Nota sobre um caso que o plano não distinguiu: `customTitle === null` com
 * `seenTitle` preenchido significa que o título SUMIU da leitura — transcript
 * ilegível, apagado ou fora da janela lida. Isso não é um `/rename`, então
 * NÃO se deixa o CLI vencer: apagar o nome do usuário por causa de uma leitura
 * que falhou seria perda de dado sem ação dele. Mantém-se o nome da UI.
 */
export function resolveSessionName({ fallback, customTitle, stored }: ResolveSessionNameInput): string {
  if (stored && !cliWins(stored, customTitle)) {
    const name = stored.name.trim();
    if (name) return name;
  }
  return customTitle ?? fallback;
}

/**
 * Entrada que deve permanecer no ConfigStore depois de olhar o `custom-title`
 * atual: a própria entrada, ou `null` quando ela deve ser descartada (caso
 * CLI-vence). É o que impede o storage de acumular nomes mortos.
 */
export function reconcileStoredName(
  stored: StoredSessionName | null,
  customTitle: string | null,
): StoredSessionName | null {
  if (!stored) return null;
  return cliWins(stored, customTitle) ? null : stored;
}

function cliWins(stored: StoredSessionName, customTitle: string | null): boolean {
  return customTitle !== null && customTitle !== stored.seenTitle;
}
