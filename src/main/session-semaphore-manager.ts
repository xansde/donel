import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  applyPermissionHeuristic,
  defaultMatchesPermissionPrompt,
  INITIAL_SEMAPHORE_STATE,
  reduceSemaphoreState,
  type SemaphoreEvent,
  type SemaphoreMachineState,
} from './semaphore-state-machine';

// T009 — camada de integração (I/O: servidor HTTP local + Maps + timer de
// heurística) sobre a máquina de estados pura (semaphore-state-machine.ts).
// Não é unit-testada isoladamente (mesmo padrão do PtyManager — a cobertura
// de verdade é a máquina pura + o teste manual documentado no addendum T009
// de specs/001-mvp/spike-t002-resultado.md, que validou o fluxo completo
// hook->HTTP->estado num node-pty real).
//
// "Falha/quota esgotada" (5º estado do FR-010) nasce AQUI, não na máquina
// pura: `onProcessExit` marca `error` quando o exit code é != 0, senão
// `done` — é só quem chama (main/index.ts, via PtyManager.onExit) que sabe o
// exit code real.

export type PublicSemaphoreState = 'working' | 'waiting' | 'permission' | 'error' | 'done';

export interface SemaphoreUpdate {
  readonly ptyId: string;
  readonly state: PublicSemaphoreState;
  /** Epoch ms de quando `state` passou a valer — ui-spec §3 (contador "há Xmin") e FR-010/CA-6 (desempate por idade entre permissões pendentes). */
  readonly stateEnteredAt: number;
}

export interface SessionSemaphoreManagerOptions {
  /** Intervalo do tick da heurística de fallback (spike: "a cada ~500ms"). */
  readonly tickIntervalMs?: number;
  /** Timeout da heurística (spike: "2-3s"), injetável por task/CLAUDE.md. */
  readonly permissionHeuristicTimeoutMs?: number;
  readonly now?: () => number;
  /** Ring buffer recente da sessão (ANSI-stripado) — normalmente `ptyManager.getPreview`. */
  readonly getRecentLines: (ptyId: string) => readonly string[];
}

/** Traduz `hook_event_name` do payload pro tipo de evento da máquina pura — `null` = evento que não nos interessa (o CLI pode disparar outros hooks configurados globalmente pelo usuário, ex. SubagentStop). */
export function mapHookEventName(name: unknown): SemaphoreEvent['type'] | null {
  switch (name) {
    case 'UserPromptSubmit':
      return 'userPromptSubmit';
    case 'PreToolUse':
      return 'preToolUse';
    case 'PostToolUse':
      return 'postToolUse';
    case 'Stop':
      return 'stop';
    case 'Notification':
      return 'notification';
    case 'SessionEnd':
      return 'sessionEnd';
    default:
      return null;
  }
}

export class SessionSemaphoreManager {
  private server: Server | null = null;
  private port = 0;
  /** claude `--session-id`/`-r <id>` (session-correlation.ts) -> ptyId do Donel Dev. */
  private readonly sessionToPty = new Map<string, string>();
  private readonly ptyState = new Map<string, SemaphoreMachineState>();
  /** ptyId cujo processo saiu com exit code != 0 — sobrepõe `done` -> `error` na emissão pública. */
  private readonly erroredPtyIds = new Set<string>();
  private readonly listeners = new Set<(update: SemaphoreUpdate) => void>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private readonly tickIntervalMs: number;
  private readonly permissionHeuristicTimeoutMs: number;
  private readonly now: () => number;
  private readonly getRecentLines: (ptyId: string) => readonly string[];

  constructor(options: SessionSemaphoreManagerOptions) {
    this.tickIntervalMs = options.tickIntervalMs ?? 500;
    this.permissionHeuristicTimeoutMs = options.permissionHeuristicTimeoutMs ?? 2500;
    this.now = options.now ?? Date.now;
    this.getRecentLines = options.getRecentLines;
  }

  /** Sobe o servidor HTTP local (porta efêmera, 127.0.0.1) e o timer da heurística. Devolve a porta pra montar o `--settings` (hooks-settings.ts). */
  async start(): Promise<number> {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.port = await new Promise<number>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error('SessionSemaphoreManager.start chamado sem servidor'));
        return;
      }
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });

    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
    return this.port;
  }

  dispose(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.server?.close();
    this.server = null;
  }

  registerSession(ptyId: string, claudeSessionId: string): void {
    this.sessionToPty.set(claudeSessionId, ptyId);
    this.ptyState.set(ptyId, { ...INITIAL_SEMAPHORE_STATE, stateEnteredAt: this.now() });
    this.emit(ptyId);
  }

  unregisterSession(ptyId: string): void {
    this.ptyState.delete(ptyId);
    this.erroredPtyIds.delete(ptyId);
    for (const [claudeSessionId, mappedPtyId] of this.sessionToPty) {
      if (mappedPtyId === ptyId) this.sessionToPty.delete(claudeSessionId);
    }
  }

  /** `PtyManager.onExit` (evento do SO) — prioridade máxima, spec.md FR-010 "falha/quota esgotada" = exit code != 0. */
  onProcessExit(ptyId: string, exitCode: number): void {
    const current = this.ptyState.get(ptyId) ?? INITIAL_SEMAPHORE_STATE;
    const next = reduceSemaphoreState(current, { type: 'processExit', at: this.now() });
    this.ptyState.set(ptyId, next);
    if (exitCode !== 0) this.erroredPtyIds.add(ptyId);
    this.emit(ptyId);
  }

  onUpdate(listener: (update: SemaphoreUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(ptyId: string): SemaphoreUpdate | undefined {
    const state = this.ptyState.get(ptyId);
    if (!state) return undefined;
    return { ptyId, state: this.publicStateFor(ptyId, state), stateEnteredAt: state.stateEnteredAt };
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });
    req.on('end', () => {
      this.handleHookBody(body);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  }

  private handleHookBody(rawBody: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return; // hook malformado/vazio — nunca derruba o servidor.
    }
    if (typeof payload !== 'object' || payload === null) return;

    const claudeSessionId = (payload as Record<string, unknown>).session_id;
    if (typeof claudeSessionId !== 'string') return;

    const ptyId = this.sessionToPty.get(claudeSessionId);
    if (!ptyId) return; // sessão claude não rastreada por este app (ex.: settings globais do usuário rodando outra sessão em paralelo).

    const eventType = mapHookEventName((payload as Record<string, unknown>).hook_event_name);
    if (!eventType) return;

    const current = this.ptyState.get(ptyId) ?? INITIAL_SEMAPHORE_STATE;
    const next = reduceSemaphoreState(current, { type: eventType, at: this.now() } as SemaphoreEvent);
    this.ptyState.set(ptyId, next);
    this.emit(ptyId);
  }

  private tick(): void {
    const now = this.now();
    for (const [ptyId, current] of this.ptyState) {
      if (current.state !== 'working' || current.pendingToolSince === null) continue;
      const recentLines = this.getRecentLines(ptyId);
      const next = applyPermissionHeuristic(current, now, this.permissionHeuristicTimeoutMs, recentLines, defaultMatchesPermissionPrompt);
      if (next !== current) {
        this.ptyState.set(ptyId, next);
        this.emit(ptyId);
      }
    }
  }

  private publicStateFor(ptyId: string, state: SemaphoreMachineState): PublicSemaphoreState {
    if (state.state === 'done' && this.erroredPtyIds.has(ptyId)) return 'error';
    return state.state;
  }

  private emit(ptyId: string): void {
    const state = this.ptyState.get(ptyId);
    if (!state) return;
    const update: SemaphoreUpdate = { ptyId, state: this.publicStateFor(ptyId, state), stateEnteredAt: state.stateEnteredAt };
    for (const listener of this.listeners) listener(update);
  }
}
