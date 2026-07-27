import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HeadroomCache,
  parseQuotaAxiHeadroom,
  parseQuotaAxiWindows,
  readAllProfilesHeadroom,
  readQuotaAxiQuota,
  type QuotaAxiOutput,
} from '../src/main/quota-headroom';
import type { ProfileQuota } from '../src/shared/profiles';

// Mock de `node:child_process` — só pro bloco `readQuotaAxiQuota (I/O)`
// abaixo (fix rodada 4 item 8, parte a). `vi.mock` é hoisted pelo vitest
// pro topo do módulo automaticamente (mesmo espírito do jest) — a ordem
// textual com o `import { spawn }` acima não importa.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

/** Fake mínimo de `ChildProcess` — só o que `readQuotaAxiQuota` usa (`stdout`, `on('error'|'close')`, `kill`). */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly kill = vi.fn();
}

const UNAVAILABLE: ProfileQuota = { status: 'unavailable', fiveHour: null, sevenDay: null, fable: null };

// T014 — FR-012 (headroom por perfil via quota-axi). T201 (002-quota-headroom)
// — `parseQuotaAxiWindows` extrai as 3 janelas (`five_hour`/`seven_day`/
// `model:fable`) no shape `ProfileQuota`; `parseQuotaAxiHeadroom` vira
// seletor derivado (5h primária) em cima dela. A regra dura de stale/error
// (cache global do quota-axi pode devolver números de OUTRO perfil — ver
// comentário de topo do módulo) é testada nas duas.

const REAL_PAYLOAD_SHAPE: QuotaAxiOutput = {
  providers: [
    {
      provider: 'claude',
      windows: [
        { id: 'five_hour', kind: 'session', percentRemaining: 97, resetsAt: '2026-07-24T14:00:00.000Z' },
        { id: 'seven_day', kind: 'weekly', percentRemaining: 100, resetsAt: '2026-07-31T04:00:00.000Z' },
        { id: 'model:fable', kind: 'model', percentRemaining: 100 },
      ],
      state: { status: 'fresh', stale: false },
    },
  ],
};

describe('parseQuotaAxiWindows (puro, T201)', () => {
  it('extrai as 3 janelas do payload real (five_hour + seven_day + model:fable, com resetsAt)', () => {
    expect(parseQuotaAxiWindows(REAL_PAYLOAD_SHAPE)).toEqual({
      status: 'ok',
      fiveHour: { percentRemaining: 97, resetsAt: '2026-07-24T14:00:00.000Z' },
      sevenDay: { percentRemaining: 100, resetsAt: '2026-07-31T04:00:00.000Z' },
      fable: { percentRemaining: 100, resetsAt: null },
    });
  });

  it('model:fable sem resetsAt no payload -> resetsAt null (tolerado, não é erro)', () => {
    const output: QuotaAxiOutput = {
      providers: [
        {
          provider: 'claude',
          windows: [{ id: 'model:fable', percentRemaining: 48 }],
          state: { stale: false },
        },
      ],
    };
    expect(parseQuotaAxiWindows(output).fable).toEqual({ percentRemaining: 48, resetsAt: null });
  });

  it('janela ausente do payload -> null SÓ naquela janela, status continua ok', () => {
    const output: QuotaAxiOutput = {
      providers: [{ provider: 'claude', windows: [{ id: 'five_hour', percentRemaining: 60 }], state: { stale: false } }],
    };
    expect(parseQuotaAxiWindows(output)).toEqual({
      status: 'ok',
      fiveHour: { percentRemaining: 60, resetsAt: null },
      sevenDay: null,
      fable: null,
    });
  });

  it('REGRA DURA (CA-5): state.stale=true -> unavailable (3 janelas null), mesmo com windows populado', () => {
    const output: QuotaAxiOutput = {
      providers: [
        {
          provider: 'claude',
          windows: [{ id: 'five_hour', percentRemaining: 67 }], // números REAIS de outro perfil, vindos do cache
          state: { status: 'stale', stale: true, error: 'Claude sign-in required' },
        },
      ],
    };
    expect(parseQuotaAxiWindows(output)).toEqual(UNAVAILABLE);
  });

  it('REGRA DURA (CA-5): state.error presente -> unavailable mesmo sem stale=true explícito', () => {
    const output: QuotaAxiOutput = {
      providers: [{ provider: 'claude', windows: [{ id: 'five_hour', percentRemaining: 50 }], state: { error: 'algum erro' } }],
    };
    expect(parseQuotaAxiWindows(output)).toEqual(UNAVAILABLE);
  });

  it('sem provider claude -> unavailable', () => {
    expect(parseQuotaAxiWindows({ providers: [] })).toEqual(UNAVAILABLE);
    expect(parseQuotaAxiWindows(null)).toEqual(UNAVAILABLE);
    expect(parseQuotaAxiWindows(undefined)).toEqual(UNAVAILABLE);
  });

  it('arredonda percentRemaining pro inteiro mais próximo', () => {
    const output: QuotaAxiOutput = { providers: [{ provider: 'claude', windows: [{ id: 'five_hour', percentRemaining: 82.6 }], state: {} }] };
    expect(parseQuotaAxiWindows(output).fiveHour).toEqual({ percentRemaining: 83, resetsAt: null });
  });
});

describe('parseQuotaAxiHeadroom (puro) — seletor derivado sobre parseQuotaAxiWindows', () => {
  it('usa a janela de sessão (five_hour) como headroom principal', () => {
    expect(parseQuotaAxiHeadroom(REAL_PAYLOAD_SHAPE)).toBe(97);
  });

  it('cai pra semanal (seven_day) quando five_hour não vem no payload', () => {
    const output: QuotaAxiOutput = {
      providers: [{ provider: 'claude', windows: [{ id: 'seven_day', percentRemaining: 54 }], state: { stale: false } }],
    };
    expect(parseQuotaAxiHeadroom(output)).toBe(54);
  });

  it('null quando nenhuma janela conhecida vem no payload', () => {
    const output: QuotaAxiOutput = { providers: [{ provider: 'claude', windows: [{ id: 'extra_usage', percentRemaining: 97 }], state: {} }] };
    expect(parseQuotaAxiHeadroom(output)).toBeNull();
  });

  it('null quando não há provider claude no payload', () => {
    expect(parseQuotaAxiHeadroom({ providers: [] })).toBeNull();
    expect(parseQuotaAxiHeadroom(null)).toBeNull();
    expect(parseQuotaAxiHeadroom(undefined)).toBeNull();
  });

  it('REGRA DURA (gotcha desta task): state.stale=true vira null mesmo com windows populado — o cache global do quota-axi pode devolver números de OUTRO perfil', () => {
    const output: QuotaAxiOutput = {
      providers: [
        {
          provider: 'claude',
          windows: [{ id: 'five_hour', percentRemaining: 67 }],
          state: { status: 'stale', stale: true, error: 'Claude sign-in required' },
        },
      ],
    };
    expect(parseQuotaAxiHeadroom(output)).toBeNull();
  });

  it('REGRA DURA: state.error presente vira null mesmo sem stale=true explícito', () => {
    const output: QuotaAxiOutput = {
      providers: [{ provider: 'claude', windows: [{ id: 'five_hour', percentRemaining: 50 }], state: { error: 'algum erro' } }],
    };
    expect(parseQuotaAxiHeadroom(output)).toBeNull();
  });

  it('arredonda pro inteiro mais próximo', () => {
    const output: QuotaAxiOutput = { providers: [{ provider: 'claude', windows: [{ id: 'five_hour', percentRemaining: 82.6 }], state: {} }] };
    expect(parseQuotaAxiHeadroom(output)).toBe(83);
  });
});

describe('HeadroomCache (puro, now() injetável) — T203', () => {
  const okQuota = (percent: number): ProfileQuota => ({
    status: 'ok',
    fiveHour: { percentRemaining: percent, resetsAt: null },
    sevenDay: null,
    fable: null,
  });

  it('devolve undefined pra slug nunca lido', () => {
    const cache = new HeadroomCache(() => 0);
    expect(cache.get('conta-b')).toBeUndefined();
  });

  it('devolve o valor cacheado dentro dos 60s de TTL (FR-012), status ok', () => {
    let now = 0;
    const cache = new HeadroomCache(() => now);
    cache.set('conta-b', okQuota(42));
    now = 59_000;
    expect(cache.get('conta-b')).toEqual(okQuota(42));
  });

  it('expira depois de 60s (undefined de novo)', () => {
    let now = 0;
    const cache = new HeadroomCache(() => now);
    cache.set('conta-b', okQuota(42));
    now = 60_001;
    expect(cache.get('conta-b')).toBeUndefined();
  });

  it('CA-5 (decisão 24/07): unavailable NUNCA é cacheado — get devolve undefined logo após o set', () => {
    const cache = new HeadroomCache(() => 0);
    cache.set('conta-b', UNAVAILABLE);
    expect(cache.get('conta-b')).toBeUndefined();
  });
});

describe('readAllProfilesHeadroom (orquestração, reader fake) — T203', () => {
  const okQuota = (percent: number): ProfileQuota => ({
    status: 'ok',
    fiveHour: { percentRemaining: percent, resetsAt: null },
    sevenDay: null,
    fable: null,
  });

  it('lê os perfis em PARALELO (Promise.all — não serializado)', async () => {
    const cache = new HeadroomCache();
    const callOrder: string[] = [];
    const reader = vi.fn(async ({ configDir }: { configDir: string | undefined }) => {
      callOrder.push(`start:${configDir ?? 'principal'}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      callOrder.push(`end:${configDir ?? 'principal'}`);
      return okQuota(50);
    });

    const result = await readAllProfilesHeadroom(
      [
        { slug: 'principal', configDir: undefined },
        { slug: 'conta-b', configDir: 'C:\\perfil-b' },
      ],
      cache,
      reader,
    );

    expect(result).toEqual({ principal: okQuota(50), 'conta-b': okQuota(50) });
    // Se fosse sequencial, o 2º "start" só apareceria depois do 1º "end".
    expect(callOrder.indexOf('start:conta-b')).toBeLessThan(callOrder.indexOf('end:principal'));
  });

  it('usa o cache quando disponível, sem chamar o reader de novo', async () => {
    const cache = new HeadroomCache();
    cache.set('conta-b', okQuota(77));
    const reader = vi.fn(async () => okQuota(999));

    const result = await readAllProfilesHeadroom([{ slug: 'conta-b', configDir: 'C:\\perfil-b' }], cache, reader);

    expect(result).toEqual({ 'conta-b': okQuota(77) });
    expect(reader).not.toHaveBeenCalled();
  });

  it('um perfil falhando (reader resolve unavailable) não impede os outros de aparecerem com valor', async () => {
    const cache = new HeadroomCache();
    const reader = vi.fn(async ({ configDir }: { configDir: string | undefined }) => (configDir === 'C:\\quebrado' ? UNAVAILABLE : okQuota(88)));

    const result = await readAllProfilesHeadroom(
      [
        { slug: 'ok', configDir: 'C:\\ok' },
        { slug: 'quebrado', configDir: 'C:\\quebrado' },
      ],
      cache,
      reader,
    );

    expect(result).toEqual({ ok: okQuota(88), quebrado: UNAVAILABLE });
  });

  it('force: true ignora o cache.get mas ainda faz cache.set do resultado ok (pré-requisito do botão "Atualizar", T205)', async () => {
    const cache = new HeadroomCache();
    cache.set('conta-b', okQuota(10));
    const reader = vi.fn(async () => okQuota(90));

    const result = await readAllProfilesHeadroom([{ slug: 'conta-b', configDir: 'C:\\perfil-b' }], cache, reader, { force: true });

    expect(result).toEqual({ 'conta-b': okQuota(90) });
    expect(reader).toHaveBeenCalledTimes(1);
    // set aconteceu de verdade: uma leitura subsequente SEM force já pega o valor novo do cache (90), não o antigo (10).
    const cached = cache.get('conta-b');
    expect(cached).toEqual(okQuota(90));
  });
});

describe('readQuotaAxiQuota (I/O, spawn mockado) — fix rodada 4 item 8, parte a + T201/T203', () => {
  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  // `resolveCli: () => null` força o fallback npx nestes testes — mantém a
  // semântica original (spawn via npx) intacta enquanto o resolver de
  // binário é testado separadamente abaixo.
  it('REGRA DURA (achado real, evidência do Alexandre): exit code 255 do quota-axi com JSON válido no stdout ainda retorna o headroom — exit code NUNCA decide sucesso/falha, só o conteúdo', async () => {
    const fake = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fake as never);

    const promise = readQuotaAxiQuota({ configDir: undefined, resolveCli: () => null });

    const payload: QuotaAxiOutput = {
      providers: [
        {
          provider: 'claude',
          windows: [{ id: 'five_hour', percentRemaining: 68 }], // percentUsed 32 no payload real reportado
          state: { status: 'fresh', stale: false },
        },
      ],
    };
    fake.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
    fake.emit('close', 255, null); // exit code real reportado — não documentado pelo quota-axi (SKILL.md só lista 0/1/2)

    const result = await promise;
    expect(result.status).toBe('ok');
    expect(result.fiveHour?.percentRemaining).toBe(68);
  });

  it('exit code 0 mas stdout vazio/não-JSON continua unavailable — validação é pelo CONTEÚDO, não pelo exit code (não é "exit 0 = sempre confia")', async () => {
    const fake = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fake as never);

    const promise = readQuotaAxiQuota({ configDir: undefined, resolveCli: () => null });
    fake.stdout.emit('data', Buffer.from('não é json'));
    fake.emit('close', 0, null);

    await expect(promise).resolves.toEqual(UNAVAILABLE);
  });

  it('exit code 255 com ruído (warning do wrapper npx) antes/depois do JSON — extrai o objeto balanceado em vez de desistir no primeiro JSON.parse', async () => {
    const fake = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fake as never);

    const promise = readQuotaAxiQuota({ configDir: undefined, resolveCli: () => null });
    const payload: QuotaAxiOutput = {
      providers: [{ provider: 'claude', windows: [{ id: 'five_hour', percentRemaining: 41 }], state: { stale: false } }],
    };
    const noisy = `npm warn exec ruído antes\n${JSON.stringify(payload)}\nnpm warn algum aviso depois\n`;
    fake.stdout.emit('data', Buffer.from(noisy));
    fake.emit('close', 255, null);

    const result = await promise;
    expect(result.fiveHour?.percentRemaining).toBe(41);
  });

  it('quando resolveCli retorna um path, spawna nodeExecPath+cliPath (não npx), sem shell:true, com ELECTRON_RUN_AS_NODE=1', async () => {
    const fake = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fake as never);

    const promise = readQuotaAxiQuota({
      configDir: undefined,
      resolveCli: () => 'C:\\fake\\cli.js',
      nodeExecPath: 'C:\\fake\\node.exe',
    });

    const payload: QuotaAxiOutput = {
      providers: [{ provider: 'claude', windows: [{ id: 'five_hour', percentRemaining: 55 }], state: { stale: false } }],
    };
    fake.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
    fake.emit('close', 0, null);
    const result = await promise;
    expect(result.fiveHour?.percentRemaining).toBe(55);

    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[0]).toBe('C:\\fake\\node.exe');
    expect(call[1]).toEqual(['C:\\fake\\cli.js', '--provider', 'claude', '--json']);
    const spawnOptions = call[2] as { shell?: boolean; env?: NodeJS.ProcessEnv };
    expect(spawnOptions.shell).not.toBe(true);
    expect(spawnOptions.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('quando resolveCli retorna null, spawna npx com shell:true (fallback)', async () => {
    const fake = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fake as never);

    const promise = readQuotaAxiQuota({ configDir: undefined, resolveCli: () => null });
    fake.stdout.emit('data', Buffer.from('{}'));
    fake.emit('close', 0, null);
    await promise;

    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[0]).toBe('npx');
    expect(call[1]).toEqual(['-y', 'quota-axi', '--provider', 'claude', '--json']);
    const spawnOptions = call[2] as { shell?: boolean };
    expect(spawnOptions.shell).toBe(true);
  });

  describe('timeout (fake timers)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolve o número quando o child fecha ANTES do timeout', async () => {
      vi.useFakeTimers();
      const fake = new FakeChildProcess();
      vi.mocked(spawn).mockReturnValue(fake as never);

      const promise = readQuotaAxiQuota({ configDir: undefined, resolveCli: () => null, timeoutMs: 8000 });
      const payload: QuotaAxiOutput = {
        providers: [{ provider: 'claude', windows: [{ id: 'five_hour', percentRemaining: 30 }], state: { stale: false } }],
      };
      fake.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
      fake.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.fiveHour?.percentRemaining).toBe(30);
    });

    it('mata o child (kill) e resolve unavailable quando passa do timeout', async () => {
      vi.useFakeTimers();
      const fake = new FakeChildProcess();
      vi.mocked(spawn).mockReturnValue(fake as never);

      const promise = readQuotaAxiQuota({ configDir: undefined, resolveCli: () => null, timeoutMs: 8000 });
      await vi.advanceTimersByTimeAsync(8001);

      await expect(promise).resolves.toEqual(UNAVAILABLE);
      expect(fake.kill).toHaveBeenCalled();
    });
  });
});

describe('readQuotaAxiQuota — seam de teste DONEL_QUOTA_AXI_FIXTURE (T205)', () => {
  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('quando a env aponta pra um arquivo fixture, lê o payload dele e NUNCA spawna processo', async () => {
    const fixturePath = path.join(os.tmpdir(), `donel-quota-fixture-${Date.now()}.json`);
    const payload: QuotaAxiOutput = {
      providers: [
        {
          provider: 'claude',
          windows: [
            { id: 'five_hour', percentRemaining: 97, resetsAt: '2026-07-24T14:00:00.000Z' },
            { id: 'seven_day', percentRemaining: 100, resetsAt: '2026-07-31T04:00:00.000Z' },
          ],
          state: { status: 'fresh', stale: false },
        },
      ],
    };
    writeFileSync(fixturePath, JSON.stringify(payload));

    try {
      const result = await readQuotaAxiQuota({
        configDir: undefined,
        baseEnv: { DONEL_QUOTA_AXI_FIXTURE: fixturePath },
      });

      expect(result.status).toBe('ok');
      expect(result.fiveHour?.percentRemaining).toBe(97);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(fixturePath, { force: true });
    }
  });

  it('fixture apontando pra arquivo inexistente -> unavailable (nunca lança)', async () => {
    const result = await readQuotaAxiQuota({
      configDir: undefined,
      baseEnv: { DONEL_QUOTA_AXI_FIXTURE: 'C:\\caminho\\que\\nao\\existe.json' },
    });
    expect(result).toEqual(UNAVAILABLE);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('resolveQuotaAxiCli (puro, fs mockado)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('acha o quota-axi no cache do npx e monta o path do dist/bin', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      existsSync: (path: string) => {
        const normalized = path.replace(/\\/g, '/');
        if (normalized.endsWith('/npm-cache/_npx')) return true;
        if (normalized.endsWith('/dist/bin/quota-axi.js')) return normalized.includes('/abc123/');
        return false;
      },
      readdirSync: () => ['abc123'],
      statSync: () => ({ mtimeMs: 1000 }),
    }));

    const mod = await import('../src/main/quota-headroom');
    const result = mod.resolveQuotaAxiCli();
    expect(result).toContain('abc123');
    expect(result).toContain('quota-axi.js');
  });

  it('cache do npx vazio/inexistente -> null', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      existsSync: () => false,
      readdirSync: () => [],
      statSync: () => ({ mtimeMs: 0 }),
    }));

    const mod = await import('../src/main/quota-headroom');
    expect(mod.resolveQuotaAxiCli()).toBeNull();
  });
});
