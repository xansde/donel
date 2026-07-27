import { describe, expect, it } from 'vitest';
import { appendToRingBuffer, type RingBufferState } from '../src/main/ring-buffer';

// Ciclo de correção 1 (auditoria batch 2) — appendToRingBuffer é o helper
// puro extraído do PtyManager (ponto 8) pra poder testar carry-over de linha
// sem newline e o cap de tamanho sem precisar spawnar um PTY de verdade.

const EMPTY: RingBufferState = { ringBuffer: [], rawTail: '' };

describe('appendToRingBuffer', () => {
  it('buffers a chunk with no line break as rawTail, without touching ringBuffer', () => {
    const result = appendToRingBuffer(EMPTY, 'partial line without break', 50);

    expect(result.ringBuffer).toEqual([]);
    expect(result.rawTail).toBe('partial line without break');
  });

  it('flushes a completed line into ringBuffer and keeps the remainder as rawTail', () => {
    const result = appendToRingBuffer(EMPTY, 'line one\nline two without break', 50);

    expect(result.ringBuffer).toEqual(['line one']);
    expect(result.rawTail).toBe('line two without break');
  });

  it('strips ANSI from a line whose escape sequence is split across two chunks', () => {
    // Chunk 1 termina no meio de um CSI de cor — sem newline, então nada é
    // stripado/flushado ainda: a sequência incompleta fica crua em rawTail.
    const afterFirstChunk = appendToRingBuffer(EMPTY, 'hello \x1B[31', 50);
    expect(afterFirstChunk.ringBuffer).toEqual([]);
    expect(afterFirstChunk.rawTail).toBe('hello \x1B[31');

    // Chunk 2 completa a sequência e fecha a linha — só aí o stripAnsi roda
    // sobre a linha inteira já remontada.
    const afterSecondChunk = appendToRingBuffer(afterFirstChunk, 'mworld\n', 50);

    expect(afterSecondChunk.ringBuffer).toEqual(['hello world']);
    expect(afterSecondChunk.rawTail).toBe('');
  });

  it('caps the ring buffer at maxLines, dropping the oldest lines first', () => {
    const manyLines = `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\n`;

    const result = appendToRingBuffer(EMPTY, manyLines, 50);

    expect(result.ringBuffer).toHaveLength(50);
    expect(result.ringBuffer[0]).toBe('line 10');
    expect(result.ringBuffer[49]).toBe('line 59');
  });

  it('treats \\r\\n line endings the same as \\n', () => {
    const result = appendToRingBuffer(EMPTY, 'line one\r\nline two\r\n', 50);

    expect(result.ringBuffer).toEqual(['line one', 'line two']);
    expect(result.rawTail).toBe('');
  });

  // T009 — bug corrigido (auditoria batch 2): spinner/progress bar que só usa
  // `\r` (sem `\n`) pra redesenhar a mesma linha não podia nem (a) crescer
  // `rawTail` sem limite, nem (b) inundar o ring buffer com uma entrada por
  // frame — só a última reescrita antes de um `\n` real deve virar linha.
  it('resets the current line on a lone \\r instead of accumulating rawTail forever', () => {
    let state = EMPTY;
    // Cada frame do spinner chega num chunk PTY separado, terminado em `\r`
    // (nunca `\n`) — exatamente como um redraw real de progress bar.
    for (const frame of ['Loading\r', 'Loading.\r', 'Loading..\r', 'Loading...\r']) {
      state = appendToRingBuffer(state, frame, 50);
      // rawTail nunca deve conter mais de um frame — a prova do bug original
      // (concatenação sem limite) seria rawTail crescendo a cada iteração.
      expect(state.rawTail.length).toBeLessThanOrEqual('Loading...\r'.length);
    }
    expect(state.ringBuffer).toEqual([]); // nenhum \n ainda — nada fechou.

    // O spinner termina com uma linha de verdade — só o último frame vira entrada do ring buffer.
    state = appendToRingBuffer(state, 'Done!\n', 50);
    expect(state.ringBuffer).toEqual(['Done!']);
    expect(state.rawTail).toBe('');
  });

  it('does not flood the ring buffer with one entry per \\r redraw frame', () => {
    // 20 frames de spinner, todos via \r, nenhum \n — nenhum deveria virar
    // linha no ring buffer (só redraw da linha corrente).
    const spinnerFrames = Array.from({ length: 20 }, (_, i) => `frame-${i}\r`).join('');
    const result = appendToRingBuffer(EMPTY, spinnerFrames, 50);

    expect(result.ringBuffer).toEqual([]);
  });

  it('keeps a lone trailing \\r pending across chunks so a \\r\\n split at the PTY chunk boundary still closes exactly one line', () => {
    // O `\r` chega sozinho no fim de um chunk; o `\n` correspondente só
    // chega no chunk seguinte — não pode virar dois fechamentos de linha
    // (um pelo \r "resolvido cedo demais", outro pelo \n).
    const afterFirstChunk = appendToRingBuffer(EMPTY, 'line one\r', 50);
    expect(afterFirstChunk.ringBuffer).toEqual([]);
    expect(afterFirstChunk.rawTail).toBe('line one\r');

    const afterSecondChunk = appendToRingBuffer(afterFirstChunk, '\nline two\r\n', 50);
    expect(afterSecondChunk.ringBuffer).toEqual(['line one', 'line two']);
    expect(afterSecondChunk.rawTail).toBe('');
  });

  it('treats a trailing \\r not followed by \\n (process exited mid-redraw) as a pending redraw, never emitted as a line', () => {
    // Processo saiu logo após um redraw de spinner, sem newline final —
    // esse último frame nunca devia ter sido considerado "line one\rline two"
    // colado (o bug original), nem vazar como uma linha fechada.
    const result = appendToRingBuffer(EMPTY, 'line one\rline two', 50);

    expect(result.ringBuffer).toEqual([]);
    expect(result.rawTail).toBe('line two');
  });
});
