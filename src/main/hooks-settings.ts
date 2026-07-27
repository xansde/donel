import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// T009 — arquivo `--settings` adicional (spike: "soma hooks aos hooks
// globais do usuário sem substituí-los" — validado byte-a-byte que
// ~/.claude/settings.json nunca é tocado). Um único par de arquivos (script
// `.ps1` + `settings.json`), escritos uma vez no boot do app, reaproveitados
// por `--settings <path>` em TODO spawn de sessão claude — não precisam ser
// por-sessão porque a correlação já vem no próprio payload do hook
// (`session_id`, ver session-correlation.ts).
//
// Script `.ps1` GERADO em vez de comando PowerShell inline (`-Command
// "..."`): tentado no smoke real do T009 e o hook NUNCA chegou ao servidor
// (nem erro visível no transcript, nem POST recebido) — o mecanismo com
// `-File "<script>"` é o que o spike T002 validou de ponta a ponta (e o
// addendum T009 reconfirmou com Notification real), então é o único usado
// em produção. O script é regravado a cada boot (porta efêmera muda), então
// não precisa ser um asset versionado — nada pra T016 empacotar.

/** Eventos registrados — matriz do spike (specs/001-mvp/spike-t002-resultado.md). */
export const SEMAPHORE_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd'] as const;

const SETTINGS_FILE_NAME = 'session-hooks-settings.json';
const FORWARDER_SCRIPT_FILE_NAME = 'session-hook-forward.ps1';

/** Puro — conteúdo do script PowerShell que os hooks chamam: lê stdin, faz POST pro endpoint local, nunca lança (mesma garantia do `hook-forward.ps1` do spike T002). */
export function buildHookForwarderScript(port: number): string {
  const endpoint = `http://127.0.0.1:${port}/hook`;
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$in = [Console]::In.ReadToEnd()',
    'try {',
    `  Invoke-RestMethod -Uri "${endpoint}" -Method Post -Body $in -ContentType "application/json" -TimeoutSec 2 | Out-Null`,
    '} catch {}',
    'exit 0',
    '',
  ].join('\r\n');
}

export interface HooksSettingsContent {
  readonly hooks: Record<(typeof SEMAPHORE_HOOK_EVENTS)[number], readonly [{ readonly hooks: readonly [{ readonly type: 'command'; readonly command: string }] }]>;
}

/** Puro — dado o path do script forwarder já gravado em disco, monta o conteúdo do `--settings`. */
export function buildHooksSettingsContent(forwarderScriptPath: string): HooksSettingsContent {
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${forwarderScriptPath}"`;
  const entry = [{ hooks: [{ type: 'command' as const, command }] }] as const;

  const hooks = Object.fromEntries(SEMAPHORE_HOOK_EVENTS.map((event) => [event, entry])) as HooksSettingsContent['hooks'];

  return { hooks };
}

/** I/O — grava o script forwarder + o `--settings` em `userDataDir`, devolve o path do `--settings`. `writeFileSyncFn` injetável pra testar sem tocar disco. */
export function writeHooksSettingsFile(userDataDir: string, port: number, writeFileSyncFn: typeof writeFileSync = writeFileSync): string {
  const scriptPath = join(userDataDir, FORWARDER_SCRIPT_FILE_NAME);
  writeFileSyncFn(scriptPath, buildHookForwarderScript(port), 'utf8');

  const settingsPath = join(userDataDir, SETTINGS_FILE_NAME);
  writeFileSyncFn(settingsPath, JSON.stringify(buildHooksSettingsContent(scriptPath), null, 2), 'utf8');

  return settingsPath;
}
