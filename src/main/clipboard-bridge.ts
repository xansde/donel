import { clipboard } from 'electron';

// T503 (005-terminal-copy-paste) — três funções finas sobre `electron.clipboard`
// (plan.md Fatia 2, decisão 6: "Clipboard vive no main, não no renderer" —
// `contextIsolation: true` sem `nodeIntegration`, o renderer não alcança o
// módulo `clipboard` diretamente; TerminalPane fala com este módulo via
// canal IPC `clipboard:*`, T504).
//
// Regra dura (spec.md, "Clipboard indisponível não pode derrubar a
// digitação"): qualquer exceção do clipboard aqui é engolida e degrada —
// `hasImage` -> `false`, `readText` -> `''`. Nunca propaga: um clipboard
// travado/indisponível não pode quebrar a aba nem interromper a digitação.

/**
 * Detecção local e barata (plan.md decisão 5) — nunca chama PowerShell, quem
 * paga esse custo (~1,5 s) é o próprio claude CLI, uma vez, no CA-4.
 */
export function hasImage(): boolean {
  try {
    return !clipboard.readImage().isEmpty();
  } catch {
    return false;
  }
}

export function readText(): string {
  try {
    return clipboard.readText();
  } catch {
    return '';
  }
}

export function writeText(text: string): void {
  try {
    clipboard.writeText(text);
  } catch {
    // Degrada silenciosamente — falha ao copiar não pode quebrar a aba nem propagar pro chamador.
  }
}
