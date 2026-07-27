## Como usar este design system

Donel Dev é o cockpit desktop para operar sessões do Claude Code em paralelo —
dark-first, tema único (não existe modo claro). Este pacote não expõe um
componente `*Provider`/`ThemeProvider` — não há contexto React nenhum para
envolver sua composição. "Setup" aqui é só CSS:

1. Aplique `background: var(--bg-app)` (e, se possível, `color: var(--text-primary)`,
   `font-family: var(--font-ui)`) no elemento raiz da sua composição. **Isso é
   obrigatório, não cosmético**: vários componentes assumem uma tela escura por
   trás deles e ficam ilegíveis num fundo claro —
   texto do variant `Ghost` de `Button`, o ícone/label do variant `secondary`
   de `SplitButton`, texto de `Toggle`/`PostItCard`/`Toast` — todos usam
   `var(--text-primary)`, uma cor clara pensada para contraste sobre `--bg-app`,
   não sobre branco.
2. Os tokens (`tokens.css`) e as fontes self-hosted (Inter 400/600, JetBrains
   Mono 400) já vêm embutidos no bundle — não precisa importar nada à parte;
   só use as custom properties abaixo nos seus próprios elementos de layout
   (containers, espaçamento entre componentes, texto solto).
3. Nenhum componente precisa de wrapper de contexto. `Modal`/`Toast` já
   controlam seu próprio overlay/posicionamento (`position: fixed`) — não os
   envolva em containers com `overflow: hidden` ou `position: relative` que
   cortariam esse posicionamento.

## O vocabulário real de estilização

Este pacote usa **CSS Modules compilados consumindo custom properties
(`var(--token)`)** — não é Tailwind, não é um sistema de utility classes, não
tem escala arbitrária tipo `bg-blue-500`. Toda cor/espaçamento/tipografia vem
de uma destas variáveis (definidas em `tokens.css`, tema único):

**Superfície e texto**: `--bg-app`, `--bg-panel`, `--bg-raised`, `--border`,
`--text-primary`, `--text-muted`, `--accent`.

**Estados de sessão (semáforo)**: `--state-working`, `--state-waiting`,
`--state-permission`, `--state-done`, `--state-error`.

**Smart zone (medidor de contexto, ~400k tokens)**: `--zone-ok`, `--zone-warn`,
`--zone-over`, `--smart-zone-max-tokens`.

**Headroom de conta**: `--headroom-high`, `--headroom-mid`, `--headroom-low`,
`--headroom-none` (aliases dos tokens acima — nunca introduza um hex novo para
headroom).

**Identidade do Donel / post-its**: `--donel-accent`, `--postit-bg`.

**Chips de fase da Esteira**: `--phase-discovery`, `--phase-plano`,
`--phase-implementar`, `--phase-validar`, `--phase-concluir`.

**Tipografia**: `--font-ui` (Inter), `--font-mono` (JetBrains Mono),
`--text-body-size`, `--text-body-line-height`, `--text-caption-size`,
`--text-heading-size`, `--text-mono-size`, `--weight-regular`,
`--weight-semibold`.

**Espaçamento (base 8px)**: `--space-half` (4px), `--space-1` (8px),
`--space-2` (16px), `--space-3` (24px), `--space-4` (32px), `--space-5` (40px).

**Raio, densidade, sombra, foco**: `--radius-sm`, `--radius-md`,
`--control-height`, `--panel-padding`, `--hairline`, `--shadow-modal`,
`--overlay-modal`, `--focus-ring`.

**Nunca hardcode um hex** ao compor uma tela com estes componentes — se uma
cor parece faltar, o token mais próximo da lista acima é a resposta certa, não
um valor novo.

## Fonte da verdade

- `styles.css` / os tokens sincronizados neste projeto refletem `tokens.css`
  do pacote — nenhuma variável foi renomeada ou reinterpretada na conversão.
- A doc de cada componente (`components/<grupo>/<Nome>/<Nome>.prompt.md`) é a
  autoridade sobre props e variantes daquele componente especificamente.

## Composição idiomática (adaptado de uma story verificada — `Modal`)

```tsx
import { useState } from 'react';
import { Button, Modal } from '@donel-dev/design-system';

function CloseSessionConfirmation() {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ background: 'var(--bg-app)', minHeight: '100vh', padding: 'var(--space-4)' }}>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Reabrir modal
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Fechar sessão?"
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button variant="danger" onClick={() => setOpen(false)}>Fechar sessão</Button>
          </>
        }
      >
        O processo será encerrado. Você pode reabrir esta sessão depois pela lista de sessões anteriores.
      </Modal>
    </div>
  );
}
```

Note o container raiz com `background: var(--bg-app)` — sem ele, o texto do
botão secundário e o corpo do modal perdem contraste (ver seção "Como usar"
acima).
