import { stripAnsi } from './ansi';

// Ring buffer puro do preview de PTY (plan.md ponto 8). Extraído do
// PtyManager para ser testável sem precisar spawnar um processo real: junta
// o `rawTail` (cauda ainda sem quebra de linha, ANSI cru) com o chunk novo,
// fecha as linhas completas (aplicando `stripAnsi` só nelas — uma sequência
// ANSI partida entre dois chunks nunca é stripada pela metade, porque ela
// permanece crua em `rawTail` até a linha fechar), e capa o buffer em
// `maxLines`, descartando as mais antigas primeiro.
//
// Correção (auditoria batch 2, achado T009): um `\r` solto (sem `\n` na
// sequência) — usado por spinners/progress bars pra redesenhar a MESMA linha
// no lugar — nunca fechava linha nenhuma no split original (`/\r?\n/` exige
// um `\n`). Resultado: `rawTail` crescia sem limite (cada frame do spinner
// era só concatenado ao anterior) e a heurística de regex que lê o ring
// buffer via `getPreview` via nunca via o conteúdo real da tela, só uma
// sopa de frames concatenados. Tratamento agora: um `\r` isolado reseta a
// linha corrente (comportamento real de terminal — o cursor volta pra
// coluna 0 e o que vem depois sobrescreve), SEM fechar uma entrada no ring
// buffer por frame (evita inundar o buffer com ruído de spinner); só a
// última reescrita antes de um `\n` de verdade vira uma linha completa. Um
// `\r` no fim exato do chunk atual fica pendente em `rawTail` (não resolvido
// como fechamento nem como redraw) até o próximo chunk chegar — só assim dá
// pra distinguir um `\r\n` partido entre dois chunks de PTY (deve fechar UMA
// linha) de um redraw de verdade seguido por mais texto (deve resetar).

export interface RingBufferState {
  ringBuffer: string[];
  rawTail: string;
}

const LINE_SEPARATOR = /(\r\n|\r|\n)/;

export function appendToRingBuffer(state: RingBufferState, chunk: string, maxLines: number): RingBufferState {
  let combined = state.rawTail + chunk;

  // `\r` no fim exato do combined é ambíguo: pode ser a primeira metade de um
  // `\r\n` que o próximo chunk do PTY vai completar, ou um redraw de verdade
  // sem mais nada depois (processo saiu no meio de um spinner). Adia a
  // decisão — nunca resolve um `\r` sem saber o que vem a seguir.
  const deferredCr = combined.endsWith('\r');
  if (deferredCr) {
    combined = combined.slice(0, -1);
  }

  const tokens = combined.split(LINE_SEPARATOR);
  const completedLines: string[] = [];
  let current = '';

  for (const token of tokens) {
    if (token === '\r\n' || token === '\n') {
      completedLines.push(current);
      current = '';
    } else if (token === '\r') {
      // Redraw da linha corrente (spinner/progress bar): descarta o que foi
      // digitado até aqui SEM fechar uma entrada no ring buffer — só a
      // última reescrita antes de um `\n` real vira linha.
      current = '';
    } else {
      current += token;
    }
  }

  const rawTail = deferredCr ? `${current}\r` : current;

  if (completedLines.length === 0) {
    return { ringBuffer: state.ringBuffer, rawTail };
  }

  const ringBuffer = [...state.ringBuffer, ...completedLines.map(stripAnsi)];
  if (ringBuffer.length > maxLines) {
    ringBuffer.splice(0, ringBuffer.length - maxLines);
  }
  return { ringBuffer, rawTail };
}
