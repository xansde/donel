import { describe, expect, it } from 'vitest';
import { buildPtyEnv, PtyManager } from '../src/main/pty-manager';

// T005 — caso (c) do dossiê de verificação: um processo que sai rápido deve
// disparar `onExit` (é o mesmo sinal que o TerminalPane usa pra mostrar o
// estado "sessão encerrada", FR-006). Usa `cmd.exe /c exit` como dummy —
// não precisa abrir uma sessão claude real pra validar o mecanismo de saída
// do PtyManager, que é agnóstico ao comando spawnado.

describe('PtyManager — ciclo de vida de um processo que sai sozinho', () => {
  it('dispara onExit quando o processo dummy termina (cmd.exe /c exit)', async () => {
    const manager = new PtyManager();

    const exitPromise = new Promise<{ ptyId: string; exitCode: number }>((resolve) => {
      manager.onExit((ptyId, exitCode) => resolve({ ptyId, exitCode }));
    });

    const ptyId = manager.create({ cols: 80, rows: 24, command: 'cmd.exe', args: ['/c', 'exit'] });

    const result = await exitPromise;

    expect(result.ptyId).toBe(ptyId);
    expect(result.exitCode).toBe(0);
  });

  it('spawna o comando/args default (terminal livre, PowerShell) quando command/args são omitidos', async () => {
    // Ciclo de correção 1 (auditoria batch 2) — antes só afirmava que o id
    // era string e que não lançava (smoke fraco). Agora exercita o caminho
    // default de verdade (sem passar command/args) e afirma um sinal
    // observável: o eco de um marcador único chega pelo onData, provando que
    // o PowerShell default foi spawnado e está processando input real.
    const manager = new PtyManager();
    const marker = 'donel-default-shell-probe';

    const dataPromise = new Promise<string>((resolve) => {
      let collected = '';
      manager.onData((_ptyId, data) => {
        collected += data;
        if (collected.includes(marker)) resolve(collected);
      });
    });

    const ptyId = manager.create({ cols: 80, rows: 24 });
    manager.input(ptyId, `echo ${marker}\r`);

    const collected = await dataPromise;
    expect(collected).toContain(marker);

    manager.kill(ptyId);
  });
});

// T014 (FR-005/CA-3) — env efetivo do PTY quando uma aba nasce sob um perfil
// não-Principal. Puro — sem tocar node-pty/filesystem real.
describe('buildPtyEnv (puro)', () => {
  it('seta CLAUDE_CONFIG_DIR quando um perfil é informado', () => {
    const env = buildPtyEnv({ PATH: 'C:\\bin', USERNAME: 'x' }, 'C:\\Users\\x\\.claude-profiles\\conta-b');
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:\\Users\\x\\.claude-profiles\\conta-b');
    expect(env.PATH).toBe('C:\\bin'); // resto do env preservado (plan.md ponto 2 — nunca sobrescrever PATH)
  });

  it('remove CLAUDE_CONFIG_DIR quando nenhum perfil é informado (Principal) — mesmo que já viesse setado no baseEnv', () => {
    const env = buildPtyEnv({ PATH: 'C:\\bin', CLAUDE_CONFIG_DIR: 'C:\\vazamento-de-outro-perfil' }, undefined);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.PATH).toBe('C:\\bin');
  });

  it('ignora entradas do baseEnv com valor undefined (Record<string,string> de saída nunca tem undefined)', () => {
    const env = buildPtyEnv({ PATH: 'C:\\bin', SOME_UNSET: undefined }, undefined);
    expect('SOME_UNSET' in env).toBe(false);
  });

  // Achado do teste manual (27/07): app lançado de dentro de uma sessão do
  // Claude Code herda os marcadores de sessão-mãe e o CLI dentro do app abre
  // como "sessão filha" (transcript saving off, permission mode herdado). As
  // sessões que o app cria são sempre sessões RAIZ — os marcadores nunca
  // podem vazar do ambiente que lançou o app.
  it('remove os marcadores de sessão-mãe do Claude Code herdados do ambiente que lançou o app', () => {
    const env = buildPtyEnv(
      {
        PATH: 'C:\\bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: 'marker',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SSE_PORT: '12345',
      },
      undefined,
    );
    expect('CLAUDECODE' in env).toBe(false);
    expect('CLAUDE_CODE_CHILD_SESSION' in env).toBe(false);
    expect('CLAUDE_CODE_ENTRYPOINT' in env).toBe(false);
    expect('CLAUDE_CODE_SSE_PORT' in env).toBe(false);
    expect(env.PATH).toBe('C:\\bin');
  });
});

// T014 — integração: `PtyManager.create` aplica `claudeConfigDir` no env real do processo spawnado (não só na função pura `buildPtyEnv` isolada).
describe('PtyManager — claudeConfigDir chega no processo spawnado (FR-005/CA-3)', () => {
  it('a variável CLAUDE_CONFIG_DIR aparece no ambiente real do PTY quando claudeConfigDir é passado', async () => {
    const manager = new PtyManager();
    const dataPromise = new Promise<string>((resolve) => {
      let collected = '';
      manager.onData((_ptyId, data) => {
        collected += data;
        if (collected.includes('DONEL_PROFILE_MARKER_END')) resolve(collected);
      });
    });

    const ptyId = manager.create({
      cols: 80,
      rows: 24,
      command: 'cmd.exe',
      args: ['/c', 'echo %CLAUDE_CONFIG_DIR% & echo DONEL_PROFILE_MARKER_END'],
      claudeConfigDir: 'C:\\Users\\fake-user\\.claude-profiles\\conta-b',
    });

    const collected = await dataPromise;
    expect(collected).toContain('C:\\Users\\fake-user\\.claude-profiles\\conta-b');

    manager.kill(ptyId);
  });
});
