import { existsSync, mkdirSync, mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TranscriptWatcherRegistry,
  readTranscriptTail,
  watchTranscript,
  type TranscriptChange,
  type TranscriptWatcherHandle,
  type TranscriptWatcherOptions,
} from '../src/main/transcript-watcher';

// T411 (004-nomear-sessoes, Fase C) — watcher do transcript da sessão VIVA:
// é ele que faz um `/rename` no CLI refletir na aba em menos de 1 s (CA-4).
//
// PEÇA COMPARTILHADA com a 006 (contexto consumido), por decisão registrada nos
// dois planos: as duas features leem o MESMO `.jsonl`, na MESMA cauda, no MESMO
// evento — um watcher só, payload de objeto
// (`{ sessionId, customTitle, contextTokens }`) e emissão quando QUALQUER campo
// muda. Se nascesse emitindo só o título, a 006 reescreveria este arquivo na
// semana seguinte (o `contextTokens` muda a cada turn, sem rename nenhum).
//
// `fs.watch` REAL em tmpdir, de propósito: o que este módulo pode errar é
// justamente a parte que um mock esconderia — arquivo que ainda não existe,
// handle que não fecha, evento que não chega no Windows.
//
// Timers REAIS com debounce curto (em vez de fake timers): `fs.watch` entrega
// eventos pelo loop de I/O do libuv, que timers fake não adiantam — a
// combinação dos dois não compõe. Daí o `waitFor` abaixo.

const DEBOUNCE_MS = 40;

/** Espera até `predicate` virar true, ou estoura. Evita `sleep` fixo (flake sob carga). */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`waitFor: condição não satisfeita em ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Dá tempo de um evento INDESEJADO aparecer — a única forma honesta de provar "não emitiu". */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 6));
}

const titleLine = (title: string, sessionId = 'abc-123'): string =>
  `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })}\n`;

const userLine = (text: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date().toISOString() })}\n`;

/**
 * T606 (006) — turno do assistant com `usage`. A forma bate com o transcript
 * REAL conferido em 26/07: a `usage` fica em `message.usage`, não no topo da
 * linha (ver `specs/006-contexto-consumido/medicao-t606.md`).
 */
const assistantUsageLine = (
  { input = 0, cacheRead = 0, cacheCreation = 0, sidechain = false } = {} as {
    input?: number;
    cacheRead?: number;
    cacheCreation?: number;
    sidechain?: boolean;
  },
): string =>
  `${JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: 999,
      },
    },
  })}\n`;

describe('watchTranscript', () => {
  let dir: string;
  let filePath: string;
  let changes: TranscriptChange[];
  let disposers: (() => void)[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'donel-dev-transcript-watcher-'));
    filePath = join(dir, 'abc-123.jsonl');
    changes = [];
    disposers = [];
  });

  afterEach(() => {
    for (const dispose of disposers) dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(path = filePath): () => void {
    const watcher = watchTranscript({
      sessionId: 'abc-123',
      filePath: path,
      debounceMs: DEBOUNCE_MS,
      retryMs: 20,
      onChange: (change) => changes.push(change),
    });
    disposers.push(watcher.dispose);
    return watcher.dispose;
  }

  it('emite o nome novo quando um custom-title é acrescentado à sessão viva (CA-4)', async () => {
    await fs.writeFile(filePath, userLine('trabalhando'), 'utf8');
    start();
    await settle(); // consome a leitura inicial (sem título, não emite)
    expect(changes).toEqual([]);

    await fs.appendFile(filePath, titleLine('renomeado ao vivo'), 'utf8');

    await waitFor(() => changes.length === 1);
    expect(changes[0]).toEqual({ sessionId: 'abc-123', customTitle: 'renomeado ao vivo', contextTokens: null });
  });

  it('lê na ABERTURA e emite o título que já existia (sessão retomada com nome antigo)', async () => {
    await fs.writeFile(filePath, `${userLine('oi')}${titleLine('nome de antes')}`, 'utf8');
    start();

    await waitFor(() => changes.length === 1);
    expect(changes[0].customTitle).toBe('nome de antes');
  });

  it('NÃO emite para escrita que não muda nenhum campo (linha comum de conversa)', async () => {
    await fs.writeFile(filePath, titleLine('estável'), 'utf8');
    start();
    await waitFor(() => changes.length === 1);

    await fs.appendFile(filePath, userLine('mais uma mensagem'), 'utf8');
    await fs.appendFile(filePath, userLine('e outra'), 'utf8');
    await settle();

    expect(changes).toHaveLength(1); // só o da abertura
  });

  it('NÃO emite de novo quando o MESMO título é regravado (comparação por valor)', async () => {
    await fs.writeFile(filePath, titleLine('igual'), 'utf8');
    start();
    await waitFor(() => changes.length === 1);

    await fs.appendFile(filePath, titleLine('igual'), 'utf8');
    await settle();

    expect(changes).toHaveLength(1);
  });

  it('emite a cada mudança REAL de título, em sequência', async () => {
    await fs.writeFile(filePath, userLine('trabalho'), 'utf8');
    start();
    await settle();

    await fs.appendFile(filePath, titleLine('primeiro'), 'utf8');
    await waitFor(() => changes.length === 1);
    await fs.appendFile(filePath, titleLine('segundo'), 'utf8');
    await waitFor(() => changes.length === 2);

    expect(changes.map((c) => c.customTitle)).toEqual(['primeiro', 'segundo']);
  });

  it('junta uma rajada de escritas num emit só (debounce)', async () => {
    await fs.writeFile(filePath, userLine('trabalho'), 'utf8');
    start();
    await settle();

    // Cinco escritas dentro da janela de debounce: o valor final é o que vale.
    for (const title of ['a', 'b', 'c', 'd', 'final']) {
      await fs.appendFile(filePath, titleLine(title), 'utf8');
    }

    await waitFor(() => changes.length >= 1);
    await settle();
    expect(changes).toHaveLength(1);
    expect(changes[0].customTitle).toBe('final');
  });

  it('arquivo que ainda NÃO existe na abertura (o CLI cria na 1ª mensagem) — dispara quando ele nasce', async () => {
    expect(existsSync(filePath)).toBe(false);
    start();
    await settle();

    await fs.writeFile(filePath, `${userLine('primeira mensagem')}${titleLine('nasceu com nome')}`, 'utf8');

    await waitFor(() => changes.length >= 1);
    expect(changes[0].customTitle).toBe('nasceu com nome');
  });

  it('DIRETÓRIO que ainda não existe (projeto que nunca abriu sessão) — dispara quando ele aparece', async () => {
    const nestedDir = join(dir, 'projeto-novo');
    const nestedFile = join(nestedDir, 'abc-123.jsonl');
    start(nestedFile);
    await settle();

    mkdirSync(nestedDir, { recursive: true });
    await fs.writeFile(nestedFile, titleLine('projeto novo'), 'utf8');

    await waitFor(() => changes.length >= 1, 5_000);
    expect(changes[0].customTitle).toBe('projeto novo');
  });

  it('dispose() para de emitir — prova de que o handle não vaza', async () => {
    await fs.writeFile(filePath, titleLine('antes do dispose'), 'utf8');
    const dispose = start();
    await waitFor(() => changes.length === 1);

    dispose();
    await fs.appendFile(filePath, titleLine('depois do dispose'), 'utf8');
    await settle();

    expect(changes).toHaveLength(1);
    expect(changes[0].customTitle).toBe('antes do dispose');
  });

  it('dispose() duas vezes não lança', async () => {
    const dispose = start();
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  // Regra deliberada, igual à do `resolveSessionName`: leitura que não acha
  // título é leitura FALHA (arquivo travado no meio de uma escrita, apagado,
  // cauda ilegível), não um `/rename` que removeu o nome. Sem isso, um erro
  // transitório de I/O faria o nome da aba piscar para o fallback e voltar.
  it('arquivo apagado embaixo do watcher: não lança e NÃO apaga o título já conhecido', async () => {
    await fs.writeFile(filePath, titleLine('vai sumir'), 'utf8');
    start();
    await waitFor(() => changes.length === 1);

    await fs.unlink(filePath);
    await settle();

    expect(changes).toHaveLength(1);
    expect(changes[0].customTitle).toBe('vai sumir');
  });

  // ---------------------------------------------------------------------------
  // T606/T608 (006-contexto-consumido) — o MESMO watcher passa a emitir também
  // o `contextTokens`. Estes casos são a prova de que a 006 não precisou de um
  // segundo leitor nem de um segundo canal.
  // ---------------------------------------------------------------------------

  it('emite contextTokens do turno novo (a soma da última usage)', async () => {
    await fs.writeFile(filePath, userLine('primeira pergunta'), 'utf8');
    start();
    await settle();
    expect(changes).toEqual([]);

    await fs.appendFile(filePath, assistantUsageLine({ input: 290, cacheCreation: 1505, cacheRead: 132_807 }), 'utf8');

    await waitFor(() => changes.length === 1);
    expect(changes[0]).toEqual({ sessionId: 'abc-123', customTitle: null, contextTokens: 134_602 });
  });

  it('turno seguinte que só muda a usage EMITE (regressão que a regra antiga da 004 causaria)', async () => {
    await fs.writeFile(filePath, assistantUsageLine({ input: 100, cacheRead: 50_000 }), 'utf8');
    start();
    await waitFor(() => changes.length === 1);
    expect(changes[0].contextTokens).toBe(50_100);

    // Nenhum rename: só um turno novo, com contexto maior.
    await fs.appendFile(filePath, assistantUsageLine({ input: 120, cacheRead: 90_000 }), 'utf8');

    await waitFor(() => changes.length === 2);
    expect(changes[1].contextTokens).toBe(90_120);
    expect(changes[1].customTitle).toBeNull();
  });

  it('a ÚLTIMA usage vence quando há várias na cauda', async () => {
    await fs.writeFile(
      filePath,
      `${assistantUsageLine({ input: 1, cacheRead: 10_000 })}${userLine('segue')}${assistantUsageLine({ input: 2, cacheRead: 200_000 })}`,
      'utf8',
    );
    start();

    await waitFor(() => changes.length === 1);
    expect(changes[0].contextTokens).toBe(200_002);
  });

  it('o % CAI depois de um /compact — a usage nova é menor, e isso não é lacuna de leitura', async () => {
    await fs.writeFile(filePath, assistantUsageLine({ input: 200, cacheRead: 280_000 }), 'utf8');
    start();
    await waitFor(() => changes.length === 1);

    // Pós-compact: o contexto real encolheu, e o número tem de acompanhar.
    await fs.appendFile(filePath, assistantUsageLine({ input: 150, cacheRead: 20_000 }), 'utf8');

    await waitFor(() => changes.length === 2);
    expect(changes[1].contextTokens).toBe(20_150);
  });

  // Decisão explícita desta sessão (o handoff da 004 deixou em aberto e exigiu
  // teste): a regra do "não apaga o que já sabe" vale IGUAL para os tokens.
  // Cauda sem `usage` é lacuna de leitura — uma linha gigante de `tool_result`
  // empurrando a usage para fora da janela de 64 KB acontece no meio de 35% das
  // sessões (medicao-t606.md §B) — não é "o contexto voltou a zero". Sem esta
  // regra o `%` piscaria para `—` no meio de um turno longo, exatamente quando
  // o número mais importa.
  it('leitura sem usage NÃO apaga os tokens já conhecidos (nem emite evento novo)', async () => {
    await fs.writeFile(filePath, assistantUsageLine({ input: 100, cacheRead: 130_000 }), 'utf8');
    start();
    await waitFor(() => changes.length === 1);
    expect(changes[0].contextTokens).toBe(130_100);

    // Linha grande o bastante para empurrar a usage fora da cauda de 64 KB.
    await fs.appendFile(filePath, userLine('x'.repeat(70 * 1024)), 'utf8');
    await settle();

    expect(changes).toHaveLength(1); // nada novo: o valor conhecido permanece
  });

  it('turno de SUBAGENTE (isSidechain) não é confundido com o contexto da sessão', async () => {
    await fs.writeFile(filePath, assistantUsageLine({ input: 100, cacheRead: 130_000 }), 'utf8');
    start();
    await waitFor(() => changes.length === 1);

    await fs.appendFile(filePath, assistantUsageLine({ input: 10, cacheRead: 5_000, sidechain: true }), 'utf8');
    await settle();

    expect(changes).toHaveLength(1);
    expect(changes[0].contextTokens).toBe(130_100);
  });

  it('emite os DOIS campos numa rajada que muda título e usage ao mesmo tempo', async () => {
    await fs.writeFile(filePath, userLine('oi'), 'utf8');
    start();
    await settle();

    await fs.appendFile(filePath, `${assistantUsageLine({ input: 10, cacheRead: 60_000 })}${titleLine('com nome')}`, 'utf8');

    await waitFor(() => changes.length === 1);
    expect(changes[0]).toEqual({ sessionId: 'abc-123', customTitle: 'com nome', contextTokens: 60_010 });
  });
});

// T606 — a leitura de cauda em si, isolada do watcher: uma passada, dois
// campos. `fs` real em tmpdir (o que pode dar errado aqui é justamente o que um
// mock esconderia: linha cortada, arquivo ausente, arquivo vazio).
describe('readTranscriptTail', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'donel-dev-transcript-tail-'));
    filePath = join(dir, 'abc-123.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('devolve os dois campos numa leitura só', async () => {
    await fs.writeFile(
      filePath,
      `${userLine('oi')}${assistantUsageLine({ input: 290, cacheCreation: 1505, cacheRead: 132_807 })}${titleLine('nome')}`,
      'utf8',
    );

    await expect(readTranscriptTail(filePath)).resolves.toEqual({ customTitle: 'nome', contextTokens: 134_602 });
  });

  it('último de cada um vence, independente da ordem entre eles', async () => {
    await fs.writeFile(
      filePath,
      [
        titleLine('nome antigo'),
        assistantUsageLine({ input: 1, cacheRead: 1_000 }),
        titleLine('nome novo'),
        assistantUsageLine({ input: 2, cacheRead: 2_000 }),
      ].join(''),
      'utf8',
    );

    await expect(readTranscriptTail(filePath)).resolves.toEqual({ customTitle: 'nome novo', contextTokens: 2_002 });
  });

  it('linha cortada no início do chunk (a cauda corta no meio de uma linha) não lança', async () => {
    // Arquivo maior que a cauda: a leitura começa no meio de uma linha gigante.
    const giant = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(70 * 1024) } })}\n`;
    await fs.writeFile(filePath, `${giant}${assistantUsageLine({ input: 5, cacheRead: 500 })}${titleLine('sobreviveu')}`, 'utf8');

    await expect(readTranscriptTail(filePath)).resolves.toEqual({ customTitle: 'sobreviveu', contextTokens: 505 });
  });

  it('arquivo vazio → os dois null', async () => {
    await fs.writeFile(filePath, '', 'utf8');
    await expect(readTranscriptTail(filePath)).resolves.toEqual({ customTitle: null, contextTokens: null });
  });

  it('arquivo inexistente → os dois null, sem lançar', async () => {
    await expect(readTranscriptTail(join(dir, 'nao-existe.jsonl'))).resolves.toEqual({
      customTitle: null,
      contextTokens: null,
    });
  });

  it('transcript sem nenhuma usage e sem título → os dois null (não 0)', async () => {
    await fs.writeFile(filePath, `${userLine('só conversa')}${userLine('mais conversa')}`, 'utf8');
    await expect(readTranscriptTail(filePath)).resolves.toEqual({ customTitle: null, contextTokens: null });
  });
});

// T412 — ciclo de vida: um watcher por aba `claude` viva, baixa no
// `PtyManager.onExit`. O que este bloco prova é o que a Fatia 3 do plano marcou
// como o risco da fase: handle vazado. `watchFn` fake porque aqui o objeto de
// teste é o REGISTRO, não o `fs.watch` (esse já tem os testes acima).
describe('TranscriptWatcherRegistry', () => {
  function makeRegistry() {
    const disposed: string[] = [];
    const started: string[] = [];
    const watchFn = (options: TranscriptWatcherOptions): TranscriptWatcherHandle => {
      started.push(options.sessionId);
      return { dispose: () => disposed.push(options.sessionId) };
    };
    return { registry: new TranscriptWatcherRegistry(watchFn), disposed, started };
  }

  const optionsFor = (id: string): TranscriptWatcherOptions => ({
    sessionId: id,
    filePath: `C:\fake\${id}.jsonl`,
    onChange: () => undefined,
  });

  it('6 abas abertas e fechadas → 0 handles (DoD do T412)', () => {
    const { registry, disposed } = makeRegistry();
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];

    for (const id of ids) registry.start(`pty-${id}`, optionsFor(id));
    expect(registry.size).toBe(6);

    for (const id of ids) registry.stop(`pty-${id}`);
    expect(registry.size).toBe(0);
    expect(disposed).toEqual(ids);
  });

  it('reabrir a MESMA aba fecha o watcher anterior em vez de acumular dois no mesmo arquivo', () => {
    const { registry, disposed } = makeRegistry();
    registry.start('pty-1', optionsFor('s1'));
    registry.start('pty-1', optionsFor('s1-retomada'));

    expect(registry.size).toBe(1);
    expect(disposed).toEqual(['s1']);
  });

  it('stop de aba que nunca abriu watcher (terminal livre) é no-op e não lança', () => {
    const { registry, disposed } = makeRegistry();
    expect(() => registry.stop('pty-shell')).not.toThrow();
    expect(disposed).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it('disposeAll fecha tudo (janela fechada leva os PTYs e os watchers)', () => {
    const { registry, disposed } = makeRegistry();
    registry.start('pty-1', optionsFor('s1'));
    registry.start('pty-2', optionsFor('s2'));

    registry.disposeAll();

    expect(registry.size).toBe(0);
    expect(disposed).toEqual(['s1', 's2']);
  });
});
