import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_PREVIEW_LENGTH,
  TAIL_READ_BYTES,
  clearSessionTailCache,
  indexProjectSessions,
  readLastActivity,
  readSessionPreview,
  readSessionTailInfo,
  resolveProjectSessionsDir,
  slugifyProjectPath,
} from '../src/main/session-indexer';

// T012 — SessionIndexer (FR-004, plan.md ponto 4). Fixtures sintéticas fiéis
// ao formato real de `~/.claude/projects/<slug>/*.jsonl`, construídas a
// partir da inspeção de transcripts reais nesta máquina (conteúdo
// placeholder, nenhum dado sensível) — ver tests/fixtures/sessions/.

const FIXTURES_DIR = join(__dirname, 'fixtures', 'sessions');

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

async function sizeOf(path: string): Promise<number> {
  const stats = await fs.stat(path);
  return stats.size;
}

describe('slugifyProjectPath', () => {
  it('replaces every non-alphanumeric character with a dash, one for one', () => {
    expect(slugifyProjectPath('C:\\Users\\xansd\\seazone\\donel-dev')).toBe(
      'C--Users-xansd-seazone-donel-dev',
    );
  });

  it('matches the real slug for a project path with a dot in it (spec.md FR-004 example)', () => {
    // Confirmado contra um diretório real na máquina:
    // `C:\Users\xansd\.no-mistakes-worktrees\...` -> `C--Users-xansd--no-mistakes-worktrees-...`
    expect(slugifyProjectPath('C:\\Users\\xansd\\.no-mistakes-worktrees\\abc')).toBe(
      'C--Users-xansd--no-mistakes-worktrees-abc',
    );
  });

  it('slugifies the fixture project path used by the indexProjectSessions integration test', () => {
    expect(slugifyProjectPath('C:\\Users\\test\\.acme-app')).toBe('C--Users-test--acme-app');
  });
});

describe('resolveProjectSessionsDir', () => {
  it('joins claudeHome/projects/<slug>', () => {
    expect(resolveProjectSessionsDir('C:\\Users\\test\\.acme-app', 'C:\\Users\\test\\.claude')).toBe(
      join('C:\\Users\\test\\.claude', 'projects', 'C--Users-test--acme-app'),
    );
  });
});

describe('readSessionPreview — filtros do FR-004', () => {
  it('skips leading control records (custom-title, mode, attachment/hook) and finds the first genuine user message', async () => {
    const path = fixturePath('opens-with-control-records.jsonl');
    const result = await readSessionPreview(path, await sizeOf(path));

    expect(result).toEqual({
      preview: 'Summarize the placeholder document and list the next three action items.',
      corrupted: false,
    });
  });

  it('skips isMeta:true lines and slash-command payloads (<command-*>, <local-command-*>)', async () => {
    const path = fixturePath('slash-command-and-meta.jsonl');
    const result = await readSessionPreview(path, await sizeOf(path));

    expect(result).toEqual({
      preview: 'Check the placeholder API status page and report anything red.',
      corrupted: false,
    });
  });

  it('falls back to "(sem mensagem de usuário)" for a well-formed transcript with no user message', async () => {
    const path = fixturePath('only-control-no-user.jsonl');
    const result = await readSessionPreview(path, await sizeOf(path));

    expect(result).toEqual({ preview: '(sem mensagem de usuário)', corrupted: false });
  });

  it('tolerates a corrupted line without derailing the scan — finds the genuine message after it', async () => {
    const path = fixturePath('corrupted-lines-then-user.jsonl');
    const result = await readSessionPreview(path, await sizeOf(path));

    expect(result).toEqual({
      preview: 'Draft a placeholder release note for version 1.2.0.',
      corrupted: false,
    });
  });

  it('reports "(ilegível)" + corrupted:true when no line can be parsed at all', async () => {
    const path = fixturePath('fully-corrupted.jsonl');
    const result = await readSessionPreview(path, await sizeOf(path));

    expect(result).toEqual({ preview: '(ilegível)', corrupted: true });
  });

  it('treats a 0-byte transcript as "(sem mensagem de usuário)", not corrupted', async () => {
    const path = fixturePath('empty.jsonl');
    expect(await sizeOf(path)).toBe(0);

    const result = await readSessionPreview(path, 0);

    expect(result).toEqual({ preview: '(sem mensagem de usuário)', corrupted: false });
  });

  it('skips a user message whose content is only a tool_result block (not typed by the user), and finds the real one after it', async () => {
    const path = fixturePath('tool-result-only-then-user.jsonl');
    const result = await readSessionPreview(path, await sizeOf(path));

    expect(result).toEqual({
      preview: 'Now write a placeholder haiku about deployment pipelines.',
      corrupted: false,
    });
  });

  it('extracts the text block out of an array-shaped content (text + image)', async () => {
    const path = fixturePath('array-content-with-text.jsonl');
    const result = await readSessionPreview(path, await sizeOf(path));

    expect(result).toEqual({
      preview: 'Review the attached placeholder screenshot and list issues.',
      corrupted: false,
    });
  });

  it('treats a whitespace-only user message as not genuine', async () => {
    const path = fixturePath('whitespace-only-user-message.jsonl');
    const result = await readSessionPreview(path, await sizeOf(path));

    expect(result).toEqual({ preview: '(sem mensagem de usuário)', corrupted: false });
  });

  it('normalizes whitespace/newlines and truncates long previews to MAX_PREVIEW_LENGTH', async () => {
    const path = fixturePath('long-preview.jsonl');
    const result = await readSessionPreview(path, await sizeOf(path));

    expect(result.corrupted).toBe(false);
    expect(result.preview.length).toBe(MAX_PREVIEW_LENGTH);
    expect(result.preview.endsWith('…')).toBe(true);
    expect(result.preview).not.toContain('\n');
    expect(result.preview.startsWith('Line one of a very long placeholder request')).toBe(true);
  });
});

describe('readLastActivity — tail opcional (plan.md ponto 4)', () => {
  it('returns the timestamp of the last valid line in the file', async () => {
    const path = fixturePath('tail-activity.jsonl');
    const size = await sizeOf(path);

    const result = await readLastActivity(path, size);

    expect(result).toBe(Date.parse('2026-01-02T09:05:42.000Z'));
  });

  it('returns null for a 0-byte file without throwing', async () => {
    const result = await readLastActivity(fixturePath('empty.jsonl'), 0);
    expect(result).toBeNull();
  });

  it('returns null (never throws) when the tail has no parseable line with a timestamp', async () => {
    const path = fixturePath('fully-corrupted.jsonl');
    const size = await sizeOf(path);

    const result = await readLastActivity(path, size);

    expect(result).toBeNull();
  });

  it('returns null for a nonexistent file without throwing', async () => {
    const result = await readLastActivity(fixturePath('does-not-exist.jsonl'), 100);
    expect(result).toBeNull();
  });
});

// T403 (004-nomear-sessoes) — o indexer passa a devolver o `custom-title` que
// o `/rename` do CLI grava no transcript (CA-1). A leitura de cauda é a MESMA
// do `lastActivityAt` (uma passada só). O gotcha que a task manda resolver, e
// não contornar: um `/rename` feito no COMEÇO de uma sessão longa fica FORA da
// cauda de 8 KB — que é exatamente o caso de uso do Alexandre (reachar sessão
// de semanas atrás). Daí o fallback de varredura completa.
describe('readSessionTailInfo — custom-title + última atividade numa leitura só (T403)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'donel-dev-indexer-title-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeTranscript(name: string, lines: string[]): Promise<{ path: string; size: number }> {
    const path = join(dir, name);
    await fs.writeFile(path, `${lines.join('\n')}\n`, 'utf8');
    return { path, size: await sizeOf(path) };
  }

  const titleLine = (title: string): string =>
    JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 'abc-123' });

  const userLine = (text: string, timestamp: string): string =>
    JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: text } });

  it('devolve o custom-title quando ele está na cauda', async () => {
    const { path, size } = await writeTranscript('tail-title.jsonl', [
      userLine('trabalho', '2026-01-02T09:00:00.000Z'),
      titleLine('Nomear sessões'),
    ]);

    const info = await readSessionTailInfo(path, size);

    expect(info.customTitle).toBe('Nomear sessões');
  });

  it('com vários custom-title, o ÚLTIMO vence', async () => {
    const { path, size } = await writeTranscript('multi-title.jsonl', [
      titleLine('primeiro'),
      userLine('trabalho', '2026-01-02T09:00:00.000Z'),
      titleLine('segundo'),
      userLine('mais', '2026-01-02T09:01:00.000Z'),
      titleLine('terceiro'),
    ]);

    const info = await readSessionTailInfo(path, size);

    expect(info.customTitle).toBe('terceiro');
  });

  it('acha o custom-title que está SÓ no começo de um arquivo maior que a cauda de 8 KB (o gotcha do caso de uso)', async () => {
    const filler = Array.from({ length: 700 }, (_, i) =>
      userLine(`linha de enchimento razoavelmente longa numero ${i} para estourar a cauda`, '2026-01-02T09:00:00.000Z'),
    );
    const { path, size } = await writeTranscript('long-head-title.jsonl', [titleLine('Renomeado no começo'), ...filler]);

    expect(size).toBeGreaterThan(TAIL_READ_BYTES);
    const info = await readSessionTailInfo(path, size);

    expect(info.customTitle).toBe('Renomeado no começo');
  });

  it('num arquivo longo, um custom-title na cauda ganha do que está no começo', async () => {
    const filler = Array.from({ length: 700 }, (_, i) =>
      userLine(`linha de enchimento razoavelmente longa numero ${i} para estourar a cauda`, '2026-01-02T09:00:00.000Z'),
    );
    const { path, size } = await writeTranscript('long-both-titles.jsonl', [
      titleLine('antigo do começo'),
      ...filler,
      titleLine('renomeado depois'),
    ]);

    expect(size).toBeGreaterThan(TAIL_READ_BYTES);
    const info = await readSessionTailInfo(path, size);

    expect(info.customTitle).toBe('renomeado depois');
  });

  it('devolve null quando não há custom-title nenhum (CA-2: fallback intacto)', async () => {
    const { path, size } = await writeTranscript('no-title.jsonl', [
      userLine('só trabalho', '2026-01-02T09:00:00.000Z'),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-02T09:00:10.000Z' }),
    ]);

    const info = await readSessionTailInfo(path, size);

    expect(info.customTitle).toBeNull();
  });

  it('devolve o lastActivityAt na MESMA chamada (uma leitura, dois campos)', async () => {
    const { path, size } = await writeTranscript('both-fields.jsonl', [
      titleLine('Com os dois'),
      userLine('trabalho', '2026-01-02T09:05:42.000Z'),
    ]);

    const info = await readSessionTailInfo(path, size);

    expect(info).toEqual({ customTitle: 'Com os dois', lastActivityAt: Date.parse('2026-01-02T09:05:42.000Z') });
  });

  it('arquivo de 0 byte e arquivo inexistente não lançam', async () => {
    const { path } = await writeTranscript('zero.jsonl', []);
    await fs.writeFile(path, '', 'utf8');

    expect(await readSessionTailInfo(path, 0)).toEqual({ customTitle: null, lastActivityAt: null });
    expect(await readSessionTailInfo(join(dir, 'nao-existe.jsonl'), 500)).toEqual({
      customTitle: null,
      lastActivityAt: null,
    });
  });

  it('transcript corrompido não lança e não inventa título', async () => {
    const { path, size } = await writeTranscript('garbage.jsonl', ['isto não é json', '{quebrado', '}{']);

    expect(await readSessionTailInfo(path, size)).toEqual({ customTitle: null, lastActivityAt: null });
  });

  // Cache exigido pela medição (754 ms no projeto mais pesado, acima do teto
  // de ~300 ms da task) — ver specs/004-nomear-sessoes/medicao-t403.md.
  describe('cache por mtime+size', () => {
    it('reusa o resultado quando mtime e size não mudaram — mesmo se o conteúdo mudou por baixo', async () => {
      clearSessionTailCache();
      const { path, size } = await writeTranscript('cache-hit.jsonl', [titleLine('v1-titulo-teste')]);
      const { mtimeMs } = await fs.stat(path);

      expect((await readSessionTailInfo(path, size, mtimeMs)).customTitle).toBe('v1-titulo-teste');

      // Reescreve com o MESMO tamanho e força o mesmo mtime: o cache deve
      // responder o valor antigo (é a prova de que não releu o disco).
      await fs.writeFile(path, `${titleLine('v2-titulo-teste')}\n`, 'utf8');
      await fs.utimes(path, new Date(mtimeMs), new Date(mtimeMs));
      const sameSize = await sizeOf(path);
      expect(sameSize).toBe(size);

      expect((await readSessionTailInfo(path, size, mtimeMs)).customTitle).toBe('v1-titulo-teste');
    });

    it('invalida quando o size muda (append é o caso real)', async () => {
      clearSessionTailCache();
      const { path, size } = await writeTranscript('cache-append.jsonl', [titleLine('antes')]);
      const first = await fs.stat(path);
      expect((await readSessionTailInfo(path, size, first.mtimeMs)).customTitle).toBe('antes');

      await fs.appendFile(path, `${titleLine('depois')}\n`, 'utf8');
      const second = await fs.stat(path);

      expect((await readSessionTailInfo(path, second.size, second.mtimeMs)).customTitle).toBe('depois');
    });

    it('sem mtime (chamada de 2 argumentos) nunca usa cache', async () => {
      clearSessionTailCache();
      const { path, size } = await writeTranscript('cache-bypass.jsonl', [titleLine('v1')]);
      expect((await readSessionTailInfo(path, size)).customTitle).toBe('v1');

      await fs.writeFile(path, `${titleLine('v2')}\n`, 'utf8');
      expect((await readSessionTailInfo(path, await sizeOf(path))).customTitle).toBe('v2');
    });
  });
});

describe('indexProjectSessions — integração (FR-004, CA-2)', () => {
  const claudeHome = fixturePath('claude-home');
  const projectPath = 'C:\\Users\\test\\.acme-app';
  const projectDir = join(claudeHome, 'projects', 'C--Users-test--acme-app');

  beforeAll(async () => {
    // Datas determinísticas pra travar a ordenação por mtime (CA-2: "as 3
    // sessões aparecem ordenadas por data").
    const older = new Date('2026-01-03T08:00:00.000Z');
    const newer = new Date('2026-01-03T09:00:00.000Z');
    const newest = new Date('2026-01-03T10:00:00.000Z');

    await fs.utimes(join(projectDir, 'aaaaaaaa-1111-1111-1111-111111111111.jsonl'), older, older);
    await fs.utimes(join(projectDir, 'bbbbbbbb-2222-2222-2222-222222222222.jsonl'), newer, newer);
    await fs.utimes(join(projectDir, 'cccccccc-3333-3333-3333-333333333333.jsonl'), newest, newest);
  });

  it('lists only the top-level *.jsonl files, sorted by mtime descending', async () => {
    const sessions = await indexProjectSessions(projectPath, { claudeHome });

    expect(sessions.map((s) => s.id)).toEqual([
      'cccccccc-3333-3333-3333-333333333333',
      'bbbbbbbb-2222-2222-2222-222222222222',
      'aaaaaaaa-1111-1111-1111-111111111111',
    ]);
  });

  it('excludes subagent transcripts nested under <session-id>/subagents/ and non-.jsonl files', async () => {
    const sessions = await indexProjectSessions(projectPath, { claudeHome });

    expect(sessions.some((s) => s.id.includes('subagent') || s.filePath.includes('subagents'))).toBe(
      false,
    );
    expect(sessions.some((s) => s.filePath.endsWith('notes.txt'))).toBe(false);
    expect(sessions.some((s) => s.filePath.endsWith('stray.json'))).toBe(false);
    expect(sessions).toHaveLength(3);
  });

  it('carries preview/corrupted through end to end for a genuine and a corrupted transcript', async () => {
    const sessions = await indexProjectSessions(projectPath, { claudeHome });

    const genuine = sessions.find((s) => s.id === 'bbbbbbbb-2222-2222-2222-222222222222');
    expect(genuine?.preview).toBe('Placeholder request for the newest session in this project fixture.');
    expect(genuine?.corrupted).toBe(false);

    const corrupted = sessions.find((s) => s.id === 'cccccccc-3333-3333-3333-333333333333');
    expect(corrupted?.preview).toBe('(ilegível)');
    expect(corrupted?.corrupted).toBe(true);
  });

  // T403 — CA-1 ponta a ponta: o campo chega no SessionSummary que o main
  // devolve ao renderer, ao lado do `preview` (que continua sendo o fallback).
  it('propaga customTitle no summary, e null para quem não tem (CA-1 + CA-2)', async () => {
    const sessions = await indexProjectSessions(projectPath, { claudeHome });

    const withTitle = sessions.find((s) => s.id === 'bbbbbbbb-2222-2222-2222-222222222222');
    expect(withTitle?.customTitle).toBe('Second placeholder session');
    expect(withTitle?.preview).toBe('Placeholder request for the newest session in this project fixture.');

    const corrupted = sessions.find((s) => s.id === 'cccccccc-3333-3333-3333-333333333333');
    expect(corrupted?.customTitle).toBeNull();
    expect(corrupted?.corrupted).toBe(true);
  });

  it('returns [] for a project that never had a Claude Code session, without throwing', async () => {
    const sessions = await indexProjectSessions('C:\\Users\\test\\.never-opened', { claudeHome });
    expect(sessions).toEqual([]);
  });
});
