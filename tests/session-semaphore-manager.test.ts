import { describe, expect, it } from 'vitest';
import { mapHookEventName, SessionSemaphoreManager, type SemaphoreUpdate } from '../src/main/session-semaphore-manager';

// T009 — mapHookEventName é puro (testado direto). O resto da classe tem I/O
// real (servidor HTTP local) — mesmo padrão de tests/pty-manager.test.ts
// (spawna um processo dummy de verdade em vez de mockar node-pty): aqui
// sobe o servidor de verdade numa porta efêmera e faz um POST real, porque é
// exatamente esse fio (hook -> HTTP -> estado) que o addendum T009 do spike
// validou manualmente contra um `claude` real — a suíte automatizada cobre
// a mesma costura sem precisar do CLI.

describe('mapHookEventName', () => {
  it('traduz os 6 eventos da matriz do spike', () => {
    expect(mapHookEventName('UserPromptSubmit')).toBe('userPromptSubmit');
    expect(mapHookEventName('PreToolUse')).toBe('preToolUse');
    expect(mapHookEventName('PostToolUse')).toBe('postToolUse');
    expect(mapHookEventName('Stop')).toBe('stop');
    expect(mapHookEventName('Notification')).toBe('notification');
    expect(mapHookEventName('SessionEnd')).toBe('sessionEnd');
  });

  it('null para eventos que não são do semáforo (ex.: SubagentStop de hooks globais do usuário)', () => {
    expect(mapHookEventName('SubagentStop')).toBeNull();
    expect(mapHookEventName(undefined)).toBeNull();
    expect(mapHookEventName(123)).toBeNull();
  });
});

async function postHook(port: number, body: unknown): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('SessionSemaphoreManager (servidor HTTP real, porta efêmera)', () => {
  it('registra a sessão, roteia hooks reais via HTTP pro ptyId certo e emite os estados esperados', async () => {
    const manager = new SessionSemaphoreManager({ getRecentLines: () => [] });
    const port = await manager.start();
    expect(port).toBeGreaterThan(0);

    try {
      const updates: SemaphoreUpdate[] = [];
      manager.onUpdate((update) => updates.push(update));

      manager.registerSession('pty-1', 'claude-session-abc');
      expect(updates.at(-1)).toEqual({ ptyId: 'pty-1', state: 'working', stateEnteredAt: expect.any(Number) });

      await postHook(port, { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-abc' });
      await postHook(port, { hook_event_name: 'Stop', session_id: 'claude-session-abc' });

      expect(updates.at(-1)?.state).toBe('waiting');
      expect(updates.at(-1)?.ptyId).toBe('pty-1');
    } finally {
      manager.dispose();
    }
  });

  it('ignora hooks de session_id não registrado (sessão claude fora deste app)', async () => {
    const manager = new SessionSemaphoreManager({ getRecentLines: () => [] });
    const port = await manager.start();

    try {
      const updates: SemaphoreUpdate[] = [];
      manager.onUpdate((update) => updates.push(update));
      manager.registerSession('pty-1', 'claude-session-abc');
      updates.length = 0; // limpa o update do registerSession pra checar só o efeito do POST

      await postHook(port, { hook_event_name: 'Stop', session_id: 'unrelated-session-id' });

      expect(updates).toEqual([]);
    } finally {
      manager.dispose();
    }
  });

  it('onProcessExit com exit code != 0 emite "error" (FR-010 falha/quota esgotada); código 0 emite "done"', async () => {
    const manager = new SessionSemaphoreManager({ getRecentLines: () => [] });
    await manager.start();

    try {
      const updates: SemaphoreUpdate[] = [];
      manager.onUpdate((update) => updates.push(update));

      manager.registerSession('pty-error', 'session-error');
      manager.onProcessExit('pty-error', 1);
      expect(updates.at(-1)).toEqual({ ptyId: 'pty-error', state: 'error', stateEnteredAt: expect.any(Number) });

      manager.registerSession('pty-ok', 'session-ok');
      manager.onProcessExit('pty-ok', 0);
      expect(updates.at(-1)).toEqual({ ptyId: 'pty-ok', state: 'done', stateEnteredAt: expect.any(Number) });
    } finally {
      manager.dispose();
    }
  });

  it('onProcessExit tem prioridade mesmo após hooks reais via HTTP terem movido o estado (kill forçado do spike)', async () => {
    const manager = new SessionSemaphoreManager({ getRecentLines: () => [] });
    const port = await manager.start();

    try {
      manager.registerSession('pty-1', 'claude-session-abc');
      await postHook(port, { hook_event_name: 'Notification', session_id: 'claude-session-abc' });
      expect(manager.getSnapshot('pty-1')?.state).toBe('permission');

      manager.onProcessExit('pty-1', 1); // kill forçado — spike: SessionEnd não dispara, mas onExit do node-pty sempre é a fonte de verdade
      expect(manager.getSnapshot('pty-1')?.state).toBe('error');
    } finally {
      manager.dispose();
    }
  });

  it('getSnapshot retorna undefined para ptyId nunca registrado', async () => {
    const manager = new SessionSemaphoreManager({ getRecentLines: () => [] });
    await manager.start();
    try {
      expect(manager.getSnapshot('never-registered')).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });
});
