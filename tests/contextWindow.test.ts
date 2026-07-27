import { describe, expect, it } from 'vitest';
import {
  MODEL_CONTEXT_WINDOWS,
  SMART_ZONE_TOKENS,
  computeContextPercent,
  contextTokensFromLine,
  contextTokensFromUsage,
  effectiveContextZone,
  formatContextTooltip,
  isOverSmartZone,
  normalizeModelAlias,
} from '../src/shared/contextWindow';

// T601–T604 (006-contexto-consumido, Fatia 0) — núcleo PURO do indicador de
// contexto: a tabela de janelas, a soma da `usage` e a aritmética do `%`.
//
// É a parte que não pode estar errada e é 100% pura (sem Electron/fs/React),
// então é a única do plano com TDD de verdade. Cada bloco abaixo é a evidência
// de um critério de aceite nomeado na spec — quando um deles quebrar, o nome do
// teste diz qual decisão do Alexandre foi violada, não só qual função.

describe('MODEL_CONTEXT_WINDOWS (T601)', () => {
  it('mapeia os 4 aliases para as janelas conferidas em 2026-07-24 (spec §S1/C2)', () => {
    expect(MODEL_CONTEXT_WINDOWS).toEqual({
      fable: 1_000_000,
      opus: 1_000_000,
      sonnet: 1_000_000,
      haiku: 200_000,
    });
  });
});

describe('normalizeModelAlias (T601)', () => {
  it('devolve o próprio alias quando já é um dos 4 conhecidos', () => {
    expect(normalizeModelAlias('opus')).toBe('opus');
    expect(normalizeModelAlias('haiku')).toBe('haiku');
  });

  it('faz strip de sufixo de deployment entre colchetes (`[1m]` não é model ID)', () => {
    expect(normalizeModelAlias('opus[1m]')).toBe('opus');
    expect(normalizeModelAlias('sonnet[1m]')).toBe('sonnet');
  });

  it('tolera espaço e caixa alta (valor vindo de argv/config editado à mão)', () => {
    expect(normalizeModelAlias('  Opus  ')).toBe('opus');
  });

  it('alias desconhecido → null (o chamador exibe `—`; NUNCA chutar uma janela)', () => {
    expect(normalizeModelAlias('gpt-4')).toBeNull();
    expect(normalizeModelAlias('')).toBeNull();
    expect(normalizeModelAlias('claude-opus-5')).toBeNull();
  });
});

describe('effectiveContextZone (T601)', () => {
  it('em opus/sonnet/fable a smart zone (300k) vence — é o denominador do %', () => {
    expect(SMART_ZONE_TOKENS).toBe(300_000);
    expect(effectiveContextZone('opus')).toBe(300_000);
    expect(effectiveContextZone('sonnet')).toBe(300_000);
    expect(effectiveContextZone('fable')).toBe(300_000);
  });

  it('em haiku a JANELA (200k) vence o min — zona de 300k ali seria mentira', () => {
    expect(effectiveContextZone('haiku')).toBe(200_000);
  });
});

describe('contextTokensFromUsage (T602)', () => {
  const realUsage = {
    input_tokens: 290,
    cache_creation_input_tokens: 1505,
    cache_read_input_tokens: 132807,
    output_tokens: 1177,
  };

  it('soma input + cache_read + cache_creation da usage real da spec (C1)', () => {
    expect(contextTokensFromUsage(realUsage)).toBe(134_602);
  });

  it('NÃO conta output_tokens (é geração, não contexto de entrada)', () => {
    expect(contextTokensFromUsage({ output_tokens: 900 })).toBeNull();
  });

  it('campo ausente conta 0, desde que exista pelo menos um dos três', () => {
    expect(contextTokensFromUsage({ input_tokens: 500 })).toBe(500);
    expect(contextTokensFromUsage({ cache_read_input_tokens: 132_807 })).toBe(132_807);
    // Zero EXPLÍCITO num dos três é leitura válida de "contexto zerado", não ausência.
    expect(contextTokensFromUsage({ input_tokens: 0 })).toBe(0);
  });

  it('usage sem NENHUM dos três → null, nunca 0 (CA-4: `—`, não `0%`)', () => {
    expect(contextTokensFromUsage({})).toBeNull();
    expect(contextTokensFromUsage({ service_tier: 'standard' })).toBeNull();
  });

  it('valor não-objeto ou lixo não lança e vira null (a entrada vem de JSON.parse)', () => {
    expect(contextTokensFromUsage(null)).toBeNull();
    expect(contextTokensFromUsage(undefined)).toBeNull();
    expect(contextTokensFromUsage('134602')).toBeNull();
    expect(contextTokensFromUsage(42)).toBeNull();
    expect(contextTokensFromUsage([])).toBeNull();
  });

  it('campo dos três com tipo errado é ignorado em vez de virar NaN', () => {
    expect(contextTokensFromUsage({ input_tokens: 'muitos', cache_read_input_tokens: 100 })).toBe(100);
    expect(contextTokensFromUsage({ input_tokens: Number.NaN })).toBeNull();
  });
});

// A `usage` fica em `message.usage`, NÃO no topo da linha — conferido no disco
// em 26/07 (o fragmento `"usage":{…}` da spec é um recorte). Ver
// `specs/006-contexto-consumido/medicao-t606.md`.
describe('contextTokensFromLine (T602 — forma real da linha do transcript)', () => {
  const assistantLine = (usage: unknown, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage }, ...extra });

  it('lê a soma de `message.usage` de uma linha assistant real', () => {
    const line = assistantLine({
      input_tokens: 528,
      cache_creation_input_tokens: 7309,
      cache_read_input_tokens: 817_148,
      output_tokens: 3514,
      // A usage real também traz `iterations[]` repetindo os mesmos nomes por
      // iteração — só o nível de cima conta, sob pena de dupla contagem.
      iterations: [{ input_tokens: 528, cache_read_input_tokens: 817_148, cache_creation_input_tokens: 7309 }],
    });
    expect(contextTokensFromLine(line)).toBe(824_985);
  });

  it('ignora linha que não é assistant (user, custom-title, tool_result)', () => {
    expect(contextTokensFromLine(JSON.stringify({ type: 'user', message: { usage: { input_tokens: 9 } } }))).toBeNull();
    expect(contextTokensFromLine(JSON.stringify({ type: 'custom-title', customTitle: 'x' }))).toBeNull();
  });

  it('ignora turno de SUBAGENTE (`isSidechain: true`) — o contexto dele não é o da sessão', () => {
    expect(contextTokensFromLine(assistantLine({ input_tokens: 30_000 }, { isSidechain: true }))).toBeNull();
  });

  it('linha cortada ao meio pela leitura de cauda não lança — devolve null', () => {
    expect(contextTokensFromLine('_tokens":528,"cache_read_input_tokens":817148}}')).toBeNull();
    expect(contextTokensFromLine('')).toBeNull();
    expect(contextTokensFromLine('   ')).toBeNull();
  });

  it('assistant sem usage (ou com usage inútil) → null', () => {
    expect(contextTokensFromLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }))).toBeNull();
    expect(contextTokensFromLine(assistantLine({ output_tokens: 100 }))).toBeNull();
  });
});

describe('computeContextPercent (T603)', () => {
  it('134.602 tokens em opus → 45% (CA-2: denominador é a smart zone de 300k)', () => {
    expect(computeContextPercent(134_602, 'opus')).toBe(45);
  });

  it('os MESMOS tokens em haiku → 67% (CA-6 no nível puro: a janela menor vence)', () => {
    expect(computeContextPercent(134_602, 'haiku')).toBe(67);
  });

  it('380k em opus → 127%: o % NÃO tem teto (CA-8) — travar em 100% apagaria a diferença entre 305k e 700k', () => {
    expect(computeContextPercent(380_000, 'opus')).toBe(127);
    expect(computeContextPercent(700_000, 'opus')).toBe(233);
  });

  it('tokens = 0 → 0 (leitura válida de contexto vazio)', () => {
    expect(computeContextPercent(0, 'opus')).toBe(0);
  });

  it('tokens = null → null, nunca 0% (CA-4: sessão sem usage mostra `—`)', () => {
    expect(computeContextPercent(null, 'opus')).toBeNull();
  });

  it('piso em 0: valor negativo (transcript corrompido) não vira % negativo', () => {
    expect(computeContextPercent(-500, 'opus')).toBe(0);
  });

  it('alias desconhecido → null (não escolhe uma janela chutada)', () => {
    expect(computeContextPercent(134_602, 'gpt-4')).toBeNull();
  });

  it('aceita alias com sufixo de deployment', () => {
    expect(computeContextPercent(134_602, 'opus[1m]')).toBe(45);
  });
});

describe('isOverSmartZone (T612 / CA-9)', () => {
  it('o gatilho da cor de alerta é > 100, não >= 100', () => {
    expect(isOverSmartZone(45)).toBe(false);
    expect(isOverSmartZone(100)).toBe(false); // limite cumprido não é estouro
    expect(isOverSmartZone(101)).toBe(true);
    expect(isOverSmartZone(127)).toBe(true);
  });

  it('sem leitura não há alerta — `—` é ausência de informação, não problema', () => {
    expect(isOverSmartZone(null)).toBe(false);
  });
});

describe('formatContextTooltip (T604 / CA-7)', () => {
  it('mostra a zona como denominador E a janela real do modelo, em pt-BR', () => {
    expect(formatContextTooltip(134_602, 'opus')).toBe(
      '134.602 / 300.000 tokens da smart zone · janela opus 1.000.000',
    );
  });

  it('em haiku a zona é a própria janela (200.000 nos dois lugares)', () => {
    expect(formatContextTooltip(134_602, 'haiku')).toBe(
      '134.602 / 200.000 tokens da smart zone · janela haiku 200.000',
    );
  });

  it('sem leitura de tokens → string vazia (sem tooltip, coerente com o `—`)', () => {
    expect(formatContextTooltip(null, 'opus')).toBe('');
  });

  it('alias desconhecido → string vazia (não inventa janela no tooltip)', () => {
    expect(formatContextTooltip(134_602, 'gpt-4')).toBe('');
  });
});
