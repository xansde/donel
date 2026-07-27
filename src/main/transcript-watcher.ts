import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { contextTokensFromLine } from '../shared/contextWindow';
import { extractCustomTitleFromLine } from '../shared/sessionName';
import { readFileTail, TAIL_READ_BYTES } from './session-indexer';

// T411 (004-nomear-sessoes, Fatia 3) — observa o `.jsonl` de uma sessão VIVA e
// avisa quando o transcript muda o que a UI mostra. É o que faz um `/rename`
// digitado no CLI aparecer na aba em menos de 1 s (CA-4), sem reabrir a sessão
// nem reiniciar o app.
//
// ⚠️ PEÇA COMPARTILHADA com a 006 (contexto consumido) — decisão registrada nos
// dois planos: as duas features leem o MESMO arquivo, na MESMA cauda, no MESMO
// evento. Por isso o payload é um OBJETO desde o nascimento
// (`{ sessionId, customTitle, contextTokens }`) e a regra de emissão é
// "mudou QUALQUER campo", não "mudou o título": o `contextTokens` muda a cada
// turn sem rename nenhum, e um watcher que só olhasse o título seria reescrito
// pela 006 na semana seguinte.
//
// T606 (006) — o `contextTokens` deixou de ser `null` reservado: a mesma
// varredura reversa da cauda devolve os dois campos e para assim que tem ambos.
// Um leitor, um watcher, um canal (antisséptico do T609).
//
// Por que o path é conhecido: o app IMPÕE o id da sessão no spawn
// (`--session-id`, `session-correlation.ts:24-34`), então o nome do `.jsonl` é
// conhecido antes de o CLI subir — não há janela cega no início da sessão.

export interface TranscriptChange {
  readonly sessionId: string;
  /** Último `custom-title` da cauda; `null` quando a sessão não tem nome do CLI. */
  readonly customTitle: string | null;
  /** Soma da última `usage` da cauda (T606/006); `null` quando nunca houve leitura. */
  readonly contextTokens: number | null;
}

export interface TranscriptWatcherOptions {
  readonly sessionId: string;
  /** Path absoluto do `.jsonl`. Pode ainda não existir (o CLI cria na 1ª mensagem). */
  readonly filePath: string;
  readonly onChange: (change: TranscriptChange) => void;
  /** Janela de agrupamento de rajada. ~300 ms: bem dentro do < 1 s do CA-4, e evita reler a cada linha escrita. */
  readonly debounceMs?: number;
  /** Intervalo entre tentativas de abrir o watch quando o diretório ainda não existe. */
  readonly retryMs?: number;
  /** Máximo de tentativas de abrir o watch (default 30 ≈ 30 s com `retryMs` de 1 s). */
  readonly maxRetries?: number;
}

export interface TranscriptWatcherHandle {
  /** Fecha o handle do `fs.watch` e cancela timers. Idempotente. */
  readonly dispose: () => void;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRIES = 30;

/**
 * Abre o watch e devolve o handle. Nunca lança: qualquer falha de I/O degrada
 * para "sem reflexo ao vivo" (a sessão continua funcionando, o nome só demora
 * até a próxima releitura), nunca derruba o processo main.
 *
 * **Vigia o DIRETÓRIO, não o arquivo.** `fs.watch` num path inexistente lança
 * `ENOENT`, e o `.jsonl` só nasce na primeira mensagem da sessão — vigiar o
 * diretório e filtrar pelo nome do arquivo cobre "criado depois" de graça, sem
 * inventar retry para o caso comum. Sobra o caso do DIRETÓRIO também não
 * existir (projeto que nunca abriu sessão): aí sim há um retry limitado.
 */
export function watchTranscript(options: TranscriptWatcherOptions): TranscriptWatcherHandle {
  const {
    sessionId,
    filePath,
    onChange,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    retryMs = DEFAULT_RETRY_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;

  const watchDir = dirname(filePath);
  const fileName = basename(filePath);

  let watcher: FSWatcher | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retries = 0;
  let disposed = false;
  /** Último valor EMITIDO — a comparação é por valor, para não spammar o renderer. */
  let lastEmitted: { customTitle: string | null; contextTokens: number | null } | null = null;
  /** Uma releitura por vez: rajada longa não empilha leituras concorrentes do mesmo arquivo. */
  let reading = false;

  const dispose = (): void => {
    disposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    debounceTimer = undefined;
    retryTimer = undefined;
    watcher?.close();
    watcher = undefined;
  };

  async function readAndMaybeEmit(): Promise<void> {
    if (disposed || reading) return;
    reading = true;
    try {
      const tail = await readTranscriptTail(filePath);
      if (disposed) return;

      // Uma leitura que não achou título NÃO apaga o título já conhecido — pela
      // mesma razão do dirty-check em `resolveSessionName`: ausência de título
      // numa leitura é leitura falha (arquivo travado no meio de uma escrita,
      // apagado, cauda ilegível), não um `/rename`. Sem esta regra, um erro
      // transitório de I/O faria o nome da aba piscar para o fallback.
      //
      // T606 (006) — DECISÃO: a mesma regra vale para o `contextTokens`. Uma
      // cauda sem `usage` é lacuna de leitura (uma linha gigante de
      // `tool_result` empurra a usage para fora dos 64 KB no meio de 35% das
      // sessões — `specs/006-contexto-consumido/medicao-t606.md` §B), não
      // "o contexto voltou a zero". Sem isso o `%` piscaria para `—` no meio de
      // um turno longo, exatamente quando o número mais importa. O `%` cair
      // depois de um `/compact` é caso DIFERENTE: ali existe uma `usage` nova
      // com número menor, e ela é emitida normalmente.
      const next = {
        customTitle: tail.customTitle ?? lastEmitted?.customTitle ?? null,
        contextTokens: tail.contextTokens ?? lastEmitted?.contextTokens ?? null,
      };
      if (!hasChanged(lastEmitted, next)) return;

      lastEmitted = next;
      onChange({ sessionId, ...next });
    } finally {
      reading = false;
    }
  }

  function scheduleRead(): void {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void readAndMaybeEmit();
    }, debounceMs);
  }

  function openWatch(): void {
    if (disposed || watcher) return;
    try {
      watcher = watch(watchDir, (_event, changed) => {
        // `changed` vem `null` em alguns cenários do Windows — nesse caso não há
        // como filtrar, então relê (o debounce e a comparação por valor absorvem).
        if (changed && basename(String(changed)) !== fileName) return;
        scheduleRead();
      });
      // Um erro no watcher (diretório removido debaixo dele) não pode derrubar o
      // main: fecha e tenta reabrir dentro do orçamento de tentativas.
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
        scheduleRetry();
      });
    } catch {
      scheduleRetry();
    }
  }

  function scheduleRetry(): void {
    if (disposed || watcher || retryTimer) return;
    if (retries >= maxRetries) return; // desiste do reflexo ao vivo; a sessão segue normal
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      openWatch();
      // O arquivo pode ter nascido justamente entre duas tentativas.
      if (watcher) scheduleRead();
      else scheduleRetry();
    }, retryMs);
  }

  openWatch();
  // Leitura imediata: sessão RETOMADA já chega com um `custom-title` no
  // arquivo, e o renderer precisa dele sem esperar a próxima escrita.
  void readAndMaybeEmit();

  return { dispose };
}

/**
 * T412 — registro dos watchers vivos, um por aba `claude`. Vive aqui, e não
 * dentro do `main/index.ts`, para o ciclo de vida (o ponto onde um handle vaza)
 * ser testável sem subir o Electron. A chave usada pelo app é o `ptyId`, porque
 * é o `PtyManager.onExit` que dá baixa.
 */
export class TranscriptWatcherRegistry {
  private readonly watchers = new Map<string, TranscriptWatcherHandle>();

  /** `watchFn` injetável só para teste; em produção é o `watchTranscript` real. */
  constructor(private readonly watchFn: (options: TranscriptWatcherOptions) => TranscriptWatcherHandle = watchTranscript) {}

  /** Quantos handles estão abertos agora — a asserção que prova que nada vazou. */
  get size(): number {
    return this.watchers.size;
  }

  /** Abre (substituindo o anterior da mesma chave — reabertura de aba não deixa dois handles no mesmo arquivo). */
  start(key: string, options: TranscriptWatcherOptions): void {
    this.stop(key);
    this.watchers.set(key, this.watchFn(options));
  }

  /** No-op se a chave não tem watcher (aba de terminal livre nunca abriu um). */
  stop(key: string): void {
    const existing = this.watchers.get(key);
    if (!existing) return;
    existing.dispose();
    this.watchers.delete(key);
  }

  /** Fecha todos — usado quando a janela morre e leva os PTYs com ela. */
  disposeAll(): void {
    for (const key of [...this.watchers.keys()]) this.stop(key);
  }
}

function hasChanged(
  previous: { customTitle: string | null; contextTokens: number | null } | null,
  next: { customTitle: string | null; contextTokens: number | null },
): boolean {
  if (previous === null) {
    // Primeira leitura: só vale emitir se houver algo de fato (evita um evento
    // inútil por aba nova, que é o caso mais comum).
    return next.customTitle !== null || next.contextTokens !== null;
  }
  return previous.customTitle !== next.customTitle || previous.contextTokens !== next.contextTokens;
}

export interface TranscriptTail {
  /** Último `custom-title` da cauda; `null` se nenhum. (Consumidor: 004.) */
  readonly customTitle: string | null;
  /** Soma da última `usage` da cauda; `null` se nenhuma. (Consumidor: 006.) */
  readonly contextTokens: number | null;
}

const EMPTY_TAIL: TranscriptTail = { customTitle: null, contextTokens: null };

/**
 * Lê SÓ a cauda — nunca o arquivo inteiro — e devolve os DOIS campos numa
 * passada. Diferente da listagem (`readSessionTailInfo`, T403), aqui não há
 * fallback de varredura completa: o registro que acabou de ser escrito está por
 * definição no fim do arquivo, e varrer 15 MB a cada rajada de escrita numa
 * sessão viva custaria caro para não achar nada novo. Vale para a `usage`
 * também.
 *
 * **Janela: os mesmos 64 KB de `TAIL_READ_BYTES`, sem re-leitura maior.** A
 * regra que o `tasks.md` da 006 traz ("se 8 KB não trouxerem `usage`, re-ler com
 * 64 KB") nasceu antes de a 004 subir a cauda de 8 para 64 KB. Medido em 26/07
 * sobre 313 transcripts reais / 590 MB: 64 KB alcançam a última `usage` em
 * **99,7%** dos casos, e os 0,3% restantes se resolvem no turno seguinte pela
 * regra do "não apaga o que já sabe". Cobrir o pior momento de uma sessão
 * exigiria ~2 MB por rajada (p99) — 30× o custo para um dado que fica obsoleto
 * em segundos. Números e racional em `specs/006-contexto-consumido/medicao-t606.md`.
 *
 * Nunca lança: arquivo ausente, vazio ou ilegível devolve os dois `null`.
 */
export async function readTranscriptTail(filePath: string): Promise<TranscriptTail> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return EMPTY_TAIL; // ainda não existe (ou sumiu) — não é erro
  }

  const tailText = await readFileTail(filePath, size, TAIL_READ_BYTES);
  return tailText === null ? EMPTY_TAIL : extractTranscriptTail(tailText);
}

/**
 * Varredura reversa ÚNICA: o último `custom-title` e a última `usage` da cauda,
 * parando assim que os dois estiverem resolvidos. De trás para frente porque o
 * último registro é o que vale; `null` em cada campo que não apareceu.
 *
 * A primeira linha do chunk costuma estar cortada ao meio (a leitura de cauda
 * não respeita fronteira de linha) — os dois extratores tratam JSON inválido
 * como linha a ignorar, então o corte é o caso normal, não uma exceção.
 */
function extractTranscriptTail(tailText: string): TranscriptTail {
  const lines = tailText.split('\n');
  let customTitle: string | null = null;
  let contextTokens: number | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (customTitle === null) customTitle = extractCustomTitleFromLine(line);
    // `=== null` e não falsy: `0` tokens é leitura VÁLIDA de contexto vazio.
    if (contextTokens === null) contextTokens = contextTokensFromLine(line);
    if (customTitle !== null && contextTokens !== null) break;
  }

  return { customTitle, contextTokens };
}
