import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Sem `build.rollupOptions.input` explícito: electron-vite resolve por
// convenção `src/main/index.ts`, `src/preload/index.ts` e
// `src/renderer/index.html` — exatamente a estrutura alvo do plan.md
// ("Estrutura do repositório"). Especificar rollupOptions aqui quebra o
// typecheck com electron-vite 5.0.0 + vite 5.x (tipos do pacote assumem a
// Environment API do vite 6+; a build em si roda igual, só o `tsc --noEmit`
// falha) — e usar vite 6/7 no app quebraria o build do `design-system`
// (Storybook 8 fixa vite ^3–^6 e o workspace deixaria de compartilhar uma
// única instalação de vite, gerando dois tipos `Plugin` incompatíveis).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
  },
});
