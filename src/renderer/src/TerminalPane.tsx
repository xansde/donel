import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@donel-dev/design-system';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { IMAGE_PASTE_SEQUENCE, parseClaudeNotFound, resolveTerminalKeyAction } from '../../shared';
import type { PtyExitInfo, SemaphoreStateInfo } from '../../shared';
import { formatRingBufferPreview } from './ringBufferPreview';
import styles from './TerminalPane.module.css';

// T004 deu a base (xterm + PtyManager). T005 liga a aba a uma sessão claude
// de verdade (FR-006, plan.md ponto 1): resolução do executável no main
// process (CA-5 se não achar), estado "sessão encerrada" no corpo do
// terminal quando o processo `claude` sai sozinho (ações Reabrir/Fechar aba,
// ui-spec §2 "Estados da vista"). Abas múltiplas / fechar de verdade na
// barra de abas chegam em T010 — `onCloseTab` ausente = a própria aba mostra
// um estado neutro de "fechada" em vez de fingir remover a aba da barra.

const XTERM_THEME = {
  background: '#0e1116',
  foreground: '#d7dde5',
  cursor: '#4c9cf0',
  cursorAccent: '#0e1116',
  selectionBackground: '#28303b',
};

type PaneStatus =
  | { kind: 'connecting' }
  | { kind: 'running' }
  | { kind: 'ended'; info: PtyExitInfo }
  | { kind: 'claude-not-found'; expectedPath: string }
  | { kind: 'closed' };

export interface TerminalPaneProps {
  /** 'claude' (T005) = sessão claude direta no PTY; 'shell' = terminal livre (FR-008, default T004). */
  sessionType?: 'shell' | 'claude';
  cwd?: string;
  /** Argv do Launcher (T008 — CommandBuilder, FR-003). Fixo por aba: só lido no spawn/reabertura, nunca muda no meio da sessão viva (isso é FR-011, T011). */
  args?: string[];
  /** Ação real de fechar a aba na barra de abas (T010): App.tsx remove a aba do array (unmount cuida do teardown do PTY). */
  onCloseTab?: () => void;
  /**
   * T009 — semáforo de sessões (FR-010). TerminalPane é quem conhece o
   * `ptyId` de verdade (nasce da resposta de `pty.create`, nunca sobe pro
   * App.tsx) — por isso é ele quem assina `semaphore.onUpdate` e "levanta" o
   * estado pro pai (sidebar/tab bar, ui-spec §2/§3) via este callback, em vez
   * do App.tsx tentar re-derivar o ptyId por fora.
   */
  onStateChange?: (info: SemaphoreStateInfo) => void;
  /**
   * T010 — FR-006: "fechar aba com sessão ativa (processo vivo) pede
   * confirmação". App.tsx só sabe se HÁ um processo vivo através deste sinal
   * (funciona tanto para sessão claude quanto para terminal livre — o
   * semáforo, ao contrário, só existe para 'claude'). `true` só quando
   * `status.kind === 'running'`.
   */
  onAliveChange?: (alive: boolean) => void;
  /**
   * FIX (feedback E2E rodada 5) — perfil de NASCIMENTO desta sessão
   * (`PtyCreateResult.profile`, main/index.ts `activeProfileSlug`/`Name` NO
   * MOMENTO da criação — por valor, como `claudeConfigDir` já é, T014).
   * Chamado uma única vez, junto com `ptyIdRef.current = result.ptyId`
   * (mesmo instante que `onAliveChange(true)`/`setStatus('running')`
   * refletem). `undefined` só chega aqui pra sessão 'shell' (branch shell
   * do handler `pty:create` nunca preenche `profile`) — App.tsx decide o
   * que fazer com isso (`sessionAccountLabel.ts`).
   */
  onProfileResolved?: (profile: { slug: string; name: string } | undefined) => void;
  /**
   * T404/T408 (004-nomear-sessoes) — id da sessão do Claude desta aba
   * (`PtyCreateResult.claudeSessionId`, imposto pelo main no spawn via
   * `--session-id`). Mesmo espírito de `onProfileResolved`: o `ptyId` continua
   * não subindo pro App.tsx, mas o id da SESSÃO precisa subir, porque é a
   * chave com que o nome dado na UI é persistido (CA-6). `undefined` só para
   * aba 'shell'.
   */
  onClaudeSessionIdResolved?: (claudeSessionId: string | undefined) => void;
  /**
   * T710 (007/CA-11 2º momento) — o processo desta aba SAIU: código, sinal e
   * quanto tempo passou desde o spawn. Mesmo espírito dos callbacks acima (o
   * `ptyId` continua não subindo pro App.tsx, só o efeito): quem sabe a hora
   * exata do spawn é este componente, então é ele que mede `msSinceSpawn`.
   *
   * Serve para o App.tsx decidir, com `shouldForgetOnResumeFailure`
   * (shared/resumeFailure.ts), se uma aba que nasceu com `-r <id>` morreu
   * porque a sessão não existe mais — a medição do sinal está em
   * `specs/008-fechar-pendencias/medicao-t710.md`. Disparado apenas no
   * `pty.onExit` REAL, nunca na falha de spawn (`claude` não encontrado é outro
   * assunto, e tem estado próprio na vista).
   */
  onProcessExit?: (info: { exitCode: number | undefined; signal: number | undefined; msSinceSpawn: number }) => void;
}

/**
 * T011 (FR-011) — handle imperativo exposto via `ref`: quem chama decide
 * SE deve injetar (gate de estado ocioso, `canInjectLiveCommand` em
 * `shared/liveSessionInjection.ts`, aplicado em App.tsx/SessionDetails);
 * este componente só é "a boca pro stdin", igual ao próprio `term.onData`
 * (teclado real) já é — o `ptyId` continua nunca subindo pro App.tsx
 * (comentário de `onStateChange` acima), só o efeito de escrever nele.
 */
/**
 * Últimas linhas do buffer JÁ RENDERIZADO pelo xterm — generoso o bastante
 * (200, bem mais que uma tela de terminal normal) pra sobreviver a um
 * diálogo interativo do CLI (ex.: "Switch model?") sem perder a linha de
 * confirmação, sem varrer o scrollback inteiro (5000 linhas, `scrollback`
 * abaixo) a cada checagem.
 */
const RENDERED_TAIL_LINES = 200;

export interface TerminalPaneHandle {
  /** Escreve `command` no stdin do PTY desta aba. Devolve `false` (no-op) sem processo vivo — quem chama decide o que fazer com isso (ex.: degradação FR-011 "reiniciar com a flag"). */
  injectCommand: (command: string) => boolean;
  /**
   * T013 (correção herdada) — últimas ~200 linhas do buffer JÁ RENDERIZADO
   * do xterm (`term.buffer.active`). Duas alternativas foram tentadas e
   * DESCARTADAS rodando contra o CLI real (não fixture) antes desta —
   * detalhes em shared/liveSessionInjection.ts: (1) o ring buffer do main
   * process (`window.donel.pty.getPreview`) só fecha linha em `\n`/`\r\n`
   * real; (2) acumular o BYTE STREAM bruto (ANSI stripado) também falhou —
   * o achado foi que um redraw incremental (interface tipo Ink) pode
   * compor o texto final combinando um write NOVO com conteúdo que já
   * estava na grade do terminal, então "Set model to Sonnet 5" nunca
   * aparece como substring contígua no stream bruto, só no resultado JÁ
   * EMULADO pelo parser do xterm. Por isso a fonte tem que ser o buffer
   * renderizado — e pra não perder um frame TRANSIENTE (a confirmação
   * também some rápido, sobrescrita pelo próximo redraw), quem chama isso
   * faz via `onRenderedUpdate` (evento, não poll) logo abaixo, nunca
   * `setInterval`. `[]` sem terminal montado.
   */
  getRenderedLines: () => string[];
  /**
   * T013 (correção herdada) — notifica `listener` toda vez que um chunk de
   * output do PTY terminou de ser processado pelo parser do xterm (usa o
   * callback de conclusão do `term.write`, não um `setInterval` — só assim
   * garante ver um frame TRANSIENTE antes do próximo redraw sobrescrever
   * por cima; ver comentário de `getRenderedLines`). Retorna função de
   * unsubscribe.
   */
  onRenderedUpdate: (listener: () => void) => () => void;
}

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  {
    sessionType = 'shell',
    cwd,
    args,
    onCloseTab,
    onStateChange,
    onAliveChange,
    onProfileResolved,
    onClaudeSessionIdResolved,
    onProcessExit,
  },
  ref
): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const unsubscribeDataRef = useRef<(() => void) | null>(null);
  const unsubscribeExitRef = useRef<(() => void) | null>(null);
  const unsubscribeSemaphoreRef = useRef<(() => void) | null>(null);
  // FIX — geração do mount atual (substitui o antigo `disposedRef` booleano).
  // Incrementado tanto no INÍCIO do efeito de mount quanto no INÍCIO do
  // cleanup — cada `spawnSession()` captura o valor vigente no momento da
  // chamada (`requestEpoch`) e, quando a promise de `pty.create` resolve,
  // compara contra o valor ATUAL do ref: diferente = essa chamada pertence a
  // uma geração já descartada (StrictMode double-invoke em dev, ou unmount
  // real) e o PTY recém-criado é morto sem nunca virar "vivo" pro componente;
  // igual = ainda é a geração corrente, segue o fluxo normal. Um booleano
  // único não distingue "geração 1 descartada" de "geração 2, a atual" depois
  // que as duas já dispararam — as duas ficavam com a mesma flag `true`/
  // `false`, causando ou os dois pty's sendo mortos (bug original) ou os dois
  // sendo mantidos vivos (1 deles órfão, nunca gerenciado — 2 processos
  // `claude.exe` reais por aba em vez de 1). Contador resolve isso porque
  // cada geração tem um valor PRÓPRIO, nunca reutilizado.
  const mountEpochRef = useRef(0);
  // T013 (correção herdada) — assinantes de `onRenderedUpdate`, notificados a
  // cada chunk de PTY já processado pelo parser do xterm (ver comentário do
  // handle acima pro porquê de ser evento, não poll).
  const renderListenersRef = useRef(new Set<() => void>());
  const [status, setStatus] = useState<PaneStatus>({ kind: 'connecting' });

  // Ref pra sempre chamar a versão mais recente do callback sem precisar
  // re-assinar `semaphore.onUpdate` a cada render (o pai passa uma arrow
  // function nova a cada vez — o mesmo problema que `cwd`/`args` já evitam
  // ao serem lidos só no spawn inicial, ver eslint-disable mais abaixo).
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const onAliveChangeRef = useRef(onAliveChange);
  onAliveChangeRef.current = onAliveChange;
  const onProfileResolvedRef = useRef(onProfileResolved);
  onProfileResolvedRef.current = onProfileResolved;
  const onClaudeSessionIdResolvedRef = useRef(onClaudeSessionIdResolved);
  onClaudeSessionIdResolvedRef.current = onClaudeSessionIdResolved;
  const onProcessExitRef = useRef(onProcessExit);
  onProcessExitRef.current = onProcessExit;
  /** T710 — instante em que o PTY desta geração nasceu; base do `msSinceSpawn` levantado no `onExit`. */
  const spawnedAtRef = useRef<number | null>(null);
  // T505 (005-terminal-copy-paste) — atualizada a cada render, mesmo padrão
  // acima: o handler de teclado (T506) é registrado uma vez no mount do
  // `term` (efeito com deps `[]`, ver useEffect abaixo) e sobrevive a
  // re-renders; ler `sessionType` direto do closure congelaria o valor do
  // PRIMEIRO render. A aba não muda de tipo hoje, mas é o mesmo cuidado que
  // `ptyIdRef`/`mountEpochRef` já têm no arquivo.
  const sessionTypeRef = useRef(sessionType);
  sessionTypeRef.current = sessionType;

  // T010 — reporta pro pai sempre que a "vivacidade" do processo muda (não
  // a cada render, só quando `status.kind` de fato transiciona) — é o sinal
  // que o App.tsx usa pra decidir se o "Fechar aba" da barra de abas precisa
  // de confirmação (FR-006). Roda para 'shell' e 'claude' igualmente.
  useEffect(() => {
    onAliveChangeRef.current?.(status.kind === 'running');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.kind]);

  // T011 (FR-011) — `injectCommand` lê `ptyIdRef` no momento da CHAMADA (não
  // captura o valor no momento em que o handle foi criado), por isso não
  // precisa de dependências: mesmo padrão de `term.onData` (linha ~161
  // abaixo), que também lê `ptyIdRef.current` "ao vivo" a cada tecla.
  useImperativeHandle(
    ref,
    () => ({
      injectCommand: (command: string): boolean => {
        if (!ptyIdRef.current) return false;
        window.donel.pty.input(ptyIdRef.current, command);
        return true;
      },
      getRenderedLines: (): string[] => {
        const term = termRef.current;
        if (!term) return [];
        const buffer = term.buffer.active;
        const start = Math.max(0, buffer.length - RENDERED_TAIL_LINES);
        const lines: string[] = [];
        for (let i = start; i < buffer.length; i += 1) {
          const line = buffer.getLine(i);
          if (line) lines.push(line.translateToString(true));
        }
        return lines;
      },
      onRenderedUpdate: (listener: () => void): (() => void) => {
        renderListenersRef.current.add(listener);
        return () => {
          renderListenersRef.current.delete(listener);
        };
      },
    }),
    []
  );

  const teardownPty = useCallback(() => {
    unsubscribeDataRef.current?.();
    unsubscribeExitRef.current?.();
    unsubscribeSemaphoreRef.current?.();
    unsubscribeDataRef.current = null;
    unsubscribeExitRef.current = null;
    unsubscribeSemaphoreRef.current = null;
    if (ptyIdRef.current) {
      window.donel.pty.kill(ptyIdRef.current);
      ptyIdRef.current = null;
    }
  }, []);

  const spawnSession = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    setStatus({ kind: 'connecting' });
    // Snapshot da geração vigente NO MOMENTO da chamada — não lido de novo
    // depois (ver comentário de `mountEpochRef` acima).
    const requestEpoch = mountEpochRef.current;

    void window.donel.pty
      .create({ cols: term.cols, rows: term.rows, cwd, sessionType, args })
      .then((result) => {
        if (requestEpoch !== mountEpochRef.current) {
          // Geração já descartada (StrictMode double-invoke em dev, ou a aba
          // foi desmontada de verdade antes da promise resolver) — mata o
          // PTY recém-criado sem nunca setar status:'running' nem assinar
          // onData/onExit/semaphore (ninguém vai ler essas assinaturas).
          window.donel.pty.kill(result.ptyId);
          return;
        }
        ptyIdRef.current = result.ptyId;
        spawnedAtRef.current = Date.now(); // T710 — base do msSinceSpawn (ver onExit abaixo)
        setStatus({ kind: 'running' });
        // FIX (feedback E2E rodada 5) — perfil de nascimento desta sessão
        // (undefined pra 'shell', ver comentário do prop). Levantado uma
        // única vez, no mesmo instante que `onAliveChange(true)` reflete
        // (efeito de `status.kind` acima) — App.tsx grava por tab.id, nunca
        // reconsultado depois (mesmo espírito "por valor" de `claudeConfigDir`).
        onProfileResolvedRef.current?.(result.profile);
        // T404 (004) — id da sessão do Claude desta aba, no mesmo instante e pelo
        // mesmo motivo do perfil acima: é a chave de persistência do nome (CA-6).
        onClaudeSessionIdResolvedRef.current?.(result.claudeSessionId);

        // FIX (feedback E2E rodada 1, agravante do bug StrictMode) — replay
        // do ring buffer ANTES de assinar `onData` (ver comentário de topo
        // de ringBufferPreview.ts pro porquê do race: `ptyManager.create()`
        // spawna e começa a alimentar o ring buffer sincronamente no main,
        // antes do roundtrip do IPC chegar até aqui). `void` — best-effort,
        // nunca bloqueia a aba: se `pty:preview` falhar, cai pro comportamento
        // de antes (só o onData daqui pra frente), sem preview nenhum.
        void window.donel.pty
          .getPreview(result.ptyId)
          .catch((): string[] => [])
          .then((lines) => {
            // A geração pode ter sido invalidada ENQUANTO o preview estava
            // em voo (StrictMode / unmount real) — mesma checagem de
            // `requestEpoch` do `.then()` de fora; sem ela escreveria num
            // xterm já `dispose()`d.
            if (requestEpoch !== mountEpochRef.current) return;

            // FIX (decisão A, 2026-07-23) — auto-aceite REMOVIDO (ver
            // dossiê da rodada 5/CLAUDE.md): a única aba que rodava em
            // `os.homedir()` sem trust persistido era a antiga aba boot
            // (INITIAL_TABS, App.tsx), que deixou de existir — o app nunca
            // mais spawna `claude` sozinho sem o usuário escolher um
            // projeto/lançar uma sessão. Se um diálogo de confiança de
            // pasta aparecer (ex.: primeira vez que uma pasta é aberta por
            // uma sessão claude), quem resolve é o usuário, direto no
            // terminal — `shared/trustDialog.ts` continua detectando a
            // assinatura completa do diálogo só pra alimentar o aviso
            // diagnóstico da toolbar (App.tsx `possiblyBlockedOnPrompt`),
            // nunca mais pra enviar Enter sozinho.
            //
            // FIX (feedback E2E rodada 1, agravante do bug StrictMode) — o
            // replay do ring buffer aqui só cuida de MOSTRAR pro usuário o
            // que já rodou antes de `onData` ser assinado (ver comentário de
            // topo de ringBufferPreview.ts).
            const preview = formatRingBufferPreview(lines);
            if (preview) term.write(preview);

            unsubscribeDataRef.current = window.donel.pty.onData(result.ptyId, (data) => {
              // T013 (correção herdada) — o 2º argumento de `write` é o
              // callback de CONCLUSÃO do parser (documentado no xterm.js):
              // só dispara `onRenderedUpdate` depois que ESTE chunk já
              // virou estado real do buffer (`term.buffer.active`), nunca
              // antes — é o que garante ver um frame de confirmação
              // transiente ANTES do próximo redraw sobrescrever por cima
              // (ver comentário do handle acima).
              term.write(data, () => {
                renderListenersRef.current.forEach((listener) => listener());
              });
            });
          });

        unsubscribeExitRef.current = window.donel.pty.onExit(result.ptyId, (info) => {
          ptyIdRef.current = null;
          setStatus({ kind: 'ended', info });
          // T710 — levanta o exit pro pai junto do tempo desde o spawn (só este
          // componente sabe a hora do spawn). O pai é quem decide o que fazer:
          // aba que nasceu com `-r <id>` e morre com código != 0 aqui é
          // candidata a "a sessão não existe mais" (CA-11).
          onProcessExitRef.current?.({
            exitCode: info.exitCode,
            signal: info.signal,
            msSinceSpawn: spawnedAtRef.current === null ? Number.POSITIVE_INFINITY : Date.now() - spawnedAtRef.current,
          });
        });
        // Sessão de terminal livre (FR-008) nunca é registrada no semáforo
        // pelo main process — sem sessionType 'claude', simplesmente não
        // chega update nenhum aqui (nada a filtrar deste lado).
        unsubscribeSemaphoreRef.current = window.donel.semaphore.onUpdate(result.ptyId, (info) => {
          onStateChangeRef.current?.(info);
        });
      })
      .catch((error: unknown) => {
        if (requestEpoch !== mountEpochRef.current) return;
        const expectedPath = parseClaudeNotFound(error);
        if (expectedPath) {
          setStatus({ kind: 'claude-not-found', expectedPath });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        term.write(`\r\n\x1b[31mFalha ao iniciar o terminal: ${message}\x1b[0m\r\n`);
        setStatus({ kind: 'ended', info: { exitCode: -1 } });
      });
  }, [cwd, sessionType, args]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    // FIX — React 18 <StrictMode> (main.tsx) double-invoca este efeito em dev
    // (mount -> cleanup -> mount) pra achar efeitos impuros. Cada mount é uma
    // geração NOVA (ver comentário de `mountEpochRef` acima) — sem isso, o
    // segundo mount herdava o sinal "descartado" do cleanup do primeiro (ou,
    // com um reset ingênuo pra um único boolean, os dois mounts ficavam
    // indistinguíveis um do outro depois de resolver). A aba ficava presa em
    // 'connecting' pra sempre (terminal vazio, digitação sem efeito, toolbar
    // mostrando "Sessão sem processo vivo") — ou, com o reset ingênuo, dois
    // processos `claude.exe` reais nasciam por aba e só um ficava gerenciado
    // (o outro, órfão, seguia vivo escrevendo no mesmo xterm).
    mountEpochRef.current += 1;

    const term = new XTerm({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12.5,
      theme: XTERM_THEME,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    termRef.current = term;

    // T506/T507 (005-terminal-copy-paste, plan.md Fatia 3) — decisor de
    // Ctrl+C/Ctrl+V por tipo de aba, registrado ANTES da tradução tecla->bytes
    // do xterm (é o único gancho cujo `false` cancela o `onData` abaixo,
    // impedindo o `\x03` de nascer — CA-1/CA-2). `term.onData` continua o
    // ÚNICO caminho de saída pro PTY (decisão técnica 2 do plan.md): este
    // handler nunca escreve no PTY como alternativa a ele, só decide se ele
    // roda ('passthrough', devolve true) ou não (devolve false + ação própria).
    //
    // Registrado no `term` DESTE mount (StrictMode/`mountEpochRef`, comentário
    // acima) — morre junto com `term.dispose()` no cleanup, sem desregistro
    // próprio.
    term.attachCustomKeyEventHandler((event): boolean => {
      const action = resolveTerminalKeyAction(event, {
        sessionType: sessionTypeRef.current,
        hasSelection: term.hasSelection(),
        // `hasImage()` é IPC assíncrono; este handler é SÍNCRONO (contrato do
        // xterm). Aqui só decidimos copySelection/noop/passthrough — nenhum
        // deles depende de saber se há imagem. Ctrl+V (candidato a colagem)
        // sempre cai em 'pasteText' com este `false` fixo (nunca 'pasteImage'
        // sem saber de verdade); a dança async da imagem é feita NO PRÓPRIO
        // branch abaixo, sem reconsultar `resolveTerminalKeyAction`.
        clipboardHasImage: false,
      });

      if (action.kind === 'passthrough') return true;
      if (action.kind === 'noop') return false; // C1/CA-2 — Ctrl+C sem seleção em aba claude: nunca `\x03`.

      if (action.kind === 'copySelection') {
        void window.donel.clipboard.writeText(term.getSelection());
        return false;
      }

      // T507 — só resta 'pasteText', que aqui significa "Ctrl+V, candidato a
      // colagem" (o `clipboardHasImage: false` acima nunca deixa
      // `resolveTerminalKeyAction` devolver 'pasteImage'). Padrão do plan.md
      // (Fatia 2, "padrão adotado"): cancela JÁ (`return false`, abaixo) e
      // resolve ASYNC qual colagem fazer. Em aba claude as duas saídas
      // (imagem/texto) são sempre ações nossas. Em aba shell, colar imagem é
      // fora de escopo (US-C só claude) — o único caso não coberto por esta
      // dança é "Ctrl+V com imagem no clipboard em aba shell": como
      // `readText()` de um clipboard só-com-imagem devolve string vazia, o
      // efeito observável (nada é escrito) já é equivalente ao passthrough
      // que a tabela pediria — não há como "deixar passar cru" depois de já
      // ter cancelado o keydown (contrato síncrono do xterm).
      const isClaudeTab = sessionTypeRef.current === 'claude';

      void window.donel.clipboard
        .hasImage()
        .then((hasImg) => {
          if (hasImg && isClaudeTab) {
            // CA-4/CA-4b — só a tecla, nada mais: sem arquivo temp, sem
            // base64, sem spinner nosso (o `Pasting…`/`[Image #N]` são
            // desenhados pelo próprio CLI). Sequência provada no SPIKE-1.
            if (ptyIdRef.current) window.donel.pty.input(ptyIdRef.current, IMAGE_PASTE_SEQUENCE);
            return undefined;
          }

          return window.donel.clipboard.readText().then((text) => {
            if (!text) return; // Texto vazio -> não escreve nada (nenhum byte espúrio).
            const normalized = text.replace(/\r\n/g, '\r');
            // CA-3 — bracketed paste só em aba claude (o CLI liga `\x1b[?2004h`
            // no boot); em aba shell o PowerShell não pede isso, escreve cru.
            const payload = isClaudeTab ? `\x1b[200~${normalized}\x1b[201~` : normalized;
            if (ptyIdRef.current) window.donel.pty.input(ptyIdRef.current, payload);
          });
        })
        .catch((error: unknown) => {
          // Regra dura (spec.md) — clipboard indisponível NUNCA derruba a
          // digitação; engolido aqui, nunca vira unhandled rejection.
          // eslint-disable-next-line no-console
          console.error('[donel-dev] falha ao colar do clipboard:', error);
        });

      return false;
    });

    term.onData((data) => {
      if (ptyIdRef.current) window.donel.pty.input(ptyIdRef.current, data);
    });

    spawnSession();

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (ptyIdRef.current) window.donel.pty.resize(ptyIdRef.current, term.cols, term.rows);
    });
    resizeObserver.observe(container);

    return () => {
      // Fecha esta geração — qualquer `pty.create` ainda pendente desta
      // geração vai ser reconhecido como stale quando resolver (ver
      // `mountEpochRef`/`spawnSession` acima), mesmo que um próximo mount
      // (StrictMode) ainda não tenha rodado pra abrir a geração seguinte.
      mountEpochRef.current += 1;
      resizeObserver.disconnect();
      teardownPty();
      term.dispose();
      termRef.current = null;
    };
    // `spawnSession`/`teardownPty` são estáveis por sessão (mount único); recriar a
    // sessão em si é feito via `handleReopen`, não por dependência de efeito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReopen = useCallback(() => {
    // Nova tentativa = nova geração (mesmo raciocínio do mount effect acima)
    // — invalida qualquer `pty.create` velho ainda pendente desta aba.
    mountEpochRef.current += 1;
    termRef.current?.clear();
    spawnSession();
  }, [spawnSession]);

  const handleCloseTab = useCallback(() => {
    teardownPty();
    if (onCloseTab) {
      onCloseTab();
      return;
    }
    setStatus({ kind: 'closed' });
  }, [onCloseTab, teardownPty]);

  return (
    <div className={styles.wrapper}>
      <div ref={containerRef} className={styles.container} data-testid="terminal-pane" />

      {status.kind === 'claude-not-found' ? (
        <div className={styles.overlay} data-testid="claude-not-found-banner">
          <div className={styles.banner}>
            <p className={styles.bannerTitle}>⚠ Claude Code não encontrado</p>
            <p className={styles.bannerText}>
              Não achamos o <code>claude</code> no PATH nem em{' '}
              <code className={styles.bannerPath}>{status.expectedPath}</code>.
            </p>
            <p className={styles.bannerHint}>Instale o Claude Code CLI ou adicione-o ao PATH e tente novamente.</p>
            <div className={styles.overlayActions}>
              <Button variant="primary" onClick={handleReopen}>
                Tentar novamente
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {status.kind === 'ended' ? (
        <div className={styles.overlay} data-testid="session-ended-overlay">
          <div className={styles.banner}>
            <p className={styles.bannerTitle}>Sessão encerrada</p>
            <p className={styles.bannerText}>
              O processo saiu{status.info.exitCode !== undefined ? ` (código ${status.info.exitCode})` : ''}.
            </p>
            <div className={styles.overlayActions}>
              <Button variant="primary" onClick={handleReopen}>
                Reabrir
              </Button>
              <Button variant="secondary" onClick={handleCloseTab}>
                Fechar aba
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {status.kind === 'closed' ? (
        <div className={styles.overlay} data-testid="tab-closed-placeholder">
          <div className={styles.banner}>
            <p className={styles.bannerText}>Aba fechada.</p>
            <div className={styles.overlayActions}>
              <Button variant="primary" onClick={handleReopen}>
                Nova sessão
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
