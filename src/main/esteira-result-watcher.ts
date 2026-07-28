import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { EsteiraPhase } from '../shared/devMode';

// T308 (003-modo-dev, Batch A) — CA-6: quando `<fase>-result.json` aparece
// com `status: "success"`, o app fecha a aba e registra o `session-id`. O
// GATILHO é o manifesto em disco, nunca "o processo terminou" — nada aqui lê
// o PTY, só o filesystem. Mesmo padrão de `transcript-watcher.ts`: vigia o
// DIRETÓRIO `handoffs/<card_id>/` (nunca o arquivo — ele nasce só quando a
// skill termina), com retry limitado para o diretório ainda não existir.
//
// Etapa que FALHOU (`status` ≠ "success") não arquiva sozinha — fica aberta
// (CA-6 literal). Reprocessamento (mesmo manifesto reescrito) não duplica
// evento: uma vez emitido, este watcher nunca emite de novo (a fase já foi
// arquivada — quem chama dá `dispose()` e cria um watcher novo se abrir a
// fase de novo).

export interface EsteiraResultEvent {
  readonly cardId: string;
  readonly marcoId: string;
  readonly fase: EsteiraPhase;
  readonly manifestPath: string;
}

export interface EsteiraResultWatcherOptions {
  readonly repoPath: string;
  readonly fase: EsteiraPhase;
  readonly cardId: string;
  /** Metadado só repassado no evento — quem chama já sabe o marco (fanout, CA-14). */
  readonly marcoId: string;
  readonly onArchived: (event: EsteiraResultEvent) => void;
  readonly retryMs?: number;
  readonly maxRetries?: number;
}

export interface EsteiraResultWatcherHandle {
  /** Fecha o `fs.watch` e cancela timers. Idempotente. */
  readonly dispose: () => void;
}

const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRIES = 30;

function manifestFileName(fase: EsteiraPhase): string {
  return `${fase}-result.json`;
}

/** Nunca lança: ausente/ilegível devolve `null` — reprocessado no próximo evento do watch. */
async function readManifestStatus(manifestPath: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as { status?: unknown };
    return typeof parsed.status === 'string' ? parsed.status : null;
  } catch {
    return null;
  }
}

/**
 * Abre o watch e devolve o handle. Nunca lança: qualquer falha de I/O degrada
 * para "sem detecção automática" (a etapa falhou/travou fica visível pelo
 * estado de fase, CA-15 — o arquivamento só não acontece sozinho).
 */
export function watchEsteiraResult(options: EsteiraResultWatcherOptions): EsteiraResultWatcherHandle {
  const { repoPath, fase, cardId, marcoId, onArchived, retryMs = DEFAULT_RETRY_MS, maxRetries = DEFAULT_MAX_RETRIES } = options;

  const handoffsDir = join(repoPath, '.esteira', fase, 'handoffs', cardId);
  const fileName = manifestFileName(fase);
  const manifestPath = join(handoffsDir, fileName);

  let watcher: FSWatcher | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retries = 0;
  let disposed = false;
  let reading = false;
  /** Uma vez arquivado, este watcher nunca emite de novo (evita duplicar em reprocessamento). */
  let emitted = false;

  const dispose = (): void => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    watcher?.close();
    watcher = undefined;
  };

  async function readAndMaybeEmit(): Promise<void> {
    if (disposed || reading || emitted) return;
    reading = true;
    try {
      const status = await readManifestStatus(manifestPath);
      if (disposed || emitted) return;
      if (status !== 'success') return; // ausente, ilegível ou falhou/travou (CA-6): fica aberta

      emitted = true;
      onArchived({ cardId, marcoId, fase, manifestPath });
    } finally {
      reading = false;
    }
  }

  function openWatch(): void {
    if (disposed || watcher) return;
    try {
      watcher = watch(handoffsDir, (_event, changed) => {
        // `changed` vem `null` em alguns cenários do Windows — relê sem filtro (barato: 1 arquivo esperado).
        if (changed && basename(String(changed)) !== fileName) return;
        void readAndMaybeEmit();
      });
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
    if (retries >= maxRetries) return; // desiste da detecção automática; a fase segue visível como "stuck" (CA-15)
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      openWatch();
      if (watcher) void readAndMaybeEmit(); // o manifesto pode ter nascido justamente entre duas tentativas
      else scheduleRetry();
    }, retryMs);
  }

  openWatch();
  // Leitura imediata: o manifesto pode já existir quando o watch abre (retomada do app com etapa concluída no meio-tempo).
  void readAndMaybeEmit();
  if (!watcher) scheduleRetry();

  return { dispose };
}
