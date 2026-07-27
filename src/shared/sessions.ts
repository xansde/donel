// T013 — tipos IPC do domínio de sessões anteriores (FR-004, plan.md
// "sessions:list") + funções PURAS de apresentação (formatação/filtro) usadas
// pela UI (ui-spec §5). SessionIndexer (src/main/session-indexer.ts, T012,
// TDD já fechado) é quem de fato lê `~/.claude/projects/<slug>/*.jsonl` e
// define a forma real dos dados — este arquivo só espelha o contrato pro
// preload/renderer (mesmo padrão de src/shared/projects.ts pro
// ProjectScanner). Os campos batem 1:1 de propósito com `SessionSummary`
// (session-indexer.ts) — compatibilidade estrutural, sem mapeamento manual
// no handler do main (main/index.ts devolve o array de `indexProjectSessions`
// direto, tipado como `SessionSummaryDto[]`).
//
// Campo "modelo" do ui-spec §5 ("nome ou preview · data relativa · tamanho ·
// modelo") fica DE FORA de propósito: o SessionIndexer (T012, módulo
// congelado — instrução explícita de não reescrever) não extrai qual modelo
// foi usado numa sessão anterior (exigiria parsear mensagens do assistant no
// transcript, fora do escopo desta task). Ver "Não verificado" no dossiê da
// T013.

import type { AppConfigDto } from './config';

export const SESSION_CHANNELS = {
  list: 'sessions:list',
  /** T406 (004-nomear-sessoes) — primeira ESCRITA deste domínio; grava/limpa o nome dado pela UI no ConfigStore. O `.jsonl` do Claude segue somente-leitura (decisão C1). */
  setName: 'sessions:setName',
  /**
   * T705 (007-favoritos-sessoes) — upsert de uma visita no registro (plan.md
   * §Fatia 2). Só o RENDERER chama: é ele quem resolve o `label`
   * (`resolveSessionName`) nos três gatilhos do T707. O `main` valida o
   * payload porque é ele que persiste (mesmo espírito do `setName` acima).
   */
  registerVisit: 'sessions:registerVisit',
  /** T705 — fixar/desfixar a SESSÃO (por `sessionId`, persistido — CA-5), distinto do pin volátil de hoje (`TabState.pinned`, por aba). */
  setPinned: 'sessions:setPinned',
  /** T705/CA-11 — "esquecer" uma entrada órfã (retomar falhou, `.jsonl` sumiu). Canal PRÓPRIO, não reaproveita `setPinned`: desfixar e esquecer são operações diferentes. */
  forget: 'sessions:forget',
  /**
   * T710/CA-11 (2º momento) — esquecer VERIFICADO: o main confere se o
   * `.jsonl` da sessão existe e só remove se NÃO existir. Canal separado do
   * `forget` de propósito — "esquecer porque a sessão sumiu do disco" e
   * "esquecer porque pedi" são decisões diferentes, e misturá-las faria um
   * exit code != 0 por outro motivo (cota, Ctrl+C precoce) apagar uma entrada
   * boa.
   */
  forgetIfOrphan: 'sessions:forgetIfOrphan',
  /** T706/CA-8 — a única leitura de disco desta feature; só roda quando o projeto não tem NENHUMA entrada no registro (guarda dura no main). */
  seedProject: 'sessions:seedProject',
} as const;

/**
 * T412 (004) + T608 (006) — push do `main` quando o transcript de uma sessão
 * VIVA muda o que a UI mostra: o `custom-title` de um `/rename` (004) **e** os
 * tokens de contexto do último turn (006), no MESMO evento, vindos da MESMA
 * leitura de cauda.
 *
 * O nome do canal é `transcript:changed`, e não `sessions:nameChanged` como a
 * task da 004 rascunhou, porque o watcher é **peça compartilhada** com a 006 e é
 * este o nome fixado no plano dela — batizá-lo de "nameChanged" agora obrigaria
 * a 006 a renomear um canal já em uso. Mesma razão do payload ser um objeto.
 */
export const TRANSCRIPT_CHANNELS = {
  changed: 'transcript:changed',
} as const;

export interface TranscriptChangedPayload {
  readonly sessionId: string;
  /** Último `custom-title` do transcript. Uma leitura que não acha título NÃO chega aqui como `null` — ver `transcript-watcher.ts`. */
  readonly customTitle: string | null;
  /**
   * T606 (006) — soma `input + cache_read + cache_creation` da última `usage`
   * do transcript (o tamanho REAL do contexto agora, que cai após um
   * `/compact`). `null` só enquanto nenhuma leitura tiver achado `usage`; uma
   * leitura vazia depois disso NÃO zera o valor conhecido — mesma regra do
   * título, ver `transcript-watcher.ts` e `medicao-t606.md`.
   */
  readonly contextTokens: number | null;
}

export interface SessionSummaryDto {
  /** Session id — nome do arquivo sem `.jsonl` (spec: "nome do arquivo"). */
  readonly id: string;
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly size: number;
  /** Primeira mensagem de usuário genuína (FR-004), ou um dos fallbacks do SessionIndexer ("(sem mensagem de usuário)"/"(ilegível)"). */
  readonly preview: string;
  readonly corrupted: boolean;
  readonly lastActivityAt: number | null;
  /** T403 (004-nomear-sessoes) — último `custom-title` do transcript (nome dado por `/rename` no CLI); null se nunca renomeada. Entra na resolução do nome exibido (`resolveSessionName`, ./sessionName.ts); o `preview` acima continua sendo o fallback. */
  readonly customTitle: string | null;
}

/** API tipada exposta pelo preload em `window.donel.sessions`. */
export interface DonelSessionsApi {
  /** Índice das sessões anteriores do projeto (FR-004, CA-2), ordenado por mtime desc; [] se o projeto nunca abriu sessão ou em erro de disco (SessionIndexer nunca lança). */
  list(projectPath: string): Promise<SessionSummaryDto[]>;
  /**
   * T406 (004) — grava o nome que o usuário digitou para uma sessão `claude`
   * (CA-3/CA-6). `name` vazio (ou só espaços) **apaga** a entrada e o nome
   * volta ao fallback — é a válvula de escape do C5. `seenTitle` é o
   * `custom-title` que a UI estava exibindo no momento da edição: é o que
   * alimenta o dirty-check do C2 depois (um `/rename` posterior no CLI vence).
   * Devolve o config atualizado, no mesmo padrão dos canais `config:set*`.
   */
  setName(sessionId: string, name: string, seenTitle: string | null): Promise<AppConfigDto>;
  /**
   * T412 (004) — assina o push de mudança de transcript das sessões vivas
   * (CA-4). UMA assinatura no nível do App cobre todas as abas: o watcher do
   * `main` observa toda aba `claude` viva e o payload traz o `sessionId`.
   * Devolve a função de cancelamento (mesmo padrão de `pty.onData`).
   */
  onTranscriptChanged(listener: (payload: TranscriptChangedPayload) => void): () => void;
  /** T705 (007) — upsert de uma visita (CA-7/D9). `label` já vem resolvido (`resolveSessionName`) pelo chamador — o main não recalcula. */
  registerVisit(sessionId: string, projectPath: string, label: string): Promise<AppConfigDto>;
  /** T705/CA-5 — fixa/desfixa a SESSÃO, persistido; continua servindo de desempate na lista geral (C2). */
  setPinned(sessionId: string, pinned: boolean): Promise<AppConfigDto>;
  /** T705/CA-11 — esquece uma entrada órfã (nunca falha por sessionId inexistente — no-op). */
  forget(sessionId: string): Promise<AppConfigDto>;
  /** T710/CA-11 — esquece SÓ se o `.jsonl` daquela sessão não existir mais (o main é quem confere o disco). */
  forgetIfOrphan(sessionId: string): Promise<AppConfigDto>;
  /** T706/CA-8 — semeadura única de um projeto sem NENHUMA entrada no registro. */
  seedProject(projectPath: string): Promise<AppConfigDto>;
}

const TAB_NAME_MAX_LENGTH = 40;

/**
 * Nome curto pra aba/dot da barra (ui-spec §2 zona 3) a partir do preview de
 * uma sessão anterior — o preview do índice já vem truncado a
 * `MAX_PREVIEW_LENGTH` (160, session-indexer.ts), mas isso ainda é longo
 * demais pra uma aba.
 */
export function sessionTabName(session: Pick<SessionSummaryDto, 'preview'>): string {
  const trimmed = session.preview.trim();
  if (trimmed.length <= TAB_NAME_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, TAB_NAME_MAX_LENGTH - 1)}…`;
}

/**
 * Busca simples por substring (ui-spec §5: "Busca simples por nome no topo,
 * full-text é P1") — casa contra o preview OU o id da sessão, sem
 * case/acento sensível ao case (acento fica pro P1 de full-text). Query vazia
 * devolve a lista inteira (cópia, nunca a referência original).
 */
export function filterSessionsByQuery(
  sessions: readonly SessionSummaryDto[],
  query: string,
): SessionSummaryDto[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...sessions];
  return sessions.filter(
    (session) => session.preview.toLowerCase().includes(normalized) || session.id.toLowerCase().includes(normalized),
  );
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Data relativa em pt-BR (ui-spec §5: "data relativa") pra uma linha da
 * lista. `nowMs` é injetável pra testar determinístico (default = `Date.now()`
 * no ponto de chamada real). Timestamps futuros (relógio do sistema girou,
 * ou `lastActivityAt` levemente à frente de `mtimeMs`) são tratados como
 * "agora" em vez de um valor negativo sem sentido pro usuário.
 */
export function formatRelativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const diffMs = Math.max(0, nowMs - timestampMs);

  if (diffMs < MINUTE_MS) return 'agora';
  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return `há ${minutes} min`;
  }
  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return `há ${hours}h`;
  }

  const days = Math.floor(diffMs / DAY_MS);
  if (days < 30) return `há ${days} dia${days === 1 ? '' : 's'}`;

  const months = Math.floor(days / 30);
  if (months < 12) return `há ${months} ${months === 1 ? 'mês' : 'meses'}`;

  const years = Math.floor(months / 12);
  return `há ${years} ${years === 1 ? 'ano' : 'anos'}`;
}

const SIZE_UNITS = ['KB', 'MB', 'GB'] as const;

/** Tamanho legível (ui-spec §5: "tamanho") a partir dos bytes do SessionIndexer (`stat().size`). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${SIZE_UNITS[unitIndex]}`;
}
