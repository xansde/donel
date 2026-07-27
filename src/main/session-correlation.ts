// T009 — resolve o "correlation id" usado pelo semáforo pra ligar payloads
// de hook (campo `session_id`, 100% presente em todo hook do Claude Code
// per spike) a um `ptyId` do Donel Dev. Mecanismo escolhido no spike:
// `--session-id <uuid>` fixo no spawn, determinístico (não depende de
// variável de ambiente nem de parsing de output).
//
// Se o argv já pede retomada (`-r <id>`, T013/FR-004 — resumir/forkar), o
// `session_id` de todo hook JÁ vai ser esse id retomado, sem precisar de
// `--session-id` extra (evita duplicar/confundir a flag) — este módulo só
// extrai esse id existente pra correlação, em vez de gerar um novo.
//
// Função pura: recebe o argv do CommandBuilder (T006) + um gerador de uuid
// injetado (testável sem depender de `crypto.randomUUID` real), devolve o
// id de correlação e os argumentos extras a anexar no spawn.

export interface ClaudeCorrelation {
  /** Id usado para casar `session_id` dos hooks recebidos com o `ptyId` do Donel Dev. */
  readonly correlationId: string;
  /** Argumentos extra a concatenar no fim do argv do CommandBuilder (T006) — vazio quando o próprio argv já resolve a correlação via `-r`. */
  readonly extraArgs: readonly string[];
}

/** `args` = argv já montado pelo CommandBuilder (buildClaudeArgs, T006/T008), sem os flags do semáforo. */
export function resolveClaudeCorrelation(args: readonly string[], generateId: () => string): ClaudeCorrelation {
  const resumeIndex = args.indexOf('-r');
  const resumeSessionId = resumeIndex !== -1 ? args[resumeIndex + 1] : undefined;

  if (resumeSessionId) {
    return { correlationId: resumeSessionId, extraArgs: [] };
  }

  const correlationId = generateId();
  return { correlationId, extraArgs: ['--session-id', correlationId] };
}
