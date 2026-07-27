# Donel Dev — Design System

Pacote standalone de componentes React/TypeScript do cockpit desktop **Donel
Dev**. Construído a partir de `../design/design-system.md` (fonte de
verdade das decisões visuais) e `../design/design-handoff.md` (briefs de
tela que orientam os dados de exemplo usados nas stories).

Este pacote não depende do app Electron do Donel Dev — é uma biblioteca de
componentes isolada, pensada para alimentar o Storybook e, futuramente, a
skill `/design-sync`.

## Rodando

```bash
npm install
npm run storybook   # Storybook em http://localhost:6006
npm run build        # build de biblioteca (dist/) via Vite
```

Scripts disponíveis:

| Script | O que faz |
|---|---|
| `npm run storybook` / `npm run dev` | Sobe o Storybook em modo dev (porta 6006) |
| `npm run build-storybook` | Build estático do Storybook (`storybook-static/`) |
| `npm run build` | Checagem de tipos (`tsc --noEmit`) + build da biblioteca (ESM, CJS, `.d.ts`, `style.css`) em `dist/` |
| `npm run typecheck` | Só a checagem de tipos, sem build |

## Estrutura

```
design-system/
├── .storybook/            # config do Storybook 8 (builder Vite)
├── src/
│   ├── tokens.css          # TODOS os design tokens (cor, tipografia, espaçamento, motion)
│   ├── lib/
│   │   └── smartZone.ts    # regras compartilhadas da smart zone (faixas, formatação)
│   ├── components/
│   │   └── <Nome>/
│   │       ├── <Nome>.tsx
│   │       ├── <Nome>.module.css
│   │       ├── <Nome>.stories.tsx
│   │       └── index.ts
│   └── index.ts             # entrypoint público do pacote
└── dist/                    # gerado por `npm run build` (não versionado)
```

## Componentes

| Componente | Uso principal |
|---|---|
| `StateDot` | Dot de 8px do semáforo de sessão (5 estados) — o vocabulário central do produto |
| `SmartZoneMeter` | Medidor de contexto consumido (~400k tokens), variantes `default`/`compact` |
| `AccountBadge` | Pílula "Tecnologia Claude {n}" + headroom colorido |
| `PhaseChip` | Chip de fase da Esteira (modo Dev) |
| `Button` / `SplitButton` | Botão base (4 variantes) e botão split ("＋ Nova sessão") |
| `TextInput` | Input de texto livre |
| `Select` | Dropdown customizado com descrição por opção (campo Permissões) |
| `Toggle` | Switch simples |
| `SegmentedControl` | Grupo de opções exclusivas (Modelo, Esforço, Tipo, modo do app) |
| `TerminalTab` | Aba de terminal do shell (com variante "terminal comum") |
| `PostItCard` | Carta do Tomo do Donel (post-it) |
| `Modal` | Modal central com foco preso e Escape para fechar |
| `Toast` | Notificação de canto inferior direito, auto-dismiss |
| `StatusBar` | Rodapé do shell (conta, modelo/esforço, sessões, mini smart zone) |

Todos os componentes são importados do entrypoint único:

```tsx
import { StateDot, Button, SmartZoneMeter } from '@donel-dev/design-system';
// carrega tokens.css e as fontes self-hosted como efeito colateral do import
```

## Tokens e regras de estilo

- **Fonte de verdade**: `src/tokens.css` cobre integralmente as seções 2–4 e
  7 do `design-system.md` (superfícies/texto, estados do semáforo, smart
  zone, headroom, espaçamento 8px, radius 6/8px, tipografia, motion).
- **Nunca hardcode hex nos componentes** — todo componente consome
  `var(--token)`. Os `*.module.css` são a única camada de estilo.
- **Fontes self-hosted**: `@fontsource/inter` (400/600) e
  `@fontsource/jetbrains-mono` (400), sem CDN.
- **Ícones**: `lucide-react`, outline, 16px, stroke 1.5 (20px só em empty
  states, conforme design-system.md §5).
- **Tema único**: dark-first, sem toggle de tema (design-system.md §1.4).
- **Motion**: `--duration-micro` (120ms), `--duration-panel` (200ms),
  `--ease-standard`; toda animação respeita `prefers-reduced-motion`.

## Decisões de interpretação

Alguns pontos do design-system.md são deliberadamente abertos
("interpretação", "o ui-spec não fixa..."). Este pacote resolveu:

- **Paleta das 5 fases da Esteira (`PhaseChip`)** — 5 tons dessaturados,
  espaçados no círculo cromático e escolhidos para não colidir com os hues
  já usados pelos estados do semáforo/smart zone. Ver comentário em
  `src/tokens.css` na seção "Chips de fase da Esteira".
- **Ícone da aba "terminal comum" (`TerminalTab`)** — `Terminal` do
  lucide-react (ícone de shell estável entre versões da lib).
- **Tokens de headroom de conta** — reaproveitam as cores já definidas
  (`zone-ok`, `state-waiting`, `state-permission`, `text-muted`) em vez de
  introduzir hexes novos, já que a regra de cor (verde/dourado/vermelho/
  cinza) é idêntica à das outras faixas do sistema.
