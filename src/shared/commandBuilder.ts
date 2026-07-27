// T006 — CommandBuilder (FR-003, plan.md ponto 3)
//
// `buildClaudeArgs` é uma função pura (sem I/O) que traduz as opções do
// Launcher num argv (`string[]`) para o `claude` CLI. O array resultante é
// consumido diretamente pelo PtyManager via node-pty (ConPTY no Windows), que
// spawna o processo sem passar por um shell — cada elemento do array vira um
// argumento discreto. Por isso os valores (ex.: nome da sessão) NUNCA devem
// ser envolvidos em aspas literais: a notação `-n "<nome>"` na tabela do
// FR-003 e no CA-1 da spec é só uma forma legível de mostrar "flag seguida do
// valor como um token"; aspas de verdade corromperiam o valor recebido pelo
// CLI (o `-n` receberia `"radar"` em vez de `radar`).
//
// Controle não preenchido = flag omitida (o CLI usa o default do usuário).

export type ModelAlias = 'fable' | 'opus' | 'sonnet' | 'haiku';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type PermissionMode =
  | 'manual'
  | 'acceptEdits'
  | 'auto'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

// As três ações "Retomar" / "Fork" / "Continuar última" da tabela FR-003 são
// mutuamente exclusivas (é uma escolha só no Launcher) — modelada como union
// discriminada para tornar estados inválidos irrepresentáveis.
export type SessionContinuation =
  | { readonly type: 'resume'; readonly sessionId: string }
  | { readonly type: 'fork'; readonly sessionId: string }
  | { readonly type: 'continueLast' };

export interface BuildClaudeArgsOptions {
  readonly model?: ModelAlias;
  readonly effort?: EffortLevel;
  readonly permissionMode?: PermissionMode;
  readonly sessionName?: string;
  readonly continuation?: SessionContinuation;
}

export function buildClaudeArgs(opts: BuildClaudeArgsOptions = {}): string[] {
  const args: string[] = [];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.effort) {
    args.push('--effort', opts.effort);
  }

  if (opts.permissionMode) {
    args.push('--permission-mode', opts.permissionMode);
  }

  if (opts.sessionName) {
    // Token único, sem aspas — ver nota de topo do arquivo.
    args.push('-n', opts.sessionName);
  }

  switch (opts.continuation?.type) {
    case 'resume':
      args.push('-r', opts.continuation.sessionId);
      break;
    case 'fork':
      args.push('-r', opts.continuation.sessionId, '--fork-session');
      break;
    case 'continueLast':
      args.push('-c');
      break;
    default:
      break;
  }

  return args;
}

// T011 — Defaults do Brief 3 (design reference), mesmos valores que o
// Launcher.tsx já usa (DEFAULT_MODEL/DEFAULT_EFFORT locais, comentário
// "Defaults do Brief 3: fable/high/acceptEdits") — exportados aqui pra
// SessionDetails (right panel, FR-011) semear o valor inicial de uma sessão
// aberta SEM passar pelo Launcher (ex.: clique direto na sidebar), onde
// `parseModelEffortFromArgs` abaixo não tem nenhuma flag pra ler.
export const DEFAULT_MODEL_ALIAS: ModelAlias = 'fable';
export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'high';

const KNOWN_MODEL_ALIASES: readonly ModelAlias[] = ['fable', 'opus', 'sonnet', 'haiku'];
const KNOWN_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ParsedModelEffort {
  readonly model?: ModelAlias;
  readonly effort?: EffortLevel;
}

/**
 * Inverso de `buildClaudeArgs` pros dois campos que a sessão viva (T011,
 * SessionDetails) precisa mostrar pré-selecionados: lê `--model`/`--effort`
 * de volta de um argv já montado (`TabState.launchArgs`, T008/App.tsx) —
 * puro, sem I/O, mesmo espírito de `buildClaudeArgs`. Flag ausente, sem
 * valor seguinte (argv truncado) ou com valor fora do enum conhecido
 * (argv corrompido ou de uma versão futura do CommandBuilder) é omitida do
 * resultado em vez de propagar um valor inválido pro tipo `ModelAlias`/
 * `EffortLevel` — quem chama decide o fallback (SessionDetails cai pros
 * `DEFAULT_*` acima).
 */
export function parseModelEffortFromArgs(args: readonly string[] | undefined): ParsedModelEffort {
  if (!args || args.length === 0) return {};

  const result: { model?: ModelAlias; effort?: EffortLevel } = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--model') {
      const value = args[i + 1];
      if (value && (KNOWN_MODEL_ALIASES as readonly string[]).includes(value)) {
        result.model = value as ModelAlias;
      }
    } else if (args[i] === '--effort') {
      const value = args[i + 1];
      if (value && (KNOWN_EFFORT_LEVELS as readonly string[]).includes(value)) {
        result.effort = value as EffortLevel;
      }
    }
  }
  return result;
}
