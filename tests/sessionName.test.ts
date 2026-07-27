import { describe, expect, it } from 'vitest';
import {
  SESSION_NAME_MAX_LENGTH,
  extractCustomTitle,
  normalizeSessionName,
  reconcileStoredName,
  resolveSessionName,
  type StoredSessionName,
} from '../src/shared/sessionName';

// T401 (004-nomear-sessoes) — módulo puro onde a feature se decide: qual nome
// aparece na aba/sidebar. Duas fontes concorrentes (o `custom-title` que o
// `/rename` do CLI grava no `.jsonl` e o nome digitado na UI, persistido no
// ConfigStore) resolvidas pelo dirty-check da decisão C2 do clarify.
// Schema real confirmado em transcritos do próprio donel-dev:
// {"type":"custom-title","customTitle":"…","sessionId":"…"} — pode repetir,
// o ÚLTIMO vence (spec.md §Notas de realidade).

const line = (type: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, sessionId: 'abc-123', ...extra });

const userLine = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

const stored = (name: string, seenTitle: string | null): StoredSessionName => ({
  name,
  seenTitle,
  updatedAt: '2026-07-24T12:00:00.000Z',
});

describe('extractCustomTitle', () => {
  it('devolve o customTitle quando há um único registro', () => {
    const tail = [userLine('oi'), line('custom-title', { customTitle: 'Refatorar o indexer' })].join('\n');
    expect(extractCustomTitle(tail)).toBe('Refatorar o indexer');
  });

  it('devolve o ÚLTIMO customTitle quando há vários (nunca o primeiro)', () => {
    const tail = [
      line('custom-title', { customTitle: 'primeiro' }),
      userLine('trabalho'),
      line('custom-title', { customTitle: 'segundo' }),
      userLine('mais trabalho'),
      line('custom-title', { customTitle: 'terceiro' }),
    ].join('\n');
    expect(extractCustomTitle(tail)).toBe('terceiro');
  });

  it('tolera a primeira linha cortada ao meio (a leitura de 8 KB corta o arquivo)', () => {
    const full = line('custom-title', { customTitle: 'ignorado' });
    const tail = [full.slice(20), line('custom-title', { customTitle: 'válido' })].join('\n');
    expect(extractCustomTitle(tail)).toBe('válido');
  });

  it('ignora linha cortada ao meio mesmo quando é a única com custom-title', () => {
    const full = line('custom-title', { customTitle: 'perdido' });
    expect(extractCustomTitle(full.slice(15))).toBeNull();
  });

  it('ignora linhas que não são JSON', () => {
    const tail = ['isto não é json', '{quebrado', line('custom-title', { customTitle: 'ok' })].join('\n');
    expect(extractCustomTitle(tail)).toBe('ok');
  });

  it('devolve null quando não há nenhum custom-title', () => {
    const tail = [userLine('oi'), line('assistant'), line('summary', { summary: 'x' })].join('\n');
    expect(extractCustomTitle(tail)).toBeNull();
  });

  it('devolve null para texto vazio', () => {
    expect(extractCustomTitle('')).toBeNull();
    expect(extractCustomTitle('   \n  \n')).toBeNull();
  });

  it('ignora customTitle vazio ou só-espaços, caindo no registro válido anterior', () => {
    const tail = [
      line('custom-title', { customTitle: 'nome bom' }),
      line('custom-title', { customTitle: '   ' }),
    ].join('\n');
    expect(extractCustomTitle(tail)).toBe('nome bom');
  });

  it('ignora custom-title sem o campo customTitle', () => {
    expect(extractCustomTitle(line('custom-title'))).toBeNull();
  });

  it('ignora customTitle que não é string', () => {
    expect(extractCustomTitle(line('custom-title', { customTitle: 42 }))).toBeNull();
  });

  it('faz trim do título', () => {
    expect(extractCustomTitle(line('custom-title', { customTitle: '  com espaço  ' }))).toBe('com espaço');
  });

  it('tolera CRLF', () => {
    const tail = [userLine('oi'), line('custom-title', { customTitle: 'crlf ok' })].join('\r\n');
    expect(extractCustomTitle(tail)).toBe('crlf ok');
  });
});

describe('resolveSessionName — dirty-check do C2', () => {
  it('sem stored e sem customTitle → fallback (CA-2, nada regride)', () => {
    expect(resolveSessionName({ fallback: 'donel-dev', customTitle: null, stored: null })).toBe('donel-dev');
  });

  it('sem stored e com customTitle → customTitle (CA-1)', () => {
    expect(resolveSessionName({ fallback: 'donel-dev', customTitle: 'do CLI', stored: null })).toBe('do CLI');
  });

  it('stored com seenTitle null e customTitle null → nome da UI vence', () => {
    expect(
      resolveSessionName({ fallback: 'donel-dev', customTitle: null, stored: stored('da UI', null) }),
    ).toBe('da UI');
  });

  it('stored cujo seenTitle é IGUAL ao customTitle atual → nome da UI vence', () => {
    expect(
      resolveSessionName({ fallback: 'donel-dev', customTitle: 'do CLI', stored: stored('da UI', 'do CLI') }),
    ).toBe('da UI');
  });

  it('stored cujo seenTitle é DIFERENTE do customTitle atual → o /rename novo do CLI vence', () => {
    expect(
      resolveSessionName({ fallback: 'donel-dev', customTitle: 'renomeado depois', stored: stored('da UI', 'do CLI') }),
    ).toBe('renomeado depois');
  });

  it('stored sem seenTitle e customTitle que apareceu depois → CLI vence', () => {
    expect(
      resolveSessionName({ fallback: 'donel-dev', customTitle: 'apareceu', stored: stored('da UI', null) }),
    ).toBe('apareceu');
  });

  it('customTitle sumiu (transcript ilegível) → mantém o nome da UI, não volta pro fallback', () => {
    expect(
      resolveSessionName({ fallback: 'donel-dev', customTitle: null, stored: stored('da UI', 'do CLI') }),
    ).toBe('da UI');
  });

  it('nunca devolve string vazia — stored com nome vazio cai no fallback', () => {
    expect(
      resolveSessionName({ fallback: 'donel-dev', customTitle: null, stored: stored('   ', null) }),
    ).toBe('donel-dev');
  });
});

// T406 — validação do C5. Mora aqui (módulo puro, compartilhado) porque quem
// PERSISTE é o main: a UI valida para dar feedback, o main valida porque é ele
// que grava. `null` significa "apagar o nome" — a válvula de escape do C5 para
// voltar ao fallback.
describe('normalizeSessionName — regras do C5', () => {
  it('faz trim', () => {
    expect(normalizeSessionName('  Refatorar o indexer  ')).toBe('Refatorar o indexer');
  });

  it('corta em 60 caracteres', () => {
    const long = 'a'.repeat(61);
    const normalized = normalizeSessionName(long);
    expect(normalized).toHaveLength(SESSION_NAME_MAX_LENGTH);
    expect(normalized).toBe('a'.repeat(60));
  });

  it('não mexe em nome de exatamente 60 caracteres', () => {
    const exact = 'b'.repeat(60);
    expect(normalizeSessionName(exact)).toBe(exact);
  });

  it('quebras de linha (\\n e \\r\\n) viram espaço, sem virar espaço duplo', () => {
    expect(normalizeSessionName('linha um\nlinha dois')).toBe('linha um linha dois');
    expect(normalizeSessionName('linha um\r\nlinha dois')).toBe('linha um linha dois');
    expect(normalizeSessionName('a\n\n\nb')).toBe('a b');
    expect(normalizeSessionName('a\tb')).toBe('a b');
  });

  it('string vazia e só-espaços → null (apaga o nome, volta ao fallback)', () => {
    expect(normalizeSessionName('')).toBeNull();
    expect(normalizeSessionName('   ')).toBeNull();
    expect(normalizeSessionName('\n\n')).toBeNull();
    expect(normalizeSessionName('\t \r\n ')).toBeNull();
  });

  it('não deixa espaço sobrando quando o corte de 60 cai num espaço', () => {
    const raw = `${'c'.repeat(59)} palavra cortada`;
    expect(normalizeSessionName(raw)).toBe('c'.repeat(59));
  });

  it('preserva acento e emoji (o corte é por caractere, não por byte)', () => {
    expect(normalizeSessionName('  Sessões — investigação ✅  ')).toBe('Sessões — investigação ✅');
  });

  it('valor não-string (vindo de IPC malformado) → null, sem lançar', () => {
    expect(normalizeSessionName(undefined as unknown as string)).toBeNull();
    expect(normalizeSessionName(42 as unknown as string)).toBeNull();
    expect(normalizeSessionName(null as unknown as string)).toBeNull();
  });
});

describe('reconcileStoredName', () => {
  it('sem stored → null', () => {
    expect(reconcileStoredName(null, 'qualquer')).toBeNull();
  });

  it('UI vence (seenTitle igual) → mantém a entrada intacta', () => {
    const entry = stored('da UI', 'do CLI');
    expect(reconcileStoredName(entry, 'do CLI')).toBe(entry);
  });

  it('CLI vence (seenTitle diferente) → descarta a entrada, para o storage não acumular nome morto', () => {
    expect(reconcileStoredName(stored('da UI', 'do CLI'), 'renomeado depois')).toBeNull();
  });

  it('customTitle sumiu → mantém a entrada (não é um /rename, é leitura falha)', () => {
    const entry = stored('da UI', 'do CLI');
    expect(reconcileStoredName(entry, null)).toBe(entry);
  });
});
