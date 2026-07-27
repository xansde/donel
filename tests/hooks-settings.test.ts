import { describe, expect, it, vi } from 'vitest';
import { buildHookForwarderScript, buildHooksSettingsContent, SEMAPHORE_HOOK_EVENTS, writeHooksSettingsFile } from '../src/main/hooks-settings';

// T009 — arquivo `--settings` adicional (spike: soma aditiva, nunca toca
// ~/.claude/settings.json). Script `.ps1` + settings.json puros; só a
// escrita em disco tem I/O (testada com `writeFileSync` injetado).
//
// O comando inline `-Command "..."` foi tentado primeiro e NUNCA chegou a
// disparar no smoke real do app (nem erro visível, nem POST recebido) — só
// o padrão `-File "<script>"` (mesmo do hook-forward.ps1 do spike T002,
// reconfirmado no addendum) funciona de ponta a ponta. Os testes abaixo
// travam essa forma.

describe('buildHookForwarderScript', () => {
  it('embute a porta local no Invoke-RestMethod', () => {
    const script = buildHookForwarderScript(54321);
    expect(script).toContain('http://127.0.0.1:54321/hook');
    expect(script).toContain('Invoke-RestMethod');
  });

  it('nunca lança — try/catch envolve o POST e termina com exit 0', () => {
    const script = buildHookForwarderScript(8765);
    expect(script).toContain('try {');
    expect(script).toContain('catch {}');
    expect(script).toContain('exit 0');
  });
});

describe('buildHooksSettingsContent', () => {
  const scriptPath = 'C:\\Users\\test\\AppData\\Roaming\\donel-dev\\session-hook-forward.ps1';

  it('registra todos os 6 eventos da matriz do spike', () => {
    const content = buildHooksSettingsContent(scriptPath);

    for (const event of SEMAPHORE_HOOK_EVENTS) {
      expect(content.hooks[event]).toBeDefined();
      expect(content.hooks[event][0].hooks[0].type).toBe('command');
    }
    expect(Object.keys(content.hooks)).toHaveLength(6);
  });

  it('cada comando usa -File apontando pro script gerado, não -Command inline', () => {
    const content = buildHooksSettingsContent(scriptPath);

    for (const event of SEMAPHORE_HOOK_EVENTS) {
      const command = content.hooks[event][0].hooks[0].command;
      expect(command).toContain(`-File "${scriptPath}"`);
      expect(command).not.toContain('-Command');
    }
  });

  it('é determinístico pro mesmo script path (puro, sem I/O)', () => {
    expect(buildHooksSettingsContent(scriptPath)).toEqual(buildHooksSettingsContent(scriptPath));
  });
});

describe('writeHooksSettingsFile', () => {
  it('escreve o script forwarder E o settings.json, sem tocar o FS real', () => {
    const writeFileSyncMock = vi.fn();
    const userDataDir = 'C:\\Users\\test\\AppData\\Roaming\\donel-dev';

    const settingsPath = writeHooksSettingsFile(userDataDir, 8765, writeFileSyncMock as never);

    expect(settingsPath).toBe(`${userDataDir}\\session-hooks-settings.json`);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);

    const [scriptCall, settingsCall] = writeFileSyncMock.mock.calls;
    const [scriptPath, scriptContent, scriptEncoding] = scriptCall;
    expect(scriptPath).toBe(`${userDataDir}\\session-hook-forward.ps1`);
    expect(scriptContent).toBe(buildHookForwarderScript(8765));
    expect(scriptEncoding).toBe('utf8');

    const [settingsWrittenPath, settingsContent, settingsEncoding] = settingsCall;
    expect(settingsWrittenPath).toBe(settingsPath);
    expect(settingsEncoding).toBe('utf8');
    expect(JSON.parse(settingsContent as string)).toEqual(buildHooksSettingsContent(scriptPath));
  });
});
