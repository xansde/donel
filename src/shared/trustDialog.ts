// FIX (auditoria rodada 5, achados alta/media do Fix 1 — TerminalPane.tsx) —
// função pura extraída de `TerminalPane.tsx` pra ser testável em isolamento
// (TDD com escopo — bugfix de produção; a auditoria apontou que TODA a
// lógica do Fix 1 vivia inline em `spawnSession`, sem cobertura além de um
// smoke Playwright caro que, além disso, estava falhando).
//
// CAUSA RAIZ do achado alta original: o match usava só a string 'trust this
// folder' (primeira linha pintada do diálogo), que aparece ANTES do CLI
// terminar de desenhar e armar o leitor de stdin — um `\r` disparado nesse
// instante é engolido. Exigir as DUAS linhas do RODAPÉ interativo
// ('Enter to confirm' + '2. No, exit') garante que o diálogo já está
// totalmente pintado e pronto pra receber input, e — efeito colateral
// desejado (achado media "janela sem SessionStart") — é uma assinatura
// praticamente impossível de aparecer por acidente num prompt digitado pelo
// usuário ou citado numa resposta do modelo.

/** Linha do rodapé interativo do diálogo "Quick safety check" do CLI — só aparece quando ele já terminou de desenhar. */
export const TRUST_DIALOG_CONFIRM_MARKER = 'Enter to confirm';
/** Segunda linha de opção do mesmo diálogo — combinada com `TRUST_DIALOG_CONFIRM_MARKER` torna a assinatura não-digitável por acidente. */
export const TRUST_DIALOG_EXIT_MARKER = '2. No, exit';

/**
 * `true` só quando AMBAS as marcações do rodapé do diálogo aparecem entre as
 * linhas fornecidas (tipicamente a cauda já renderizada do buffer do xterm —
 * ver `TerminalPane.getRenderedLines`). Pura, sem I/O — mesma linha já
 * renderizada pode aparecer em qualquer ordem/posição, por isso varre tudo
 * em vez de checar só a última linha.
 */
export function isTrustDialogVisible(lines: readonly string[]): boolean {
  let confirmSeen = false;
  let exitSeen = false;
  for (const line of lines) {
    if (line.includes(TRUST_DIALOG_CONFIRM_MARKER)) confirmSeen = true;
    if (line.includes(TRUST_DIALOG_EXIT_MARKER)) exitSeen = true;
    if (confirmSeen && exitSeen) return true;
  }
  return false;
}
