import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './global.css';
import '@donel-dev/design-system';
// T010 (achado ao testar o dropdown do "＋ Nova sessão") — o import acima
// carrega só o JS. `design-system/package.json` builda tokens.css/fontes num
// `dist/style.css` SEPARADO (vite library mode não inlina CSS no bundle JS);
// sem este import explícito, `--sidebar-width`/`--right-panel-width`/
// `--accent`/etc. nunca existem no documento — `grid-template-columns: var(--sidebar-width) 1fr var(--right-panel-width)`
// (App.module.css `.body`) vira inválido e colapsa pra 1 coluna só, empilhando
// sidebar/centro/painel direito no mesmo espaço (bug pré-existente desde o
// T003/T007, nunca pego pelos smokes anteriores porque nenhum clicava em algo
// cuja hit-area dependesse da largura real das colunas — o dropdown do
// SplitButton foi o primeiro a esbarrar nisso, T010).
import '@donel-dev/design-system/style.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
