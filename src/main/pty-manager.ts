import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';
import { appendToRingBuffer } from './ring-buffer';

// PtyManager (main process) — plan.md "Arquitetura de processos" + ponto 8.
// Responsável por spawn/kill/resize de PTYs via node-pty (ConPTY no Windows),
// batching do output (~16ms, plan.md linha 39) e um ring buffer de ~50 linhas
// (ANSI stripado) por PTY para o hover-preview de sessões (chega em T007+;
// aqui só o mecanismo fica pronto, exposto via IPC sob demanda).

const BATCH_INTERVAL_MS = 16;
const RING_BUFFER_LINES = 50;

interface PtyRecord {
  id: string;
  pty: IPty;
  pendingChunks: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  ringBuffer: string[];
  /** Cauda ainda sem quebra de linha (bytes crus, ANSI stripado só ao fechar a linha). */
  rawTail: string;
}

export interface PtyCreateOptions {
  cols: number;
  rows: number;
  cwd?: string;
  /**
   * Comando/args explícitos (T005 — sessão claude direta no PTY). Omitido =
   * comportamento original do T004 (terminal livre, `FREE_TERMINAL_SHELL`).
   * PtyManager é agnóstico ao domínio ("claude" vs "shell") — quem resolve o
   * executável e decide o que spawnar é o chamador (main/index.ts).
   */
  command?: string;
  args?: string[];
  /**
   * T014 (FR-005/CA-3) — `CLAUDE_CONFIG_DIR` do perfil ativo no momento em
   * que a aba nasceu; `undefined` = perfil Principal (sem override, env
   * herdado tal qual). PtyManager não sabe o que é um "perfil" — só aplica a
   * env var; quem resolve o perfil ativo é o chamador (main/index.ts).
   * Passado por VALOR na criação: trocar de perfil depois não afeta abas já
   * abertas (FR-005 — "trocar de perfil afeta apenas sessões novas").
   */
  claudeConfigDir?: string;
}

/**
 * Puro — env efetivo do processo do PTY: copia `baseEnv` e seta/remove
 * `CLAUDE_CONFIG_DIR` conforme `claudeConfigDir` (nunca deixa vazar um valor
 * herdado do processo do próprio Electron, se por algum motivo já viesse
 * setado em `baseEnv`). Nunca mexe em mais nada do env (plan.md ponto 2 —
 * nunca sobrescrever PATH).
 */
/**
 * Marcadores que o Claude Code seta nos processos que ELE lança. Se o app foi
 * aberto de dentro de uma sessão do Claude Code (dev server, terminal com
 * claude rodando), herdá-los faz o CLI das nossas abas abrir como "sessão
 * filha" — transcript saving off, permission mode herdado (achado do teste
 * manual de 27/07). As sessões que o app cria são sempre sessões RAIZ.
 * Lista explícita de propósito: nunca varrer `CLAUDE_*` inteiro (mataria
 * config legítima do usuário, ex. CLAUDE_CONFIG_DIR do perfil).
 */
const INHERITED_CLAUDE_SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
] as const;

export function buildPtyEnv(baseEnv: NodeJS.ProcessEnv, claudeConfigDir: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  for (const marker of INHERITED_CLAUDE_SESSION_MARKERS) {
    delete env[marker];
  }
  if (claudeConfigDir) {
    env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
}

export type PtyDataListener = (ptyId: string, data: string) => void;
export type PtyExitListener = (ptyId: string, exitCode: number, signal?: number) => void;

/** Shell da aba de terminal livre (FR-008): PowerShell sem banner de logo. */
const FREE_TERMINAL_SHELL = 'powershell.exe';
const FREE_TERMINAL_ARGS = ['-NoLogo'];

/**
 * Mensagem de falha de spawn com diagnóstico acionável (pura, testável).
 * Cobre as três causas vistas em máquina genérica: comando que não existe,
 * `cwd` que não existe, e o addon do node-pty compilado pra ABI errada
 * (`npm install` interrompido ou rodado com `--ignore-scripts`).
 */
export function buildSpawnFailureMessage(command: string, cwd: string | undefined, error: unknown): string {
  const original = error instanceof Error ? error.message : String(error);
  const hints = [
    `não consegui iniciar "${command}"`,
    cwd ? `(pasta de trabalho: ${cwd})` : null,
    `— ${original}.`,
    'Confira: o comando existe nessa máquina? A pasta de trabalho ainda existe?',
    'Se NENHUM terminal abre (nem o shell livre), o node-pty não compilou — rode `npm install` de novo no repositório do app.',
  ].filter(Boolean);
  return hints.join(' ');
}

export class PtyManager {
  private readonly ptys = new Map<string, PtyRecord>();
  private readonly dataListeners = new Set<PtyDataListener>();
  private readonly exitListeners = new Set<PtyExitListener>();

  onData(listener: PtyDataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: PtyExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  create(options: PtyCreateOptions): string {
    const id = randomUUID();
    const command = options.command ?? FREE_TERMINAL_SHELL;
    const args = options.args ?? FREE_TERMINAL_ARGS;
    // Env herdado sem alteração (plan.md ponto 2 — nunca sobrescrever PATH;
    // gotcha do atalho do Desktop que resolve o `claude.exe`/MCPs stdio),
    // exceto `CLAUDE_CONFIG_DIR` quando a aba nasceu sob um perfil não-
    // Principal (T014, buildPtyEnv acima).
    //
    // FIX ambiente genérico (28/07, teste do colega) — o spawn do node-pty
    // lança SÍNCRONO (comando inexistente, cwd inválido, addon com ABI
    // errada) e a exceção crua atravessava o IPC embrulhada pelo Electron:
    // a aba nascia morta com uma mensagem inescrutável (ou nenhuma). O
    // renderer já mostra qualquer rejeição no terminal (TerminalPane, catch
    // genérico) — daqui sai uma mensagem que diz O QUE tentar.
    let ptyProcess: IPty;
    try {
      ptyProcess = spawn(command, args, {
        name: 'xterm-color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd ?? os.homedir(),
        env: buildPtyEnv(process.env, options.claudeConfigDir),
      });
    } catch (error) {
      throw new Error(buildSpawnFailureMessage(command, options.cwd, error));
    }

    const record: PtyRecord = {
      id,
      pty: ptyProcess,
      pendingChunks: [],
      flushTimer: null,
      ringBuffer: [],
      rawTail: '',
    };
    this.ptys.set(id, record);

    ptyProcess.onData((chunk) => {
      record.pendingChunks.push(chunk);
      const next = appendToRingBuffer({ ringBuffer: record.ringBuffer, rawTail: record.rawTail }, chunk, RING_BUFFER_LINES);
      record.ringBuffer = next.ringBuffer;
      record.rawTail = next.rawTail;
      this.scheduleFlush(record);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      if (record.flushTimer) clearTimeout(record.flushTimer);
      this.flush(record);
      this.ptys.delete(id);
      for (const listener of this.exitListeners) listener(id, exitCode, signal);
    });

    return id;
  }

  input(id: string, data: string): void {
    this.ptys.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    this.ptys.get(id)?.pty.resize(cols, rows);
  }

  kill(id: string): void {
    const record = this.ptys.get(id);
    if (!record) return;
    if (record.flushTimer) clearTimeout(record.flushTimer);
    record.pty.kill();
    this.ptys.delete(id);
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }

  getPreview(id: string): string[] {
    return this.ptys.get(id)?.ringBuffer.slice(-RING_BUFFER_LINES) ?? [];
  }

  private scheduleFlush(record: PtyRecord): void {
    if (record.flushTimer) return;
    record.flushTimer = setTimeout(() => {
      record.flushTimer = null;
      this.flush(record);
    }, BATCH_INTERVAL_MS);
  }

  private flush(record: PtyRecord): void {
    if (record.pendingChunks.length === 0) return;
    const data = record.pendingChunks.join('');
    record.pendingChunks = [];
    for (const listener of this.dataListeners) listener(record.id, data);
  }
}
